"""Reference implementation for the TAP draft "Netlist-Bound NFTs".

MIT licence. Pure Python 3.9+, no dependencies besides the TAP-02 reference
implementation next to this file (tap02_reference.py, MIT, copied unchanged from
TAPs assets/tap-02/reference.py).

Contents, in the order of the Specification:
  §2  netlist files (.tapnet): encode, decode, check, metrics, netlist hash
  §3  source circuits: building the expected file from on-chain netlist bytes
  §5  manifests and pools: leaf hashes, Merkle roots and proofs, manifest check
  §6  reveal: seeds and the keyed permutation (4-round Feistel with cycle walking)
  §7  metadata: checking the `tap` object of a token's metadata
"""
from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass

import tap02_reference as tap02

# ---------------------------------------------------------------- §2 netlist files

MAGIC = b"TAPNET"
VERSION = 1
HEADER_LEN = 16
FORMAT_ID = "tapnet/1"


class Invalid(ValueError):
    """Raised for any input this TAP says MUST be rejected."""


class Unverifiable(Exception):
    """Raised when a token's netlist is in a format defined under §2.5 that this tool does not support.

    Not a subclass of Invalid: §2.5 requires such a netlist to be displayed as unverifiable, not as invalid.
    """


@dataclass(frozen=True)
class Metrics:
    n_in: int
    n_out: int
    nand: int
    latch: int

    @property
    def gates(self) -> int:
        return self.nand + self.latch

    def as_json(self) -> dict:
        return {"nIn": self.n_in, "nOut": self.n_out, "nand": self.nand, "latch": self.latch}


def sha256(b: bytes) -> bytes:
    return hashlib.sha256(b).digest()


def hex32(b: bytes) -> str:
    return "0x" + b.hex()


def _encode_unchecked(records: bytes, n_in: int, n_out: int) -> bytes:
    """Wrap TAP-02 record bytes in a .tapnet file without checking them (for invalid test samples)."""
    return MAGIC + bytes([VERSION, 0]) + n_in.to_bytes(4, "big") + n_out.to_bytes(4, "big") + records


def encode_file(records: bytes, n_in: int, n_out: int) -> bytes:
    """Wrap TAP-02 record bytes in a .tapnet file. Raises Invalid unless the file passes check_file (§2.2)."""
    data = _encode_unchecked(records, n_in, n_out)
    check_file(data)
    return data


def decode_file(data: bytes) -> tuple[int, int, bytes]:
    """Parse the header. Returns (nIn, nOut, records). Checks the header only."""
    if len(data) < HEADER_LEN:
        raise Invalid("file shorter than the 16-byte header")
    if data[:6] != MAGIC:
        raise Invalid("bad magic")
    if data[6] != VERSION:
        raise Invalid(f"unsupported version {data[6]}")
    if data[7] != 0:
        raise Invalid("reserved byte is not zero")
    n_in = int.from_bytes(data[8:12], "big")
    n_out = int.from_bytes(data[12:16], "big")
    return n_in, n_out, data[16:]


def check_file(data: bytes) -> Metrics:
    """Full check of §2.2. Returns the metrics of §2.4 or raises Invalid."""
    n_in, n_out, records = decode_file(data)
    if not records:
        raise Invalid("no records")
    # TAP-02's decoder reads every record; reject REF before resolving anything.
    try:
        els = tap02.decode(records, n_in)
    except tap02.IllFormed as e:
        raise Invalid(f"TAP-02: {e}") from None
    if any(e.op == tap02.REF for e in els):
        raise Invalid("REF record (opcode 0x02) is not allowed in tapnet/1")
    try:
        tap02.load(records, n_in, n_out)
    except tap02.IllFormed as e:
        raise Invalid(f"TAP-02: {e}") from None
    nand = sum(1 for e in els if e.op == tap02.NAND)
    latch = sum(1 for e in els if e.op == tap02.LATCH)
    return Metrics(n_in, n_out, nand, latch)


def netlist_hash(data: bytes) -> bytes:
    return sha256(data)


# ---------------------------------------------------------------- §3 source circuits

def file_from_chain(netlist_bytes: bytes, n_in: int, n_out: int) -> bytes:
    """§3.2: the file a source circuit stands for, from `netlist(id)` and `circuitInfo(id)`."""
    return encode_file(netlist_bytes, n_in, n_out)


