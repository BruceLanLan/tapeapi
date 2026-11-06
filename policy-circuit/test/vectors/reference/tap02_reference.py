"""Reference implementation for the TAP draft "Circuit Netlist Format and Evaluation Semantics".

MIT licence. Pure Python 3.9+, no dependencies. Decoder, encoder, well-formedness check,
one-beat evaluator and bit packing, exactly as the Specification states them.
"""
from __future__ import annotations

from dataclasses import dataclass, field

NAND, LATCH, REF = 0x00, 0x01, 0x02
MAX_SIGNALS = 1 << 24
MAX_PINS = 1 << 16
MAX_GATES = (1 << 32) - 1


class IllFormed(ValueError):
    pass


@dataclass
class Element:
    op: int
    ins: list[int]                      # NAND: [a, b]; LATCH: [d]; REF: ins
    cpu: bytes = b""                    # REF only, 20 bytes
    cid: int = 0                        # REF only, circuit id
    n_out: int = 1
    first_out: int = 0                  # index of the first signal this element produces


@dataclass
class Circuit:
    n_in: int
    n_out: int
    elements: list[Element]
    n_signals: int = 0
    subs: dict = field(default_factory=dict)   # (cpu, cid) -> Circuit, for REF
    n_state: int = 0
    n_gates: int = 0
    state_base: list[int] = field(default_factory=list)


def decode(data: bytes, n_in: int) -> list[Element]:
    p, nxt, els = 0, 2 + n_in, []

    def take(k: int) -> bytes:
        nonlocal p
        if p + k > len(data):
            raise IllFormed(f"truncated record at byte {p}")
        b = data[p:p + k]
        p += k
        return b

    u24 = lambda: int.from_bytes(take(3), "big")  # noqa: E731
    while p < len(data):
        op = take(1)[0]
        if op == NAND:
            e = Element(NAND, [u24(), u24()])
        elif op == LATCH:
            e = Element(LATCH, [u24()])
        elif op == REF:
            cpu = take(20)
            cid = int.from_bytes(take(8), "big")
            ni, no = take(1)[0], take(1)[0]
            e = Element(REF, [u24() for _ in range(ni)], cpu, cid, no)
        else:
            raise IllFormed(f"unknown opcode 0x{op:02x} at byte {p - 1}")
        e.first_out = nxt
        nxt += e.n_out
        els.append(e)
    return els


def encode(els: list[Element]) -> bytes:
    out = bytearray()
    for e in els:
        out.append(e.op)
        if e.op == REF:
            out += e.cpu + e.cid.to_bytes(8, "big") + bytes([len(e.ins), e.n_out])
        for s in e.ins:
            out += s.to_bytes(3, "big")
    return bytes(out)


def load(data: bytes, n_in: int, n_out: int, resolve=None) -> Circuit:
    """Decode and check well-formedness (Specification §3). resolve(cpu, cid) -> Circuit."""
    els = decode(data, n_in)
    n_sig = 2 + n_in + sum(e.n_out for e in els)
    if n_sig > MAX_SIGNALS:
        raise IllFormed("more than 2^24 signals")
    if not (0 <= n_in <= MAX_PINS and 1 <= n_out <= MAX_PINS):
        raise IllFormed("nIn/nOut out of range")
    if n_sig - 2 - n_in < n_out:
        raise IllFormed("too few signals for outputs")
    c = Circuit(n_in, n_out, els, n_sig)
    for e in els:
        for s in e.ins:
            limit = n_sig if e.op == LATCH else e.first_out
            if s >= limit:
                raise IllFormed(f"signal {s} referenced by element at {e.first_out} is not available")
        c.state_base.append(c.n_state)
        if e.op == LATCH:
            c.n_state += 1
        elif e.op == REF:
            if resolve is None:
                raise IllFormed("REF without a resolver")
            sub = resolve(e.cpu, e.cid)
            if sub is None:
                raise IllFormed("REF target is not a circuit of a registered processor")
            if (sub.n_in, sub.n_out) != (len(e.ins), e.n_out):
                raise IllFormed("REF arity does not match the target circuit")
            if sub.n_state > MAX_SIGNALS:
                raise IllFormed("REF size")
            c.subs[(e.cpu, e.cid)] = sub
            c.n_state += sub.n_state
            c.n_gates += sub.n_gates
    c.n_gates += sum(1 for e in els if e.op != REF)
    if c.n_state > MAX_SIGNALS or c.n_gates > MAX_GATES:
        raise IllFormed("size overflow")
    return c


def beat(c: Circuit, state: list[int], inputs: list[int]) -> tuple[list[int], list[int]]:
    """One beat (Specification §4). Returns (new_state, outputs)."""
    assert len(state) == c.n_state and len(inputs) == c.n_in
    a = [0, 1] + list(inputs)
    new_state = list(state)
    for e, base in zip(c.elements, c.state_base):
        if e.op == NAND:
            a.append(1 - (a[e.ins[0]] & a[e.ins[1]]))
        elif e.op == LATCH:
            a.append(state[base])
        else:
            sub = c.subs[(e.cpu, e.cid)]
            ns, outs = beat(sub, state[base:base + sub.n_state], [a[s] for s in e.ins])
            new_state[base:base + sub.n_state] = ns
            a.extend(outs)
    for e, base in zip(c.elements, c.state_base):
        if e.op == LATCH:
            new_state[base] = a[e.ins[0]]
    return new_state, a[len(a) - c.n_out:]


def pack(bits: list[int]) -> bytes:
    out = bytearray((len(bits) + 7) // 8)
    for i, v in enumerate(bits):
        if v:
            out[i >> 3] |= 1 << (i & 7)
    return bytes(out)


def unpack(data: bytes, n: int) -> list[int]:
    """As the deployed evaluator reads inputs and state: missing bytes read as 0; extra bytes and bits are ignored."""
    return [(data[i >> 3] >> (i & 7)) & 1 if (i >> 3) < len(data) else 0 for i in range(n)]
