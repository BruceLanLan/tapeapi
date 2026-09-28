#!/usr/bin/env python3
"""A second, independent implementation of the TapeAPI digests, in pure Python with no dependencies.

Its only job is to disagree with the reference SDK if the specification is ambiguous. Everything here was
written from the specifications (TAP-20, TAP-21, TAP-22, TAP-26, TAP-27) and checked against spec/vectors/*.json;
nothing is imported from the JavaScript. X25519, HKDF, (X)ChaCha20-Poly1305 and Ed25519 follow their RFCs. If this file and the SDK ever disagree, the specification is the thing that is wrong.

用纯 Python、零依赖写的第二个独立实现。它唯一的职责，是在规范存在歧义时与参考 SDK 产生分歧。
这里的一切都是照着 TAP-20 与 TAP-21 写的，再对照向量文件核对，没有从 JavaScript 那边引入任何东西。
如果本文件与 SDK 出现分歧，那么错的是规范。

    python3 spec/vectors/verify.py
"""
import json, sys, pathlib

# ---------------------------------------------------------------- keccak-256 ----
_RC = [0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000,
       0x000000000000808B, 0x0000000080000001, 0x8000000080008081, 0x8000000000008009,
       0x000000000000008A, 0x0000000000000088, 0x0000000080008009, 0x000000008000000A,
       0x000000008000808B, 0x800000000000008B, 0x8000000000008089, 0x8000000000008003,
       0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
       0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008]
_ROT = [[0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61],
        [28, 55, 25, 21, 56], [27, 20, 39, 8, 14]]
_M = (1 << 64) - 1

def _rotl(x, n):
    return ((x << n) | (x >> (64 - n))) & _M

def _keccak_f(a):
    for rnd in range(24):
        c = [a[x][0] ^ a[x][1] ^ a[x][2] ^ a[x][3] ^ a[x][4] for x in range(5)]
        d = [c[(x - 1) % 5] ^ _rotl(c[(x + 1) % 5], 1) for x in range(5)]
        for x in range(5):
            for y in range(5):
                a[x][y] ^= d[x]
        b = [[0] * 5 for _ in range(5)]
        for x in range(5):
            for y in range(5):
                b[y][(2 * x + 3 * y) % 5] = _rotl(a[x][y], _ROT[x][y])
        for x in range(5):
            for y in range(5):
                a[x][y] = b[x][y] ^ ((~b[(x + 1) % 5][y]) & _M) & b[(x + 2) % 5][y]
        a[0][0] ^= _RC[rnd]
    return a