def tape_name(circuit_id: int, processor_number: int, area_code: int | None) -> str:
    """TAP-10 §3.1 on-chain name. area_code is None on BNB Smart Chain."""
    if area_code is None:
        return f"{circuit_id}.{processor_number}.tape"
    return f"{circuit_id}.{area_code}.{processor_number}.tape"


# ---------------------------------------------------------------- §5 pools and Merkle trees

FIELD_IMAGE, FIELD_NETLIST = 1, 2
FIELD_ORDER = [("image", FIELD_IMAGE), ("netlist", FIELD_NETLIST)]


def fields_mask(names: list[str]) -> int:
    m = 0
    for n in names:
        m |= dict(FIELD_ORDER)[n]
    return m


def leaf_hash(index: int, values: list[bytes]) -> bytes:
    """§5.3: leaf = SHA-256(0x00 ‖ u32(index) ‖ value_1 ‖ … ‖ value_k), values in field order."""
    if not all(isinstance(v, bytes) and len(v) == 32 for v in values):
        raise Invalid("leaf values must be 32 bytes each")
    return sha256(b"\x00" + index.to_bytes(4, "big") + b"".join(values))


def node_hash(left: bytes, right: bytes) -> bytes:
    return sha256(b"\x01" + left + right)


def merkle_root(leaves: list[bytes]) -> bytes:
    if not leaves:
        raise Invalid("empty pool")
    level = list(leaves)
    while len(level) > 1:
        nxt = [node_hash(level[i], level[i + 1]) for i in range(0, len(level) - 1, 2)]
        if len(level) % 2:
            nxt.append(level[-1])  # an odd last node moves up unchanged
        level = nxt
    return level[0]


def merkle_proof(leaves: list[bytes], index: int) -> list[bytes]:
    if not 0 <= index < len(leaves):
        raise Invalid("index out of range")
    proof, level, i = [], list(leaves), index
    while len(level) > 1:
        if i % 2 == 1:
            proof.append(level[i - 1])
        elif i + 1 < len(level):
            proof.append(level[i + 1])
        nxt = [node_hash(level[k], level[k + 1]) for k in range(0, len(level) - 1, 2)]
        if len(level) % 2:
            nxt.append(level[-1])
        level, i = nxt, i // 2
    return proof


def merkle_levels(leaves: list[bytes]) -> list[list[bytes]]:
    """All levels of the tree of §5.3: levels[0] = leaves, levels[-1] = [root]. Build once, then take many proofs."""
    if not leaves:
        raise Invalid("empty pool")
    levels = [list(leaves)]
    while len(levels[-1]) > 1:
        level = levels[-1]
        nxt = [node_hash(level[i], level[i + 1]) for i in range(0, len(level) - 1, 2)]
        if len(level) % 2:
            nxt.append(level[-1])
        levels.append(nxt)
    return levels


def merkle_proof_from_levels(levels: list[list[bytes]], index: int) -> list[bytes]:
    """Same result as merkle_proof(levels[0], index), without rebuilding the tree."""
    if not 0 <= index < len(levels[0]):
        raise Invalid("index out of range")
    proof, i = [], index
    for level in levels[:-1]:
        if i % 2 == 1:
            proof.append(level[i - 1])
        elif i + 1 < len(level):
            proof.append(level[i + 1])
        i //= 2
    return proof


def merkle_verify(root: bytes, size: int, index: int, leaf: bytes, proof: list[bytes]) -> bool:
    if not 0 <= index < size:
        return False
    h, i, width, p = leaf, index, size, 0
    while width > 1:
        if i % 2 == 1:
            if p >= len(proof):
                return False
            h = node_hash(proof[p], h)
            p += 1
        elif i + 1 < width:
            if p >= len(proof):
                return False
            h = node_hash(h, proof[p])
            p += 1
        i, width = i // 2, (width + 1) // 2
    return p == len(proof) and h == root


# ---------------------------------------------------------------- §6 reveal

def pool_seed(master_seed: bytes, chain_id: int, collection: str, label: str) -> bytes:
    """§6.2: seed = SHA-256(masterSeed ‖ u64(chainId) ‖ collection (20 bytes) ‖ UTF-8(label))."""
    if len(master_seed) != 32:
        raise Invalid("master seed must be 32 bytes")
    if not re.match(r"^0x[0-9a-f]{40}$", collection):
        raise Invalid("collection must be a lowercase 0x address")
    addr = bytes.fromhex(collection[2:])
    return sha256(master_seed + chain_id.to_bytes(8, "big") + addr + label.encode())


def _half_bits(n: int) -> int:
    b = max(1, (n - 1).bit_length())
    return (b + 1) // 2


def _round(seed: bytes, r: int, x: int, half: int) -> int:
    return int.from_bytes(sha256(seed + bytes([r]) + x.to_bytes(4, "big")), "big") & ((1 << half) - 1)


def _feistel(seed: bytes, x: int, half: int) -> int:
    mask = (1 << half) - 1
    left, right = x >> half, x & mask
    for r in range(4):
        left, right = right, left ^ _round(seed, r, right, half)
    return (left << half) | right


def permute(seed: bytes, n: int, index: int) -> int:
    """§6.3: position `index` of a pool of size n receives entry permute(seed, n, index)."""
    if not 0 <= index < n:
        raise Invalid("index out of range")
    if n == 1:
        return 0
    half = _half_bits(n)
    y = _feistel(seed, index, half)
    while y >= n:
        y = _feistel(seed, y, half)
    return y


# ---------------------------------------------------------------- §7 metadata

HEX32 = re.compile(r"^0x[0-9a-f]{64}$")
ADDR = re.compile(r"^0x[0-9a-f]{40}$")
TOKEN_ID = re.compile(r"^eip155:([1-9][0-9]*)/erc721:(0x[0-9a-f]{40})/(0|[1-9][0-9]*)$")
DEC = re.compile(r"^(0|[1-9][0-9]*)$")
TAPE_NAME = re.compile(r"^(0|[1-9][0-9]*)(\.[1-9][0-9]*)?\.(0|[1-9][0-9]*)\.tape$")
STATES = {"unrevealed", "revealed"}


def _req(cond: bool, msg: str) -> None:
    if not cond:
        raise Invalid(msg)


def _uris(v, where: str) -> None:
    _req(isinstance(v, list) and len(v) >= 1, f"{where}.uris must be a non-empty list")
    for u in v:
        _req(isinstance(u, str) and re.match(r"^[a-z][a-z0-9+.-]*:", u) is not None, f"{where}.uris: bad URI {u!r}")


def _uint(v, where: str) -> None:
    _req(isinstance(v, int) and not isinstance(v, bool) and 0 <= v <= 2**53 - 1, f"{where} must be an integer 0..2^53-1")


def _check_optional(tap: dict) -> None:
    ed = tap.get("edition")
    if ed is not None:
        _req(isinstance(ed, dict), "tap.edition must be an object")
        _uint(ed.get("index"), "tap.edition.index")
        _uint(ed.get("of"), "tap.edition.of")
        _req(1 <= ed["index"] <= ed["of"], "tap.edition.index must be in 1..of")

    src = tap.get("source")
    if src is not None:
        _req(isinstance(src, dict), "tap.source must be an object")
        _uint(src.get("chainId"), "tap.source.chainId")
        _req(src["chainId"] > 0, "tap.source.chainId must be non-zero")
        _req(isinstance(src.get("processor"), str) and ADDR.match(src["processor"]) is not None, "tap.source.processor must be a lowercase address")
        _req(isinstance(src.get("circuitId"), str) and DEC.match(src["circuitId"]) is not None, "tap.source.circuitId must be a decimal string")
        _uint(src.get("block"), "tap.source.block")
        if "container" in src:
            _req(isinstance(src["container"], str) and ADDR.match(src["container"]) is not None, "tap.source.container must be a lowercase address")
        if "name" in src:
            _req(isinstance(src["name"], str) and TAPE_NAME.match(src["name"]) is not None, "tap.source.name must be a TAP-10 on-chain name")

    comp = tap.get("companion")
    if comp is not None:
        _req(isinstance(comp, dict), "tap.companion must be an object")
        _uint(comp.get("chainId"), "tap.companion.chainId")
        _req(comp["chainId"] > 0, "tap.companion.chainId must be non-zero")
        _req(isinstance(comp.get("address"), str) and ADDR.match(comp["address"]) is not None,
             "tap.companion.address must be a lowercase address")

    lic = tap.get("license")
    if lic is not None:
        _req(isinstance(lic, dict), "tap.license must be an object")
        for k in ("image", "netlist"):
            if k in lic:
                _req(isinstance(lic[k], str) and lic[k] != "", f"tap.license.{k} must be an SPDX identifier or URI string")

    con = tap.get("content")
    if con is not None:
        _req(isinstance(con, dict), "tap.content must be an object")
        _uint(con.get("chainId"), "tap.content.chainId")
        _req(con["chainId"] > 0, "tap.content.chainId must be non-zero")
        _req(isinstance(con.get("container"), str) and ADDR.match(con["container"]) is not None,
             "tap.content.container must be a lowercase address")
        _req(isinstance(con.get("name"), str) and TAPE_NAME.match(con["name"]) is not None,
             "tap.content.name must be a TAP-10 on-chain name")
        paths = con.get("paths")
        _req(isinstance(paths, dict), "tap.content.paths must be an object")
        for k in ("image", "netlist", "metadata"):
            if k in paths:
                _req(isinstance(paths[k], str) and paths[k] != "", f"tap.content.paths.{k} must be a non-empty string")
        if "lock" in con:
            _req(isinstance(con["lock"], str) and ADDR.match(con["lock"]) is not None, "tap.content.lock must be a lowercase address")