def keccak256(data: bytes) -> bytes:
    rate = 136                                   # 1088 bits for keccak-256 / keccak-256 的吸收率
    a = [[0] * 5 for _ in range(5)]
    padded = bytearray(data)
    padded.append(0x01)                          # keccak padding, NOT the 0x06 of SHA3 / 是 keccak 的填充，不是 SHA3 的 0x06
    while len(padded) % rate != 0:
        padded.append(0x00)
    padded[-1] |= 0x80
    for off in range(0, len(padded), rate):
        blk = padded[off:off + rate]
        for i in range(rate // 8):
            lane = int.from_bytes(blk[i * 8:i * 8 + 8], 'little')
            a[i % 5][i // 5] ^= lane
        a = _keccak_f(a)
    out = bytearray()
    for i in range(4):                           # 32 bytes out / 输出 32 字节
        out += a[i % 5][i // 5].to_bytes(8, 'little')
    return bytes(out[:32])

# ------------------------------------------------------- canonicalJSON (TAP-21 §3.3) ----
class CanonError(Exception):
    pass

def _num(v):
    """ECMAScript Number::toString, which is what JCS specifies. / JCS 指定的就是 ECMAScript 的数字转字符串。"""
    if isinstance(v, bool):
        raise CanonError('bool is not a number')
    if isinstance(v, int):
        if abs(v) > 2**53 - 1:
            raise CanonError('integer outside +-(2^53-1); carry it as a string')
        return str(v)
    if v != v or v in (float('inf'), float('-inf')):
        raise CanonError('non-finite number')
    if v == 0 and str(v)[0] == '-':
        raise CanonError('negative zero')
    if v.is_integer():
        if abs(v) > 2**53 - 1:
            raise CanonError('integer outside +-(2^53-1); carry it as a string')
        return str(int(v))
    # ECMAScript Number::toString (ES2023 7.1.12.1), from the shortest round-trip digits Python's repr gives.
    # Decimal notation for 1e-6 <= |x| < 1e21, exponent notation otherwise -- Python's own switch point differs
    # (it writes 1e-05 where ECMAScript writes 0.00001), which a fuzzer found on 2026-09-22.
    # ECMAScript 的数字转字符串：1e-6 <= |x| < 1e21 用十进制，否则用指数。Python 自己的切换点不同。
    neg = v < 0
    digits, exp10 = _shortest(abs(v))          # value = 0.digits * 10^exp10  (ECMA's n = exp10, k = len(digits))
    k, n = len(digits), exp10
    if k <= n <= 21:
        out = digits + '0' * (n - k)
    elif 0 < n <= 21:
        out = digits[:n] + '.' + digits[n:]
    elif -6 < n <= 0:
        out = '0.' + '0' * (-n) + digits
    else:
        e = n - 1
        out = (digits[0] + ('.' + digits[1:] if k > 1 else '')) + 'e' + ('+' if e >= 0 else '-') + str(abs(e))
    return ('-' if neg else '') + out

def _shortest(x):
    # repr gives the shortest digits that round-trip, like ECMAScript. Normalise to (digit string, n).
    # repr 给出能往返的最短数字串（与 ECMAScript 相同）；规整为 (数字串, n)。
    r = repr(x)
    mant, _, e = r.partition('e')
    e = int(e) if e else 0
    if '.' in mant:
        ip, fp = mant.split('.')
    else:
        ip, fp = mant, ''
    if fp == '0':
        fp = ''
    digits = (ip + fp).lstrip('0')
    lead = len(ip.lstrip('0')) if ip.strip('0') else -(len(fp) - len(fp.lstrip('0')))
    n = e + (len(ip) if ip.strip('0') else lead)
    digits = digits.rstrip('0') or '0'
    return digits, n

_ESC = {'"': '\\"', '\\': '\\\\', '\b': '\\b', '\f': '\\f', '\n': '\\n', '\r': '\\r', '\t': '\\t'}

def _str(s):
    # json.loads combines a valid surrogate pair into one code point, so anything left in D800-DFFF is lone.
    # json.loads 会把合法代理对合成一个码点，因此还留在 D800-DFFF 范围的必然是单独的代理项。
    if any(0xD800 <= ord(ch) <= 0xDFFF for ch in s):
        raise CanonError('lone UTF-16 surrogate')
    out = ['"']
    for ch in s:
        if ch in _ESC:
            out.append(_ESC[ch])
        elif ord(ch) < 0x20:
            out.append('\\u%04x' % ord(ch))
        else:
            out.append(ch)                       # non-ASCII stays literal / 非 ASCII 原样保留
    out.append('"')
    return ''.join(out)

FORBIDDEN = {'__proto__', 'constructor', 'prototype'}

def _utf16_key(k):
    """Sort by UTF-16 code units, so 'z' (0x7A) precedes an astral emoji (0xD83D…).
    按 UTF-16 码元排序，因此 'z'(0x7A) 排在星外 emoji(0xD83D…) 之前。"""
    return k.encode('utf-16-be')

def canonical(v):
    if v is None:
        return 'null'
    if isinstance(v, bool):
        return 'true' if v else 'false'
    if isinstance(v, (int, float)):
        return _num(v)
    if isinstance(v, str):
        return _str(v)
    if isinstance(v, list):
        return '[' + ','.join(canonical(x) for x in v) + ']'
    if isinstance(v, dict):
        parts = []
        for k in sorted(v.keys(), key=_utf16_key):
            if k in FORBIDDEN:
                raise CanonError('forbidden key %r' % k)
            parts.append(_str(k) + ':' + canonical(v[k]))
        return '{' + ','.join(parts) + '}'
    raise CanonError('unsupported %s' % type(v).__name__)

# ------------------------------------------------------------------ digests ----
def h(x):
    return '0x' + x.hex()

def u64(n):
    return int(n).to_bytes(8, 'big')

def response_digest(prefix, container, id_, method, params, ok, body, ts):
    return keccak256(
        prefix.encode() +
        bytes.fromhex(container[2:]) +
        keccak256(id_.encode()) +
        keccak256(canonical({'method': method, 'params': params}).encode()) +
        (b'\x01' if ok else b'\x00') +
        keccak256(canonical(body).encode()) +
        u64(ts)
    )

def eip712_domain(name, version, chain_id, verifying):
    type_hash = keccak256(b'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')
    return keccak256(type_hash + keccak256(name.encode()) + keccak256(version.encode()) +
                     int(chain_id).to_bytes(32, 'big') + bytes(12) + bytes.fromhex(verifying[2:]))

def typed_digest(domain_sep, struct_hash):
    return keccak256(b'\x19\x01' + domain_sep + struct_hash)

def addr32(a):
    return bytes(12) + bytes.fromhex(a[2:])

# ------------------------------------------------------------------- runner ----
HERE = pathlib.Path(__file__).parent
fail = []
checked = 0

def check(label, got, want):
    global checked
    checked += 1
    if got != want:
        fail.append('%s\n    got  %s\n    want %s' % (label, got, want))

canon = json.loads((HERE / 'tap-21-canon.json').read_text())
for c in canon['positive']:
    try:
        got = canonical(c['input'])
    except CanonError as e:
        fail.append('%s: raised %s' % (c['name'], e)); continue
    check('canon/' + c['name'], got, c['canonical'])
    check('canon-hash/' + c['name'], h(keccak256(got.encode())), c['keccak256'])
def _strict_pairs(pairs):
    seen = set()
    for k, _ in pairs:
        if k in seen:
            raise CanonError('duplicate key %r' % k)
        seen.add(k)
    return dict(pairs)

def _reject_const(tok):
    raise CanonError('non-finite number ' + tok)

def strict_parse(text):
    """JSON as TAP-21 accepts it: duplicate keys, NaN/Infinity and -0 are refused, not silently normalised."""
    def pint(t):
        if t == '-0':
            raise CanonError('negative zero')
        return int(t)
    try:
        v = json.loads(text, object_pairs_hook=_strict_pairs, parse_constant=_reject_const, parse_int=pint)
    except CanonError:
        raise
    except ValueError as e:
        raise CanonError(str(e))
    canonical(v)                                  # also enforce the value rules / 同时执行值层面的规则
    return v

for c in canon['negative']:
    if 'text' in c:
        try:
            strict_parse(c['text']); fail.append('canon-neg-text/%s: accepted a text it must refuse' % c['name'])
        except CanonError:
            checked += 1
for c in canon['negative']:
    if 'value' in c:
        try:
            canonical(c['value']); fail.append('canon-neg/%s: accepted a value it must refuse' % c['name'])
        except CanonError:
            checked += 1

env = json.loads((HERE / 'tap-21-envelope.json').read_text())
for c in env['cases']:
    check('envelope-canonreq/' + c['name'], canonical({'method': c['method'], 'params': c['params']}), c['intermediate']['canonicalRequest'])
    check('envelope-canonbody/' + c['name'], canonical(c['body']), c['intermediate']['canonicalBody'])
    got = response_digest(env['prefix'], env['container'], c['id'], c['method'], c['params'], c['ok'], c['body'], c['ts'])
    check('envelope-digest/' + c['name'], h(got), c['digest'])

dele = json.loads((HERE / 'tap-20-delegation.json').read_text())
d = dele['domain']
dom = eip712_domain(d['name'], d['version'], d['chainId'], d['verifyingContract'])
th = keccak256(dele['typeHash'].encode())
for c in dele['cases']:
    sh = keccak256(th + addr32(c['container']) + addr32(c['signer']) + u64(c['expires']).rjust(32, b'\x00'))
    check('delegation/' + c['name'], h(typed_digest(dom, sh)), c['digest'])

vou = json.loads((HERE / 'tap-22-voucher.json').read_text())
d = vou['domain']
dom = eip712_domain(d['name'], d['version'], d['chainId'], d['verifyingContract'])
th = keccak256(vou['typeHash'].encode())
for c in vou['cases']:
    sh = keccak256(th + addr32(c['consumer']) + addr32(c['provider']) +
                   int(c['cumulative']).to_bytes(32, 'big') + u64(c['expires']).rjust(32, b'\x00'))
    check('voucher/' + c['name'], h(typed_digest(dom, sh)), c['digest'])


# ============================================================ TAP-26 channel ====
# X25519 (RFC 7748), HKDF-SHA256 (RFC 5869) and ChaCha20-Poly1305 (RFC 8439), all written here from the RFCs.
# X25519、HKDF-SHA256、ChaCha20-Poly1305 全部照 RFC 在此处实现。
import hashlib, hmac as _hmac

_P25519 = 2**255 - 19

def x25519(k: bytes, u: bytes) -> bytes:
    k = bytearray(k); k[0] &= 248; k[31] &= 127; k[31] |= 64
    n = int.from_bytes(k, 'little')
    u = bytearray(u); u[31] &= 127
    x1 = int.from_bytes(u, 'little') % _P25519
    x2, z2, x3, z3, swap = 1, 0, x1, 1, 0
    for t in reversed(range(255)):
        kt = (n >> t) & 1
        swap ^= kt
        if swap:
            x2, x3, z2, z3 = x3, x2, z3, z2
        swap = kt
        a = (x2 + z2) % _P25519; aa = a * a % _P25519
        b = (x2 - z2) % _P25519; bb = b * b % _P25519
        e = (aa - bb) % _P25519
        c = (x3 + z3) % _P25519; d = (x3 - z3) % _P25519
        da = d * a % _P25519; cb = c * b % _P25519
        x3 = (da + cb) ** 2 % _P25519
        z3 = x1 * (da - cb) ** 2 % _P25519
        x2 = aa * bb % _P25519
        z2 = e * (aa + 121665 * e) % _P25519
    if swap:
        x2, x3, z2, z3 = x3, x2, z3, z2
    return (x2 * pow(z2, _P25519 - 2, _P25519) % _P25519).to_bytes(32, 'little')

def x25519_pub(k):
    return x25519(k, (9).to_bytes(32, 'little'))

def hkdf_sha256(ikm, salt, info, length):
    prk = _hmac.new(salt, ikm, hashlib.sha256).digest()
    out, t, i = b'', b'', 1
    while len(out) < length:
        t = _hmac.new(prk, t + info + bytes([i]), hashlib.sha256).digest()
        out += t; i += 1
    return out[:length]

def _rotl32(v, c):
    return ((v << c) | (v >> (32 - c))) & 0xffffffff

def _chacha_block(key, counter, nonce):
    c = [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]
    k = [int.from_bytes(key[i:i + 4], 'little') for i in range(0, 32, 4)]
    n = [int.from_bytes(nonce[i:i + 4], 'little') for i in range(0, 12, 4)]
    st = c + k + [counter] + n
    w = list(st)
    def qr(a, b, c_, d):
        w[a] = (w[a] + w[b]) & 0xffffffff; w[d] = _rotl32(w[d] ^ w[a], 16)
        w[c_] = (w[c_] + w[d]) & 0xffffffff; w[b] = _rotl32(w[b] ^ w[c_], 12)
        w[a] = (w[a] + w[b]) & 0xffffffff; w[d] = _rotl32(w[d] ^ w[a], 8)
        w[c_] = (w[c_] + w[d]) & 0xffffffff; w[b] = _rotl32(w[b] ^ w[c_], 7)
    for _ in range(10):
        qr(0, 4, 8, 12); qr(1, 5, 9, 13); qr(2, 6, 10, 14); qr(3, 7, 11, 15)
        qr(0, 5, 10, 15); qr(1, 6, 11, 12); qr(2, 7, 8, 13); qr(3, 4, 9, 14)
    return b''.join(((w[i] + st[i]) & 0xffffffff).to_bytes(4, 'little') for i in range(16))

def _chacha20(key, counter, nonce, data):
    out = bytearray()
    for i in range(0, len(data), 64):
        ks = _chacha_block(key, counter + i // 64, nonce)
        out += bytes(a ^ b for a, b in zip(data[i:i + 64], ks))
    return bytes(out)

def _poly1305(key, msg):
    r = int.from_bytes(key[:16], 'little') & 0x0ffffffc0ffffffc0ffffffc0fffffff
    s_ = int.from_bytes(key[16:], 'little')
    p = (1 << 130) - 5
    acc = 0
    for i in range(0, len(msg), 16):
        blk = msg[i:i + 16] + b'\x01'
        acc = (acc + int.from_bytes(blk, 'little')) * r % p
    return ((acc + s_) & ((1 << 128) - 1)).to_bytes(16, 'little')

def _pad16(b):
    return b'\x00' * ((16 - len(b) % 16) % 16)

def chacha20poly1305_seal(key, nonce, aad, pt):
    otk = _chacha_block(key, 0, nonce)[:32]
    ct = _chacha20(key, 1, nonce, pt)
    mac = aad + _pad16(aad) + ct + _pad16(ct) + len(aad).to_bytes(8, 'little') + len(ct).to_bytes(8, 'little')
    return ct + _poly1305(otk, mac)

ch = json.loads((HERE / 'tap-26-channel.json').read_text())
I, R, X = ch['initiator'], ch['responder'], ch['intermediate']
bx = bytes.fromhex
sA, sB, eA, eB = bx(I['staticSecret']), bx(R['staticSecret']), bx(I['ephemeralSecret']), bx(R['ephemeralSecret'])
SA, SB, EA, EB = x25519_pub(sA), x25519_pub(sB), x25519_pub(eA), x25519_pub(eB)
check('tap26/static-A', SA.hex(), I['staticPublic']); check('tap26/static-B', SB.hex(), R['staticPublic'])
check('tap26/ephemeral-A', EA.hex(), I['ephemeralPublic']); check('tap26/ephemeral-B', EB.hex(), R['ephemeralPublic'])
check('tap26/invite.e', EA.hex(), ch['invite']['e']); check('tap26/accept.e', EB.hex(), ch['accept']['e'])
# each DH computed from BOTH sides must agree, and match the vector / 每次 DH 从双方各算一遍必须一致
check('tap26/dh1 initiator side', x25519(eA, SB).hex(), X['dh1']); check('tap26/dh1 responder side', x25519(sB, EA).hex(), X['dh1'])
check('tap26/dh2 initiator side', x25519(sA, EB).hex(), X['dh2']); check('tap26/dh2 responder side', x25519(eB, SA).hex(), X['dh2'])
check('tap26/dh3 initiator side', x25519(eA, EB).hex(), X['dh3']); check('tap26/dh3 responder side', x25519(eB, EA).hex(), X['dh3'])
def endpoint(container, chain_id):
    return bytes(4) + int(chain_id).to_bytes(8, 'big') + bytes.fromhex(container[2:])
epA, epB = endpoint(I['container'], I['chainId']), endpoint(R['container'], R['chainId'])
check('tap26/endpointA', epA.hex(), X['endpointA']); check('tap26/endpointB', epB.hex(), X['endpointB'])
cid = bx(ch['invite']['cid'])
ih = hashlib.sha256(canonical(ch['invite']).encode('utf-8')).digest()
check('tap26/inviteHash', ih.hex(), X['inviteHash'])
th = hashlib.sha256(b'TAP-26/transcript/v1' + cid + epA + epB + SA + SB + EA + EB + int(ch['invite']['exp']).to_bytes(8, 'big') + ih).digest()
check('tap26/transcript', th.hex(), X['transcript'])
okm = hkdf_sha256(bx(X['dh1']) + bx(X['dh2']) + bx(X['dh3']), th, b'TAP-26/keys/v1', 128)
kAB, kBA, cA, cB = okm[:32], okm[32:64], okm[64:96], okm[96:]
for name, got in [('kAB', kAB), ('kBA', kBA), ('cA', cA), ('cB', cB)]:
    check('tap26/' + name, got.hex(), X[name])
cfA = _hmac.new(cA, b'TAP-26/confirm/initiator' + th, hashlib.sha256).digest()
cfB = _hmac.new(cB, b'TAP-26/confirm/responder' + th, hashlib.sha256).digest()
check('tap26/confirm initiator', cfA.hex(), ch['ready']['confirm']); check('tap26/confirm responder', cfB.hex(), ch['accept']['confirm'])
for d, key in [(0, 'toInitiator'), (1, 'toResponder')]:
    check('tap26/room ' + key, hashlib.sha256(b'TAP-26/room/v1' + cid + bytes([d])).hexdigest(), X['rooms'][key])
seqs = {'initiator': 0, 'responder': 0}
for f in ch['frames']:
    who = f['from']; sq = seqs[who]; seqs[who] += 1
    key, d = (kAB, 0) if who == 'initiator' else (kBA, 1)
    nonce = bytes(4) + sq.to_bytes(8, 'big')
    aad = b'TAP-26/frame/v1' + cid + bytes([d]) + sq.to_bytes(8, 'big')
    got = sq.to_bytes(8, 'big') + chacha20poly1305_seal(key, nonce, aad, f['plaintext'].encode('utf-8'))
    check('tap26/frame %s #%d %r' % (who, sq, f['plaintext']), got.hex(), f['frame'])

# ---------- TAP-26 §3.1 / §3.2: identity authorisation, inbox room, sealed invite ----------
# XChaCha20 = HChaCha20(key, nonce[:16]) as the subkey, then ChaCha20 with nonce 0^4 || nonce[16:24]
# (draft-irtf-cfrg-xchacha). / XChaCha20：先用 HChaCha20 派生子密钥，再以 0^4 || nonce[16:24] 作 ChaCha20 随机数。
def _hchacha20(key, nonce16):
    c = [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]
    k = [int.from_bytes(key[i:i + 4], 'little') for i in range(0, 32, 4)]
    n = [int.from_bytes(nonce16[i:i + 4], 'little') for i in range(0, 16, 4)]
    w = c + k + n
    def qr(a, b, c_, d):
        w[a] = (w[a] + w[b]) & 0xffffffff; w[d] = _rotl32(w[d] ^ w[a], 16)
        w[c_] = (w[c_] + w[d]) & 0xffffffff; w[b] = _rotl32(w[b] ^ w[c_], 12)
        w[a] = (w[a] + w[b]) & 0xffffffff; w[d] = _rotl32(w[d] ^ w[a], 8)
        w[c_] = (w[c_] + w[d]) & 0xffffffff; w[b] = _rotl32(w[b] ^ w[c_], 7)
    for _ in range(10):
        qr(0, 4, 8, 12); qr(1, 5, 9, 13); qr(2, 6, 10, 14); qr(3, 7, 11, 15)
        qr(0, 5, 10, 15); qr(1, 6, 11, 12); qr(2, 7, 8, 13); qr(3, 4, 9, 14)
    return b''.join(x.to_bytes(4, 'little') for x in w[0:4] + w[12:16])

def xchacha20poly1305_seal(key, nonce24, aad, pt):
    return chacha20poly1305_seal(_hchacha20(key, nonce24[:16]), b'\x00' * 4 + nonce24[16:24], aad, pt)

# RFC-draft test vector for HChaCha20 (draft-irtf-cfrg-xchacha-03 §2.2.1) / HChaCha20 的草案测试向量
check('xchacha/hchacha20 draft vector',
      _hchacha20(bytes(range(32)), bytes.fromhex('000000090000004a0000000031415927')).hex(),
      '82413b4227b27bfed30e42508a877d73a0f9e4d58a74a853c12ec41326d3ecdc')

idv = json.loads((HERE / 'tap-26-identity.json').read_text())
ck = idv['channelKeys']
d = ck['domain']
dom = eip712_domain(d['name'], d['version'], d['chainId'], d['verifyingContract'])
th = keccak256(ck['typeHash'].encode())
k = ck['keys']
inbox_norm = {'relays': [{'url': r['url'], 'container': r['container']} for r in k['inbox'].get('relays', [])]}
if k['inbox'].get('bus'): inbox_norm['bus'] = k['inbox']['bus']
ihash = keccak256(canonical(inbox_norm).encode('utf-8'))
check('tap26/channelKeys inbox hash', '0x' + ihash.hex(), k['inboxHash'])
sh = keccak256(th + addr32(k['container']) + bytes.fromhex(k['x25519'][2:]) + bytes.fromhex(k['ed25519'][2:]) + ihash + u64(k['issued']).rjust(32, b'\x00') + u64(k['expires']).rjust(32, b'\x00'))
check('tap26/channelKeys digest', h(typed_digest(dom, sh)), ck['digest'])
check('tap26/channelKeys typehash differs from Delegation', str(th != keccak256(b'Delegation(address container,address signer,uint64 expires)')), 'True')
ib = idv['inbox']
room = hashlib.sha256(b'TAP-26/inbox/v1' + endpoint(ib['container'], ib['chainId'])).digest()
check('tap26/inbox room', room.hex(), ib['room'])
si = idv['sealedInvite']
R = x25519_pub(bytes.fromhex(si['recipientSecret'][2:]))
e = bytes.fromhex(si['ephemeralSecret'][2:]); E = x25519_pub(e); N = bytes.fromhex(si['nonce'][2:])
sroom = hashlib.sha256(b'TAP-26/inbox/v1' + endpoint(si['recipientContainer'], si['recipientChainId'])).digest()
K = hkdf_sha256(x25519(e, R), b'TAP-26/inbox/v1', E + R + sroom, 32)
wire = b'\x03' + E + N + xchacha20poly1305_seal(K, N, b'TAP-26/inbox/v1' + E + sroom, canonical(si['invite']).encode('utf-8'))
check('tap26/sealed invite', '0x' + wire.hex(), si['wire'])

# ---------- Ed25519, RFC 8032 §5.1 (pure Python, following the RFC's own reference code in §6) ----------
_P = 2 ** 255 - 19
_L = 2 ** 252 + 27742317777372353535851937790883648493
_D = -121665 * pow(121666, _P - 2, _P) % _P
_I = pow(2, (_P - 1) // 4, _P)
def _ed_add(A, B):
    x1, y1, z1, t1 = A; x2, y2, z2, t2 = B
    a = (y1 - x1) * (y2 - x2) % _P; b = (y1 + x1) * (y2 + x2) % _P
    c = 2 * t1 * t2 * _D % _P; d = 2 * z1 * z2 % _P
    e, f, g, hh = b - a, d - c, d + c, b + a
    return (e * f % _P, g * hh % _P, f * g % _P, e * hh % _P)
def _ed_mul(s, A):
    Q = (0, 1, 1, 0)
    while s > 0:
        if s & 1: Q = _ed_add(Q, A)
        A = _ed_add(A, A); s >>= 1
    return Q
def _ed_recover_x(y, sign):
    x2 = (y * y - 1) * pow(_D * y * y + 1, _P - 2, _P) % _P
    if x2 == 0:
        return None if sign else 0
    x = pow(x2, (_P + 3) // 8, _P)
    if (x * x - x2) % _P != 0: x = x * _I % _P
    if (x * x - x2) % _P != 0: return None
    if (x & 1) != sign: x = _P - x
    return x
_gy = 4 * pow(5, _P - 2, _P) % _P
_gx = _ed_recover_x(_gy, 0)
_G = (_gx, _gy, 1, _gx * _gy % _P)
def _ed_compress(Pt):
    zinv = pow(Pt[2], _P - 2, _P); x = Pt[0] * zinv % _P; y = Pt[1] * zinv % _P
    return int.to_bytes(y | ((x & 1) << 255), 32, 'little')
def _ed_decompress(b):
    y = int.from_bytes(b, 'little'); sign = y >> 255; y &= (1 << 255) - 1
    x = _ed_recover_x(y, sign)
    return None if x is None else (x, y, 1, x * y % _P)
def _ed_expand(secret):
    hsh = hashlib.sha512(secret).digest()
    a = int.from_bytes(hsh[:32], 'little'); a &= (1 << 254) - 8; a |= (1 << 254)
    return a, hsh[32:]
def ed25519_pub(secret):
    return _ed_compress(_ed_mul(_ed_expand(secret)[0], _G))
def ed25519_sign(secret, msg):
    a, prefix = _ed_expand(secret); A = _ed_compress(_ed_mul(a, _G))
    r = int.from_bytes(hashlib.sha512(prefix + msg).digest(), 'little') % _L
    Rs = _ed_compress(_ed_mul(r, _G))
    k = int.from_bytes(hashlib.sha512(Rs + A + msg).digest(), 'little') % _L
    return Rs + int.to_bytes((r + k * a) % _L, 32, 'little')
def ed25519_verify(pub, msg, signature):
    A = _ed_decompress(pub); R = _ed_decompress(signature[:32]); S = int.from_bytes(signature[32:], 'little')
    if A is None or R is None or S >= _L: return False
    k = int.from_bytes(hashlib.sha512(signature[:32] + pub + msg).digest(), 'little') % _L
    sB = _ed_mul(S, _G); hA = _ed_add(R, _ed_mul(k, A))
    return _ed_compress(sB) == _ed_compress(hA)

# RFC 8032 §7.1 TEST 1 and TEST 2 / RFC 8032 的测试 1 与测试 2
for name, sk, pk, msg, sgn in [
    ('rfc8032 test 1', '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a', '',
     'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b'),
    ('rfc8032 test 2', '4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb', '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c', '72',
     '92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00')]:
    check('ed25519/' + name + ' public', ed25519_pub(bytes.fromhex(sk)).hex(), pk)
    check('ed25519/' + name + ' signature', ed25519_sign(bytes.fromhex(sk), bytes.fromhex(msg)).hex(), sgn)
    check('ed25519/' + name + ' verifies', str(ed25519_verify(bytes.fromhex(pk), bytes.fromhex(msg), bytes.fromhex(sgn))), 'True')

# ---------- TAP-27: rebuild the epoch message and the messages from the secrets alone ----------
gv = json.loads((HERE / 'tap-27-group.json').read_text())
bh = lambda x: bytes.fromhex(x[2:] if x.startswith('0x') else x)
people = gv['members']
for p_ in people:
    check('tap27/x25519 ' + p_['tag'], '0x' + x25519_pub(bh(p_['x25519Secret'])).hex(), p_['x25519'])
    check('tap27/ed25519 ' + p_['tag'], '0x' + ed25519_pub(bh(p_['ed25519Secret'])).hex(), p_['ed25519'])
gid = bh(gv['gid']); epoch = gv['epoch']; K = bh(gv['K']); e = bh(gv['ephemeralSecret']); N = bh(gv['nonce'])
E = x25519_pub(e)
commit = hashlib.sha256(b'TAP-27/commit/v1' + K).digest()
header = b'\x04' + gid + epoch.to_bytes(8, 'big') + E + N + commit + bytes([len(gv['roster']['members'])])
slots = b''
for m in gv['roster']['members']:
    R = bh(m['x25519'])
    kek = hkdf_sha256(x25519(e, R), b'TAP-27/wrap/v1', E + R + gid + epoch.to_bytes(8, 'big'), 32)
    slots += xchacha20poly1305_seal(kek, N, header, K)          # 48 bytes, no fingerprint / 48 字节，无指纹
roster_ct = xchacha20poly1305_seal(K, N, header + slots, canonical(gv['roster']).encode('utf-8'))
body = header + slots + len(roster_ct).to_bytes(4, 'big') + roster_ct
owner_sig = ed25519_sign(bh(people[0]['ed25519Secret']), b'TAP-27/epoch/v1' + body)
check('tap27/epoch message', '0x' + (body + owner_sig).hex(), gv['epochWire'])
check('tap27/epoch signature verifies', str(ed25519_verify(bh(people[0]['ed25519']), b'TAP-27/epoch/v1' + body, owner_sig)), 'True')
for i, want in enumerate(gv['senderKeys']):
    sk_ = hkdf_sha256(K, gid + epoch.to_bytes(8, 'big'), b'TAP-27/sender/v1' + i.to_bytes(4, 'big'), 32)
    check('tap27/sender key %d' % i, '0x' + sk_.hex(), want)
for m in gv['messages']:
    i, sq = m['sender'], int(m['seq'])
    nonce = bh(m['nonce'])
    hdr = b'\x05' + gid + epoch.to_bytes(8, 'big') + i.to_bytes(4, 'big') + sq.to_bytes(8, 'big') + nonce
    key = bh(gv['senderKeys'][i])
    ct = xchacha20poly1305_seal(key, nonce, hdr, m['plaintext'].encode('utf-8'))
    sg = ed25519_sign(bh(people[i]['ed25519Secret']), b'TAP-27/msg/v1' + hdr + ct)
    check('tap27/message from %d %r' % (i, m['plaintext']), '0x' + (hdr + ct + sg).hex(), m['wire'])

# ======================================================= TAP-21 §3.5 / TAP-20 §3.9 AI usage receipts ====
# The receipt vectors of the reference sidecar (sdk/test/fixtures/ai-receipt-vectors.json), checked from the text of
# TAP-21 §3.5 and TAP-20 §3.9 alone: the request hash, the stream hash by the event-stream rules of §3.5 (parsed here on
# bytes), every amount in Decimal with ROUND_CEILING, the model match, and the §3.3 digest of each receipt with its
# signer recovered by secp256k1 (SEC 1 §4.1.6, written here) over the EIP-191 message.
# 参考旁路的回执向量，只按 TAP-21 §3.5 与 TAP-20 §3.9 的文字核对：请求哈希、按 §3.5 事件流规则（此处按字节解析）的流哈希、
# 用 Decimal 与 ROUND_CEILING 算的每个金额、模型匹配，以及每份回执的 §3.3 摘要和用 secp256k1 恢复出的签名者。
import base64, re
from decimal import Decimal, getcontext, ROUND_CEILING
getcontext().prec = 100          # exact: 18 integer digits × counts up to 2^53 fit many times over / 足够精确

# ---------- secp256k1 public-key recovery (SEC 1 v2 §4.1.6), affine coordinates ----------
_SP = 2 ** 256 - 2 ** 32 - 977
_SN = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
_SG = (0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798, 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8)

def _sec_add(A, B):
    if A is None: return B
    if B is None: return A
    if A[0] == B[0] and (A[1] + B[1]) % _SP == 0: return None
    if A == B:
        lam = 3 * A[0] * A[0] * pow(2 * A[1], _SP - 2, _SP) % _SP
    else:
        lam = (B[1] - A[1]) * pow(B[0] - A[0], _SP - 2, _SP) % _SP
    x = (lam * lam - A[0] - B[0]) % _SP
    return (x, (lam * (A[0] - x) - A[1]) % _SP)

def _sec_mul(k, A):
    R = None
    while k:
        if k & 1: R = _sec_add(R, A)
        A = _sec_add(A, A); k >>= 1
    return R

def eip191(digest32):
    return keccak256(b'\x19Ethereum Signed Message:\n32' + digest32)

def recover_address(digest32, sig_hex):
    """The address whose key made the 65-byte r ‖ s ‖ v signature over digest32, or None. Refuses high s (TAP-21 §3.3)."""
    sig = bytes.fromhex(sig_hex[2:])
    if len(sig) != 65: return None
    r, s, v = int.from_bytes(sig[:32], 'big'), int.from_bytes(sig[32:64], 'big'), sig[64]
    if v >= 27: v -= 27
    if not (0 < r < _SN and 0 < s <= _SN // 2) or v not in (0, 1): return None
    y2 = (pow(r, 3, _SP) + 7) % _SP
    y = pow(y2, (_SP + 1) // 4, _SP)
    if y * y % _SP != y2: return None
    if y & 1 != v: y = _SP - y
    e = int.from_bytes(digest32, 'big')
    ri = pow(r, -1, _SN)
    Q = _sec_add(_sec_mul(s * ri % _SN, (r, y)), _sec_mul((-e * ri) % _SN, _SG))
    if Q is None: return None
    return '0x' + keccak256(Q[0].to_bytes(32, 'big') + Q[1].to_bytes(32, 'big'))[12:].hex()

# TAP-21 §3.3: every envelope signature is an EIP-191 personal_sign over the 32-byte digest; recover each vector's signer.
# (Until 2026-09-28 the file was signed over the raw digest; regenerated.) / 每个信封签名都是对摘要的 EIP-191 签名；逐条恢复签名者。
for c in env['cases']:
    d = bytes.fromhex(c['digest'][2:])
    check('envelope-personal/' + c['name'], h(eip191(d)), c['personalDigest'])
    check('envelope-signer/' + c['name'], recover_address(eip191(d), c['sig']), env['signerAddress'].lower())

# ---------- TAP-21 §3.5 response hash of a stream, on bytes ----------
def sse_digest(body, sentinel):
    if body.startswith(b'\xef\xbb\xbf'):
        body = body[3:]                                   # rule 1: one U+FEFF at the very start / 开头的一个 BOM
    lines = re.split(rb'\r\n|\r|\n', body)[:-1]           # rule 1: an unterminated last line is not a line / 未结束的行不算
    datas, data = [], None
    for line in lines:
        if line == b'':                                   # rule 5: dispatch at a blank line, if it had data / 空行分派
            if data is not None: datas.append(b'\n'.join(data))  # rule 4
            data = None; continue
        if line.startswith(b':'): continue                # rule 2: comments / 注释
        k = line.find(b':')
        field, value = (line, b'') if k < 0 else (line[:k], line[k + 1:])
        if value.startswith(b' '): value = value[1:]      # rule 3
        if field == b'data': data = (data or []) + [value]
    kept = [d for d in datas if sentinel is None or d != sentinel.encode()]
    return hashlib.sha256(b''.join(d + b'\n' for d in kept)).hexdigest()

# ---------- TAP-20 §3.9 amounts and model matching ----------
FORMAT_OF = {'openai_chat': 'openai-chat', 'openai_responses': 'openai-responses', 'anthropic_messages': 'anthropic-messages', 'openai_embeddings': 'openai-embeddings'}
SENTINEL = {'openai-chat': '[DONE]', 'openai-responses': '[DONE]', 'anthropic-messages': None}

def match_entry(models, model, fmt):
    for m in models:
        if 'formats' in m and fmt not in m['formats']: continue
        if isinstance(model, str) and (m['id'] == model or model in m.get('aliases', [])): return m
    return None

def amount(p, u):
    D = lambda k, dflt=None: Decimal(p[k]) if k in p else dflt
    inp, out = Decimal(p['input']), Decimal(p['output'])
    cread, cwrite = D('cacheRead', inp), D('cacheWrite', inp)
    cw1h_price = D('cacheWrite1h', cwrite)
    cr, cw, cw1h = u.get('cache_read_tokens', 0), u.get('cache_write_tokens', 0), u.get('cache_write_1h_tokens', 0)
    rs = u.get('reasoning_tokens', 0) if 'reasoning' in p else 0
    s = (inp * (u['prompt_tokens'] - cr - cw) + cread * cr + cwrite * (cw - cw1h) + cw1h_price * cw1h
         + out * (u['completion_tokens'] - rs) + (D('reasoning', Decimal(0)) * rs))
    return format((s / Decimal(1000000)).quantize(Decimal('0.00000001'), rounding=ROUND_CEILING), 'f')

AIV = json.loads((HERE.parent.parent / 'sdk' / 'test' / 'fixtures' / 'ai-receipt-vectors.json').read_text())
AI_PREFIX = 'TAPI-1/resp/v2'
check('ai/prefix is the TAP-21 §3.3 prefix', AI_PREFIX, env['prefix'])
for c in AIV['cases']:
    e, name = c['expected'], 'ai/' + c['name']
    envl, res = e['envelope'], e['envelope']['result']
    fmt = FORMAT_OF[envl['method']]
    req, body = base64.b64decode(c['requestBase64']), base64.b64decode(c['responseBase64'])
    check(name + '/requestSha256', hashlib.sha256(req).hexdigest(), envl['params']['requestSha256'])
    got = sse_digest(body, SENTINEL[fmt]) if res['stream'] else hashlib.sha256(body).hexdigest()
    check(name + '/responseSha256', got, res['responseSha256'])
    entry = match_entry(AIV['manifest']['ai']['models'], res['model'], fmt)
    want = [{'currency': p['currency'], 'amount': amount(p, res['usage'])} for p in entry['prices']] if entry and res['usage'] else None
    check(name + '/prices', json.dumps(want), json.dumps(res['prices']))
    check(name + '/modelMatchedBy present exactly when an entry matches', 'modelMatchedBy' in res, entry is not None)
    if entry is not None and res.get('modelMatchedBy') == 'request':
        check(name + '/requested model', json.loads(req.decode())['model'], res['model'])
    digest = response_digest(AI_PREFIX, envl['container'], envl['id'], envl['method'], envl['params'], True, res, envl['ts'])
    check(name + '/signer', recover_address(eip191(digest), envl['sig']), AIV['signer'].lower())
    if c['receiptDelivery'] == 'header':
        check(name + '/header', json.loads(base64.urlsafe_b64decode(e['encoded'] + '=' * (-len(e['encoded']) % 4))), envl)
    else:
        check(name + '/comment', (': tapeapi-receipt ' + e['encoded'] + '\n').encode() in body, True)
# The worked amount of TAP-20 §6.3. / TAP-20 §6.3 的算例。
check('ai/§6.3 USDT', amount({'input': '1.25', 'cacheRead': '0.125', 'output': '10', 'reasoning': '12'}, {'prompt_tokens': 1200, 'cache_read_tokens': 1000, 'completion_tokens': 300, 'reasoning_tokens': 100}), '0.00357500')
check('ai/§6.3 BEM', amount({'input': '12.5', 'cacheRead': '1.25', 'output': '100'}, {'prompt_tokens': 1200, 'cache_read_tokens': 1000, 'completion_tokens': 300, 'reasoning_tokens': 100}), '0.03375000')
check('ai/rounded up once, on the sum', amount({'input': '0.00000001', 'output': '0.00000001'}, {'prompt_tokens': 500000, 'completion_tokens': 500000}), '0.00000001')
check('ai/exact past float precision', amount({'input': '999999999999999999.99999999', 'output': '0'}, {'prompt_tokens': 9007199254740991, 'completion_tokens': 0}), '9007199254740990999999999909.92800746')

if fail:
    print('FAIL: %d of %d checks disagreed with the reference implementation\n' % (len(fail), checked))
    for f in fail:
        print('  ' + f)
    sys.exit(1)
print('ok: %d checks, an independent Python implementation agrees with the reference SDK' % checked)