def check_metadata(doc: dict, outside_token_set: bool = False) -> dict:
    """Check the JSON rules of §7 that need no network access. Returns the `tap` object.

    outside_token_set=True applies §5.4/§7.2 for a token outside a set-mode manifest's token set (the
    caller knows this from the token set): state `unrevealed`, no `tap.image`, no `tap.netlist`. The
    ERC-721 `image` member may still be a placeholder.
    """
    _req(isinstance(doc, dict), "metadata must be a JSON object")
    for k in ("name", "image"):
        _req(isinstance(doc.get(k), str), f"`{k}` is required")
    tap = doc.get("tap")
    _req(isinstance(tap, dict), "`tap` object is required")
    _req(tap.get("v") == 1, "tap.v must be 1")
    m = TOKEN_ID.match(tap.get("id", "")) if isinstance(tap.get("id"), str) else None
    _req(m is not None, "tap.id must be eip155:<chainId>/erc721:<lowercase address>/<tokenId>")
    state = tap.get("state")
    _req(state in STATES, "tap.state must be unrevealed or revealed")

    man = tap.get("manifest")
    if man is not None:
        _req(isinstance(man, dict) and isinstance(man.get("sha256"), str) and HEX32.match(man["sha256"]) is not None,
             "tap.manifest.sha256 must be 0x + 64 lowercase hex digits")
        _uris(man.get("uris"), "tap.manifest")
    if outside_token_set:
        _req(state == "unrevealed", "a token outside the token set MUST be unrevealed")
        _req("image" not in tap, "a token outside the token set MUST NOT carry tap.image")
    _check_optional(tap)
    if man is None:
        # §6.4: a collection without a manifest does not form editions; §5.1/§7.1: it MAY name its freeze probe
        _req("edition" not in tap, "a token without tap.manifest MUST NOT carry tap.edition")
        if "freeze" in tap:
            _check_freeze(tap["freeze"], "tap.freeze")
            # §5.1: the probe reads the chain and contract of tap.id
            _req(tap["freeze"]["chainId"] == int(m.group(1)) and tap["freeze"]["contract"] == m.group(2),
                 "tap.freeze.chainId and tap.freeze.contract must equal those of tap.id")
    # with a manifest, tools take the probe from the manifest's `freeze` and ignore tap.freeze (§7.2)
    if "image" in tap or state != "unrevealed":
        img = tap.get("image")
        _req(isinstance(img, dict) and isinstance(img.get("sha256"), str) and HEX32.match(img["sha256"]) is not None,
             "tap.image.sha256 is required")
        _uris(img.get("uris"), "tap.image")
    if state == "unrevealed":
        _req(man is not None, "an unrevealed token MUST carry tap.manifest")
        _req("netlist" not in tap, "an unrevealed token MUST NOT carry tap.netlist")
        return tap

    net = tap.get("netlist")
    _req(isinstance(net, dict), "tap.netlist is required once revealed")
    fmt = net.get("format")
    _req(isinstance(fmt, str) and fmt != "", "tap.netlist.format must be a non-empty string")
    # §2.5: a format string that differs from "tapnet/1" only by case or whitespace is invalid
    _req(fmt == FORMAT_ID or "".join(fmt.split()).lower() != FORMAT_ID,
         "tap.netlist.format differs from tapnet/1 only by case or whitespace")
    if fmt != FORMAT_ID:
        # §2.5: another format defines the members that replace sha256 and bytes; this tool supports
        # tapnet/1 only, so it checks the members every format keeps and reports the netlist as
        # unverifiable (netlist_status), never as invalid.
        _uris(net.get("uris"), "tap.netlist")
        return tap
    _req(isinstance(net.get("sha256"), str) and HEX32.match(net["sha256"]) is not None, "tap.netlist.sha256 is required")
    for k in ("bytes", "nIn", "nOut", "nand", "latch"):
        _uint(net.get(k), f"tap.netlist.{k}")
    _req(net["bytes"] == HEADER_LEN + 7 * net["nand"] + 4 * net["latch"], "tap.netlist.bytes does not match nand/latch")
    _uris(net.get("uris"), "tap.netlist")
    if "structuralHash" in net:
        _req(isinstance(net["structuralHash"], str) and HEX32.match(net["structuralHash"]) is not None,
             "tap.netlist.structuralHash must be 0x + 64 lowercase hex digits")

    return tap


def netlist_status(tap: dict) -> str:
    """After check_metadata: "none" (no netlist yet), "tapnet/1" (checkable by this tool, §7.4), or
    "unverifiable" (a format defined under §2.5 that this tool does not support; not invalid)."""
    net = tap.get("netlist")
    if net is None:
        return "none"
    return FORMAT_ID if net.get("format") == FORMAT_ID else "unverifiable"


def check_manifest_consistency(docs: list, manifest_sha256: str | None = None) -> str | None:
    """§7.1: within one collection either every token carries tap.manifest with the same sha256, or none does.

    `manifest_sha256` is the manifest hash the tool knows from elsewhere (at L1 a non-zero `manifestHash()`;
    or the manifest it fetched); every token's tap.manifest.sha256 must then equal it. Returns the
    collection's manifest hash, or None for a collection without a manifest.
    """
    hashes = {d["tap"]["manifest"]["sha256"] if "manifest" in d["tap"] else None for d in docs}
    _req(not (None in hashes and len(hashes) > 1), "collection mixes tokens with and without tap.manifest")
    _req(len(hashes) <= 1, "tokens of one collection carry different tap.manifest.sha256")
    found = next(iter(hashes), None)
    if manifest_sha256 is not None and docs:
        _req(found == manifest_sha256, "tap.manifest.sha256 differs from the collection's manifest hash")
    return found


def check_freeze_probes(docs: list) -> dict | None:
    """§5.1, §7.1: in a collection without a manifest every token carries the same tap.freeze, or none does.

    Returns the probe a tool may read, or None. With a manifest, tap.freeze is ignored (§7.2) and None is returned.
    """
    if check_manifest_consistency(docs) is not None:
        return None
    probes = [json.dumps(d["tap"].get("freeze"), sort_keys=True) for d in docs]
    _req(len(set(probes)) <= 1, "tokens of one collection name different tap.freeze probes, or only some name one")
    return docs[0]["tap"].get("freeze") if docs else None


def check_editions(docs: list, manifest_sha256: str | None = None) -> str:
    """§6.4 at collection level: every netlist hash used by n > 1 tokens needs edition index/of on each.

    First checks that the collection does not mix tokens with and without tap.manifest (§7.1; with
    `manifest_sha256`, against that hash). A collection without a manifest forms no editions (§6.4).
    Tokens whose netlist is in a format this tool does not support (§2.5) are skipped, since their
    netlist hash cannot be compared; the result is then "unverifiable" rather than "valid".
    """
    if check_manifest_consistency(docs, manifest_sha256) is None:
        return "valid"
    by_hash, skipped = {}, False
    for d in docs:
        t = d["tap"]
        if t["state"] == "unrevealed":
            continue
        if netlist_status(t) != FORMAT_ID:
            skipped = True
            continue
        tid = int(t["id"].rsplit("/", 1)[1])
        by_hash.setdefault(t["netlist"]["sha256"], []).append((tid, t.get("edition")))
    for h, items in by_hash.items():
        items.sort()
        n = len(items)
        for rank, (tid, ed) in enumerate(items, 1):
            if n == 1:
                _req(ed is None or ed == {"index": 1, "of": 1}, f"token {tid}: edition must be absent or 1/1")
            else:
                _req(ed == {"index": rank, "of": n}, f"token {tid}: edition must be {rank}/{n}")
    return "unverifiable" if skipped else "valid"


def check_netlist_against_metadata(tap: dict, data: bytes | None) -> Metrics:
    """§7.4: a fetched file MUST hash to tap.netlist.sha256 and match the declared metrics.

    For a format this tool does not support (§2.5), `data` is the fetched file, or None if it could not be
    fetched: a file whose bytes 0-5 are not TAPNET or whose byte 6 is 0x01 is invalid; otherwise the
    netlist is unverifiable (Unverifiable, not Invalid).
    """
    if tap["netlist"].get("format") != FORMAT_ID:
        if data is not None:
            _req(len(data) >= 7 and data[:6] == MAGIC, "netlist file of another format does not start with TAPNET")
            _req(data[6] != VERSION, "netlist file of another format has the tapnet/1 version byte 0x01")
        raise Unverifiable(f"netlist format {tap['netlist'].get('format')!r} is not supported by this tool (§2.5)")
    _req(data is not None, "netlist file could not be fetched")
    _req(hex32(netlist_hash(data)) == tap["netlist"]["sha256"], "netlist file does not hash to tap.netlist.sha256")
    mt = check_file(data)
    net = tap["netlist"]
    _req((mt.n_in, mt.n_out, mt.nand, mt.latch, len(data)) == (net["nIn"], net["nOut"], net["nand"], net["latch"], net["bytes"]),
         "netlist metrics differ from tap.netlist")
    return mt


# ---------------------------------------------------------------- §5.1–§5.2 manifest check

POOL_FIELDS = (["image"], ["netlist"], ["image", "netlist"])
REVEAL_SOURCES = ("drand", "blockhash", "none")
DRAND_CHAIN_HASH = re.compile(r"^[0-9a-f]{64}$")
CALL_SIG = re.compile(r"^[A-Za-z_$][A-Za-z0-9_$]*\(\)$")
ZERO32 = "0x" + "00" * 32


def _uri_list(v, where: str) -> None:
    _req(isinstance(v, list) and len(v) >= 1, f"{where} must be a non-empty list of URIs")
    for u in v:
        _req(isinstance(u, str) and re.match(r"^[a-z][a-z0-9+.-]*:", u) is not None, f"{where}: bad URI {u!r}")


def _hash_value(v, where: str) -> None:
    _req(isinstance(v, str) and HEX32.match(v) is not None, f"{where} must be 0x + 64 lowercase hex digits")
    _req(v != ZERO32, f"{where} must not be zero")


def _check_freeze(fr, where: str) -> None:
    """The freeze probe: the manifest's `freeze` (§5.1), or `tap.freeze` of a collection without a manifest."""
    _req(isinstance(fr, dict), f"{where} must be an object")
    _uint(fr.get("chainId"), f"{where}.chainId")
    _req(fr["chainId"] > 0, f"{where}.chainId must be non-zero")
    _req(isinstance(fr.get("contract"), str) and ADDR.match(fr["contract"]) is not None,
         f"{where}.contract must be a lowercase address")
    _req(isinstance(fr.get("call"), str) and CALL_SIG.match(fr["call"]) is not None,
         f"{where}.call must be a function signature without arguments, e.g. uriFrozen()")
    _req(fr.get("expect") is True, f"{where}.expect must be true")


def check_manifest(doc_bytes: bytes) -> dict:
    """§5.1–§5.2 (and the §6.1 parameters) for a manifest file's bytes. Returns the parsed manifest.

    Does not fetch anything: it cannot check that netlist hashes belong to valid tapnet/1 files, nor
    when the manifest was published.
    """
    try:
        doc = json.loads(doc_bytes.decode("utf-8") if isinstance(doc_bytes, (bytes, bytearray)) else doc_bytes)
    except (UnicodeDecodeError, ValueError):
        raise Invalid("manifest is not UTF-8 JSON") from None
    _req(isinstance(doc, dict), "manifest must be a JSON object")
    _req(doc.get("tapManifest") == 1 and type(doc.get("tapManifest")) is int, "tapManifest must be 1")

    col = doc.get("collection")
    _req(isinstance(col, dict), "collection must be an object")
    _uint(col.get("chainId"), "collection.chainId")
    _req(col["chainId"] > 0, "collection.chainId must be non-zero")
    _req(isinstance(col.get("address"), str) and ADDR.match(col["address"]) is not None,
         "collection.address must be a lowercase address")
    if "tokenSet" in col:
        _req("firstTokenId" not in col and "supply" not in col,
             "collection must use either firstTokenId and supply or tokenSet, not both")
        ts = col["tokenSet"]
        _req(isinstance(ts, dict), "collection.tokenSet must be an object")
        _req(isinstance(ts.get("sha256"), str) and HEX32.match(ts["sha256"]) is not None,
             "collection.tokenSet.sha256 must be 0x + 64 lowercase hex digits")
        _uint(ts.get("count"), "collection.tokenSet.count")
        supply = ts["count"]
        _req(1 <= supply <= 2**32, "collection.tokenSet.count must be in 1..2^32")
        _uri_list(ts.get("uris"), "collection.tokenSet.uris")
        size_name = "count"
    else:
        _uint(col.get("supply"), "collection.supply")
        supply = col["supply"]
        _req(1 <= supply <= 2**32, "collection.supply must be in 1..2^32")
        _uint(col.get("firstTokenId"), "collection.firstTokenId")
        _req(col["firstTokenId"] <= 2**53 - 1 - supply, "collection.firstTokenId must be at most 2^53 - 1 - supply")
        size_name = "supply"

    rev = doc.get("reveal")
    _req(isinstance(rev, dict), "reveal must be an object")
    src = rev.get("source")
    _req(src != "vrf", "reveal.source \"vrf\" is reserved and not defined in version 1")
    _req(src in REVEAL_SOURCES, "reveal.source must be drand, blockhash or none")
    if src == "drand":
        _req(isinstance(rev.get("chainHash"), str) and DRAND_CHAIN_HASH.match(rev["chainHash"]) is not None,
             "reveal.chainHash must be 64 lowercase hex digits without 0x")
        _uint(rev.get("round"), "reveal.round")
    elif src == "blockhash":
        _uint(rev.get("chainId"), "reveal.chainId")
        _req(rev["chainId"] > 0, "reveal.chainId must be non-zero")
        _uint(rev.get("blockNumber"), "reveal.blockNumber")

    pools = doc.get("pools")
    _req(isinstance(pools, list) and 1 <= len(pools) <= 2, "pools must hold one or two pools")
    labels, used = set(), set()
    for k, pool in enumerate(pools):
        w = f"pools[{k}]"
        _req(isinstance(pool, dict), f"{w} must be an object")
        lab = pool.get("label")
        _req(isinstance(lab, str) and 1 <= len(lab) <= 64 and all(0x20 <= ord(c) <= 0x7E for c in lab),
             f"{w}.label must be 1-64 bytes of printable ASCII")
        _req(lab not in labels, f"{w}.label is not unique")
        labels.add(lab)
        fields = pool.get("fields")
        _req(fields in POOL_FIELDS, f'{w}.fields must be ["image"], ["netlist"] or ["image", "netlist"]')
        _req(not used & set(fields), f"{w}.fields: a field appears in more than one pool")
        used |= set(fields)
        _hash_value(pool.get("root"), f"{w}.root")
        entries = pool.get("entries")
        _req(isinstance(entries, list) and len(entries) == supply, f"{w}.entries must hold exactly {size_name} entries")
        leaves = []
        for i, e in enumerate(entries):
            we = f"{w}.entries[{i}]"
            _req(isinstance(e, dict), f"{we} must be an object")
            for f in fields:
                _hash_value(e.get(f), f"{we}.{f}")
            if "uris" in e:
                if len(fields) == 1:
                    _uri_list(e["uris"], f"{we}.uris")
                else:
                    _req(isinstance(e["uris"], dict), f"{we}.uris must be an object with image and netlist lists in a two-field pool")
                    for f in fields:
                        _uri_list(e["uris"].get(f), f"{we}.uris.{f}")
            leaves.append(leaf_hash(i, [bytes.fromhex(e[f][2:]) for f in fields]))
        _req(hex32(merkle_root(leaves)) == pool["root"], f"{w}.root does not match its entries")

    fr = doc.get("freeze")
    if fr is not None:
        _check_freeze(fr, "freeze")
    return doc


# ---------------------------------------------------------------- token sets and assignment

U32_MAX = 2**32 - 1


def token_set_hash(ids: list[int]) -> bytes:
    """tokenSet.sha256 = SHA-256(u32be(id_1) ‖ … ‖ u32be(id_n)), ids strictly ascending, each < 2^32."""
    return sha256(token_set_file(ids))


def token_set_file(ids: list[int]) -> bytes:
    """The bytes of the token-set file (.bin) for ascending ids."""
    for k, t in enumerate(ids):
        _req(isinstance(t, int) and not isinstance(t, bool) and 0 <= t <= U32_MAX, "token ids must be integers 0..2^32-1")
        _req(k == 0 or ids[k - 1] < t, "token ids must be strictly ascending")
    return b"".join(t.to_bytes(4, "big") for t in ids)


def check_token_set(manifest: dict, data: bytes) -> list[int]:
    """Decode a fetched token-set file and check it against manifest.collection.tokenSet. Returns the ids."""
    ts = manifest["collection"]["tokenSet"]
    _req(len(data) % 4 == 0, "token-set file length is not a multiple of 4")
    ids = [int.from_bytes(data[i:i + 4], "big") for i in range(0, len(data), 4)]
    for k in range(1, len(ids)):
        _req(ids[k - 1] < ids[k], "token ids must be strictly ascending")
    _req(len(ids) == ts["count"], "token-set file does not hold tokenSet.count ids")
    _req(hex32(sha256(data)) == ts["sha256"], "token-set file does not hash to tokenSet.sha256")
    return ids


def token_index(ids_sorted: list[int], t: int) -> int:
    """Set mode: the index x of token t is its rank among the ids (from 0). Raises Invalid if t is not in the set."""
    import bisect
    x = bisect.bisect_left(ids_sorted, t)
    _req(x < len(ids_sorted) and ids_sorted[x] == t, f"token {t} is not in the token set")
    return x


def assignment(manifest: dict, master_seed: bytes | None, t: int, ids: list[int] | None = None) -> dict | None:
    """Entry index of each pool (by label) that token t receives, or None if t is not covered.

    `manifest` is a checked manifest; set mode needs `ids` (checked with check_token_set). With reveal
    source `none` the master seed is not used and may be None.
    """
    col = manifest["collection"]
    if "tokenSet" in col:
        _req(ids is not None, "a set-mode manifest needs its token ids")
        n = col["tokenSet"]["count"]
        try:
            x = token_index(ids, t)
        except Invalid:
            return None
    else:
        n = col["supply"]
        x = t - col["firstTokenId"]
        if not 0 <= x < n:
            return None
    out = {}
    for pool in manifest["pools"]:
        if manifest["reveal"]["source"] == "none":
            out[pool["label"]] = x
        else:
            out[pool["label"]] = permute(pool_seed(master_seed, col["chainId"], col["address"], pool["label"]), n, x)
    return out


if __name__ == "__main__":
    import sys
    for path in sys.argv[1:]:
        with open(path, "rb") as f:
            raw = f.read()
        if path.endswith(".json") and b'"tapManifest"' in raw:
            m = check_manifest(raw)
            col = m["collection"]
            size = f"token set of {col['tokenSet']['count']}" if "tokenSet" in col else f"supply {col['supply']}"
            print(path, "ok: manifest", hex32(sha256(raw)), size)
        elif path.endswith(".json"):
            t = check_metadata(json.loads(raw))
            st = netlist_status(t)
            print(path, "ok:", t["state"] + (", netlist unverifiable (format not supported, §2.5)" if st == "unverifiable" else ""))
        else:
            mt = check_file(raw)
            print(path, "ok:", hex32(netlist_hash(raw)), mt.as_json())
