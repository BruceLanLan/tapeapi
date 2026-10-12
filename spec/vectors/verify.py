#!/usr/bin/env python3
"""A second, independent implementation of the TapeAPI digests, in pure Python with no dependencies.

Its only job is to disagree with the reference SDK if the specification is ambiguous. Everything here was
written from the specifications (TAPI-20, TAPI-21, TAPI-22, TAPI-23, TAPI-26 and TAPI-27 with its §3.8, both in v1 and v2) and checked against spec/vectors/*.json;
nothing is imported from the JavaScript. X25519, HKDF, (X)ChaCha20-Poly1305 and Ed25519 follow their RFCs. If this file and the SDK ever disagree, the specification is the thing that is wrong.

用纯 Python、零依赖写的第二个独立实现。它唯一的职责，是在规范存在歧义时与参考 SDK 产生分歧。
这里的一切都是照着 TAPI-20 与 TAPI-21 写的，再对照向量文件核对，没有从 JavaScript 那边引入任何东西。
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

# ------------------------------------------------------- canonicalJSON (TAPI-21 §3.3) ----
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
def _no_negative_zero_int(t):
    # TAP-11 §6 item 2: negative zero has no canonical form. json.loads reads the integer literal -0 as 0, which
    # canonical() could then not tell apart, so a vector file is read with this hook. / 整数字面量 -0 在读入时就拒绝
    if t.lstrip('-') == '0' and t.startswith('-'):
        raise CanonError('negative zero')
    return int(t)

def load_vec(name):
    return json.loads((HERE / name).read_text(), parse_int=_no_negative_zero_int)

HERE = pathlib.Path(__file__).parent
fail = []
checked = 0

PREFIX = ''   # 'v2:' while the TAPI-26/27 v2 checks run / 跑 TAPI-26/27 v2 核对时为 'v2:'

def check(label, got, want):
    global checked
    checked += 1
    if got != want:
        fail.append('%s%s\n    got  %s\n    want %s' % (PREFIX, label, got, want))

canon = load_vec('tapi-21-canon.json')
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
    """JSON as TAPI-21 accepts it: duplicate keys, NaN/Infinity and -0 are refused, not silently normalised."""
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

env = load_vec('tapi-21-envelope.json')
for c in env['cases']:
    check('envelope-canonreq/' + c['name'], canonical({'method': c['method'], 'params': c['params']}), c['intermediate']['canonicalRequest'])
    check('envelope-canonbody/' + c['name'], canonical(c['body']), c['intermediate']['canonicalBody'])
    got = response_digest(env['prefix'], env['container'], c['id'], c['method'], c['params'], c['ok'], c['body'], c['ts'])
    check('envelope-digest/' + c['name'], h(got), c['digest'])

dele = load_vec('tapi-20-delegation.json')
d = dele['domain']
dom = eip712_domain(d['name'], d['version'], d['chainId'], d['verifyingContract'])
th = keccak256(dele['typeHash'].encode())
for c in dele['cases']:
    sh = keccak256(th + addr32(c['container']) + addr32(c['signer']) + u64(c['expires']).rjust(32, b'\x00'))
    check('delegation/' + c['name'], h(typed_digest(dom, sh)), c['digest'])

vou = load_vec('tapi-22-voucher.json')
d = vou['domain']
dom = eip712_domain(d['name'], d['version'], d['chainId'], d['verifyingContract'])
th = keccak256(vou['typeHash'].encode())
for c in vou['cases']:
    sh = keccak256(th + addr32(c['consumer']) + addr32(c['provider']) +
                   int(c['cumulative']).to_bytes(32, 'big') + u64(c['expires']).rjust(32, b'\x00'))
    check('voucher/' + c['name'], h(typed_digest(dom, sh)), c['digest'])


# ============================================================ TAPI-26 channel ====
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

# ======================================================= TAPI-26 and TAPI-27, versions 1 and 2 ====
# TAPI-26 and TAPI-27 exist in two versions (TAPI-1 §4.1): v1 (labels TAP-26/…, TAP-27/…), Stable (v1) and implemented
# by TapeAPI 1.x by default, whose vector files stay byte for byte as 1.8.0 wrote them; and v2 (spec/TAPI-26-v2.md,
# TAPI-27-v2.md), the same specification with every label beginning tape-channel/ or tape-group/, implemented by the SDK
# with { labels: 'v2' } from TapeAPI 1.8.1 and by default from 2.0. The checks below run once per version, from the text
# of each, against that version's files; the self-tests of the primitives inside run on the first pass only.
# TAPI-26 与 TAPI-27 各有两个版本（TAPI-1 §4.1）：v1（标签 TAP-26/…、TAP-27/…），Stable (v1)，TapeAPI 1.x 默认实现，其向量文件
# 保持 1.8.0 写出的原样；v2（spec/TAPI-26-v2.md、TAPI-27-v2.md），除标签改以 tape-channel/、tape-group/ 开头外与 v1 相同，
# SDK 自 TapeAPI 1.8.1 起以 { labels: 'v2' } 实现，2.0 起为默认。下面的核对按版本各跑一遍，各对各的向量文件。
for PREFIX, CH, GR, F_CH, F_ID, F_G1, F_G2 in (
    ('', b'TAP-26/', b'TAP-27/', 'tapi-26-channel.json', 'tapi-26-identity.json', 'tapi-27-group.json', 'tapi-27-group-v2.json'),
    ('v2:', b'tape-channel/', b'tape-group/', 'tapi-26-v2-channel.json', 'tapi-26-v2-identity.json', 'tapi-27-v2-group.json', 'tapi-27-v2-group-format2.json'),
):
    ch = load_vec(F_CH)
    I, R, X = ch['initiator'], ch['responder'], ch['intermediate']
    bx = bytes.fromhex
    sA, sB, eA, eB = bx(I['staticSecret']), bx(R['staticSecret']), bx(I['ephemeralSecret']), bx(R['ephemeralSecret'])
    SA, SB, EA, EB = x25519_pub(sA), x25519_pub(sB), x25519_pub(eA), x25519_pub(eB)
    check('tapi26/static-A', SA.hex(), I['staticPublic']); check('tapi26/static-B', SB.hex(), R['staticPublic'])
    check('tapi26/ephemeral-A', EA.hex(), I['ephemeralPublic']); check('tapi26/ephemeral-B', EB.hex(), R['ephemeralPublic'])
    check('tapi26/invite.e', EA.hex(), ch['invite']['e']); check('tapi26/accept.e', EB.hex(), ch['accept']['e'])
    # each DH computed from BOTH sides must agree, and match the vector / 每次 DH 从双方各算一遍必须一致
    check('tapi26/dh1 initiator side', x25519(eA, SB).hex(), X['dh1']); check('tapi26/dh1 responder side', x25519(sB, EA).hex(), X['dh1'])
    check('tapi26/dh2 initiator side', x25519(sA, EB).hex(), X['dh2']); check('tapi26/dh2 responder side', x25519(eB, SA).hex(), X['dh2'])
    check('tapi26/dh3 initiator side', x25519(eA, EB).hex(), X['dh3']); check('tapi26/dh3 responder side', x25519(eB, EA).hex(), X['dh3'])
    def endpoint(container, chain_id):
        return bytes(4) + int(chain_id).to_bytes(8, 'big') + bytes.fromhex(container[2:])
    epA, epB = endpoint(I['container'], I['chainId']), endpoint(R['container'], R['chainId'])
    check('tapi26/endpointA', epA.hex(), X['endpointA']); check('tapi26/endpointB', epB.hex(), X['endpointB'])
    cid = bx(ch['invite']['cid'])
    ih = hashlib.sha256(canonical(ch['invite']).encode('utf-8')).digest()
    check('tapi26/inviteHash', ih.hex(), X['inviteHash'])
    th = hashlib.sha256(CH + b'transcript/v1' + cid + epA + epB + SA + SB + EA + EB + int(ch['invite']['exp']).to_bytes(8, 'big') + ih).digest()
    check('tapi26/transcript', th.hex(), X['transcript'])
    okm = hkdf_sha256(bx(X['dh1']) + bx(X['dh2']) + bx(X['dh3']), th, CH + b'keys/v1', 128)
    kAB, kBA, cA, cB = okm[:32], okm[32:64], okm[64:96], okm[96:]
    for name, got in [('kAB', kAB), ('kBA', kBA), ('cA', cA), ('cB', cB)]:
        check('tapi26/' + name, got.hex(), X[name])
    cfA = _hmac.new(cA, CH + b'confirm/initiator' + th, hashlib.sha256).digest()
    cfB = _hmac.new(cB, CH + b'confirm/responder' + th, hashlib.sha256).digest()
    check('tapi26/confirm initiator', cfA.hex(), ch['ready']['confirm']); check('tapi26/confirm responder', cfB.hex(), ch['accept']['confirm'])
    for d, key in [(0, 'toInitiator'), (1, 'toResponder')]:
        check('tapi26/room ' + key, hashlib.sha256(CH + b'room/v1' + cid + bytes([d])).hexdigest(), X['rooms'][key])
    seqs = {'initiator': 0, 'responder': 0}
    for f in ch['frames']:
        who = f['from']; sq = seqs[who]; seqs[who] += 1
        key, d = (kAB, 0) if who == 'initiator' else (kBA, 1)
        nonce = bytes(4) + sq.to_bytes(8, 'big')
        aad = CH + b'frame/v1' + cid + bytes([d]) + sq.to_bytes(8, 'big')
        got = sq.to_bytes(8, 'big') + chacha20poly1305_seal(key, nonce, aad, f['plaintext'].encode('utf-8'))
        check('tapi26/frame %s #%d %r' % (who, sq, f['plaintext']), got.hex(), f['frame'])

    # ---------- TAPI-26 §3.1 / §3.2: identity authorisation, inbox room, sealed invite ----------
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

    # RFC-draft test vector for HChaCha20 (draft-irtf-cfrg-xchacha-03 §2.2.1). A self-test of the primitive, independent of
    # the labels: run on the first pass only, so it is counted once. / HChaCha20 的草案测试向量；与标签无关的原语自检，只在第一遍运行、只计一次。
    if not PREFIX:
        check('xchacha/hchacha20 draft vector',
              _hchacha20(bytes(range(32)), bytes.fromhex('000000090000004a0000000031415927')).hex(),
              '82413b4227b27bfed30e42508a877d73a0f9e4d58a74a853c12ec41326d3ecdc')

    idv = load_vec(F_ID)
    ck = idv['channelKeys']
    d = ck['domain']
    dom = eip712_domain(d['name'], d['version'], d['chainId'], d['verifyingContract'])
    th = keccak256(ck['typeHash'].encode())
    k = ck['keys']
    inbox_norm = {'relays': [{'url': r['url'], 'container': r['container']} for r in k['inbox'].get('relays', [])]}
    if k['inbox'].get('bus'): inbox_norm['bus'] = k['inbox']['bus']
    ihash = keccak256(canonical(inbox_norm).encode('utf-8'))
    check('tapi26/channelKeys inbox hash', '0x' + ihash.hex(), k['inboxHash'])
    sh = keccak256(th + addr32(k['container']) + bytes.fromhex(k['x25519'][2:]) + bytes.fromhex(k['ed25519'][2:]) + ihash + u64(k['issued']).rjust(32, b'\x00') + u64(k['expires']).rjust(32, b'\x00'))
    check('tapi26/channelKeys digest', h(typed_digest(dom, sh)), ck['digest'])
    if not PREFIX:   # a property of the type strings, the same in both versions / 类型串的性质，两个版本相同
        check('tapi26/channelKeys typehash differs from Delegation', str(th != keccak256(b'Delegation(address container,address signer,uint64 expires)')), 'True')
    ib = idv['inbox']
    room = hashlib.sha256(CH + b'inbox/v1' + endpoint(ib['container'], ib['chainId'])).digest()
    check('tapi26/inbox room', room.hex(), ib['room'])
    si = idv['sealedInvite']
    R = x25519_pub(bytes.fromhex(si['recipientSecret'][2:]))
    e = bytes.fromhex(si['ephemeralSecret'][2:]); E = x25519_pub(e); N = bytes.fromhex(si['nonce'][2:])
    sroom = hashlib.sha256(CH + b'inbox/v1' + endpoint(si['recipientContainer'], si['recipientChainId'])).digest()
    K = hkdf_sha256(x25519(e, R), CH + b'inbox/v1', E + R + sroom, 32)
    wire = b'\x03' + E + N + xchacha20poly1305_seal(K, N, CH + b'inbox/v1' + E + sroom, canonical(si['invite']).encode('utf-8'))
    check('tapi26/sealed invite', '0x' + wire.hex(), si['wire'])

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

    # RFC 8032 §7.1 TEST 1 and TEST 2: a self-test of the primitive, first pass only / RFC 8032 的测试 1 与测试 2：原语自检，只在第一遍
    for name, sk, pk, msg, sgn in [] if PREFIX else [
        ('rfc8032 test 1', '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a', '',
         'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b'),
        ('rfc8032 test 2', '4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb', '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c', '72',
         '92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00')]:
        check('ed25519/' + name + ' public', ed25519_pub(bytes.fromhex(sk)).hex(), pk)
        check('ed25519/' + name + ' signature', ed25519_sign(bytes.fromhex(sk), bytes.fromhex(msg)).hex(), sgn)
        check('ed25519/' + name + ' verifies', str(ed25519_verify(bytes.fromhex(pk), bytes.fromhex(msg), bytes.fromhex(sgn))), 'True')

    # ---------- TAPI-27: rebuild the epoch message and the messages from the secrets alone ----------
    gv = load_vec(F_G1)
    bh = lambda x: bytes.fromhex(x[2:] if x.startswith('0x') else x)
    people = gv['members']
    for p_ in people:
        check('tapi27/x25519 ' + p_['tag'], '0x' + x25519_pub(bh(p_['x25519Secret'])).hex(), p_['x25519'])
        check('tapi27/ed25519 ' + p_['tag'], '0x' + ed25519_pub(bh(p_['ed25519Secret'])).hex(), p_['ed25519'])
    gid = bh(gv['gid']); epoch = gv['epoch']; K = bh(gv['K']); e = bh(gv['ephemeralSecret']); N = bh(gv['nonce'])
    E = x25519_pub(e)
    commit = hashlib.sha256(GR + b'commit/v1' + K).digest()
    header = b'\x04' + gid + epoch.to_bytes(8, 'big') + E + N + commit + bytes([len(gv['roster']['members'])])
    slots = b''
    for m in gv['roster']['members']:
        R = bh(m['x25519'])
        kek = hkdf_sha256(x25519(e, R), GR + b'wrap/v1', E + R + gid + epoch.to_bytes(8, 'big'), 32)
        slots += xchacha20poly1305_seal(kek, N, header, K)          # 48 bytes, no fingerprint / 48 字节，无指纹
    roster_ct = xchacha20poly1305_seal(K, N, header + slots, canonical(gv['roster']).encode('utf-8'))
    body = header + slots + len(roster_ct).to_bytes(4, 'big') + roster_ct
    owner_sig = ed25519_sign(bh(people[0]['ed25519Secret']), GR + b'epoch/v1' + body)
    check('tapi27/epoch message', '0x' + (body + owner_sig).hex(), gv['epochWire'])
    check('tapi27/epoch signature verifies', str(ed25519_verify(bh(people[0]['ed25519']), GR + b'epoch/v1' + body, owner_sig)), 'True')
    for i, want in enumerate(gv['senderKeys']):
        sk_ = hkdf_sha256(K, gid + epoch.to_bytes(8, 'big'), GR + b'sender/v1' + i.to_bytes(4, 'big'), 32)
        check('tapi27/sender key %d' % i, '0x' + sk_.hex(), want)
    for m in gv['messages']:
        i, sq = m['sender'], int(m['seq'])
        nonce = bh(m['nonce'])
        hdr = b'\x05' + gid + epoch.to_bytes(8, 'big') + i.to_bytes(4, 'big') + sq.to_bytes(8, 'big') + nonce
        key = bh(gv['senderKeys'][i])
        ct = xchacha20poly1305_seal(key, nonce, hdr, m['plaintext'].encode('utf-8'))
        sg = ed25519_sign(bh(people[i]['ed25519Secret']), GR + b'msg/v1' + hdr + ct)
        check('tapi27/message from %d %r' % (i, m['plaintext']), '0x' + (hdr + ct + sg).hex(), m['wire'])

    # ---------- TAPI-27 §3.8 format 2 (Experimental): rebuild both epochs and the messages from the secrets alone ----------
    # Written from §3.8 only: the epoch field carries the format-2 mark in its high half, the roster is binary, every label
    # is "…/v2". A format-1 reader (§3.3: n at most 2^32 - 1) must refuse every format-2 wire, and a format-2 reader the
    # format-1 epoch message above. / 只按 §3.8 的文字实现；格式 1 读者必须拒收每条格式 2 线路消息，格式 2 读者必须拒收上面的格式 1 纪元消息。
    g2 = load_vec(F_G2)
    MARK2 = 0x54470200
    gid = bh(g2['gid'])
    ef2 = lambda n: MARK2.to_bytes(4, 'big') + n.to_bytes(4, 'big')
    tail2 = canonical({'relays': g2['relays'], 'bus': g2['bus']}).encode('utf-8')
    people2 = g2['members']
    check('tapi27v2/same people as format 1', [p_['ed25519'] for p_ in people2], [p_['ed25519'] for p_ in people])
    roster_prev = None
    for ep in g2['epochs']:
        n = ep['epoch']
        check('tapi27v2/epoch %d field' % n, ef2(n).hex(), ep['epochField'])
        K = bh(ep['K']); e = bh(ep['ephemeralSecret']); N = bh(ep['nonce']); E = x25519_pub(e)
        prev = bytes(32) if roster_prev is None else hashlib.sha256(roster_prev).digest()
        check('tapi27v2/epoch %d prev' % n, prev.hex(), ep['prev'])
        entries = b''.join(bh(p_['container']) + p_['chainId'].to_bytes(4, 'big') + bh(p_['ed25519']) for p_ in people2)
        roster = b'TGR2' + g2['issued'].to_bytes(8, 'big') + prev + len(people2).to_bytes(2, 'big') + entries + len(tail2).to_bytes(2, 'big') + tail2
        check('tapi27v2/epoch %d roster bytes' % n, '0x' + roster.hex(), ep['roster'])
        check('tapi27v2/epoch %d roster is 104 bytes a member with the slot' % n, len(entries) // len(people2) + 48, 104)
        commit = hashlib.sha256(GR + b'commit/v2' + K).digest()
        header = b'\x04' + gid + ef2(n) + E + N + commit + len(people2).to_bytes(2, 'big')
        slots = b''
        for p_ in people2:
            R = bh(p_['x25519'])
            kek = hkdf_sha256(x25519(e, R), GR + b'wrap/v2', E + R + gid + ef2(n), 32)
            slots += xchacha20poly1305_seal(kek, N, header, K)
        ct = xchacha20poly1305_seal(K, N, header + slots, roster)
        body = header + slots + len(ct).to_bytes(4, 'big') + ct
        sg = ed25519_sign(bh(people2[0]['ed25519Secret']), GR + b'epoch/v2' + body)
        check('tapi27v2/epoch %d message' % n, '0x' + (body + sg).hex(), ep['epochWire'])
        wire = bh(ep['epochWire'])
        # format 1 (§3.3): n = uint64be at offset 17 must be at most 2^32 - 1; the format-1 count byte (offset 113) is 0
        # 格式 1：偏移 17 的 uint64be 必须 ≤ 2^32 − 1；格式 1 的 count 字节（偏移 113）为 0
        check('tapi27v2/epoch %d refused by format 1 (epoch field)' % n, int.from_bytes(wire[17:25], 'big') > 2 ** 32 - 1, True)
        check('tapi27v2/epoch %d refused by format 1 (count byte)' % n, wire[113], 0)
        roster_prev = roster
    K1 = bh(g2['epochs'][1]['K'])
    for i, want in enumerate(g2['senderKeys']):
        check('tapi27v2/sender key %d' % i, '0x' + hkdf_sha256(K1, gid + ef2(1), GR + b'sender/v2' + i.to_bytes(4, 'big'), 32).hex(), want)
    for m in g2['messages']:
        i, sq, n = m['sender'], int(m['seq']), m['epoch']
        nonce = bh(m['nonce'])
        hdr = b'\x05' + gid + ef2(n) + i.to_bytes(4, 'big') + sq.to_bytes(8, 'big') + nonce
        ct = xchacha20poly1305_seal(bh(g2['senderKeys'][i]), nonce, hdr, m['plaintext'].encode('utf-8'))
        sg = ed25519_sign(bh(people2[i]['ed25519Secret']), GR + b'msg/v2' + hdr + ct)
        check('tapi27v2/message from %d %r' % (i, m['plaintext']), '0x' + (hdr + ct + sg).hex(), m['wire'])
        check('tapi27v2/message from %d refused by format 1' % i, int.from_bytes(bh(m['wire'])[17:25], 'big') > 2 ** 32 - 1, True)
    # and back: the format-1 epoch message and messages carry a zero high half, which a format-2 reader refuses
    # 反过来：格式 1 的纪元消息与消息高半部分为零，格式 2 读者拒收
    check('tapi27v2/format-1 epoch message refused by format 2', int.from_bytes(bh(gv['epochWire'])[17:21], 'big') == MARK2, False)
    for m in gv['messages']:
        check('tapi27v2/format-1 message refused by format 2', int.from_bytes(bh(m['wire'])[17:21], 'big') == MARK2, False)
PREFIX = ''

# ======================================================= TAPI-21 §3.5 / TAPI-20 §3.9 AI usage receipts ====
# The receipt vectors of the reference sidecar (sdk/test/fixtures/ai-receipt-vectors.json), checked from the text of
# TAPI-21 §3.5 and TAPI-20 §3.9 alone: the request hash, the stream hash by the event-stream rules of §3.5 (parsed here on
# bytes), every amount in Decimal with ROUND_CEILING, the model match, and the §3.3 digest of each receipt with its
# signer recovered by secp256k1 (SEC 1 §4.1.6, written here) over the EIP-191 message.
# 参考旁路的回执向量，只按 TAPI-21 §3.5 与 TAPI-20 §3.9 的文字核对：请求哈希、按 §3.5 事件流规则（此处按字节解析）的流哈希、
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
    """The address whose key made the 65-byte r ‖ s ‖ v signature over digest32, or None. Refuses high s (TAPI-21 §3.3)."""
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

# TAPI-21 §3.3: every envelope signature is an EIP-191 personal_sign over the 32-byte digest; recover each vector's signer.
# (Until 2026-09-28 the file was signed over the raw digest; regenerated.) / 每个信封签名都是对摘要的 EIP-191 签名；逐条恢复签名者。
for c in env['cases']:
    d = bytes.fromhex(c['digest'][2:])
    check('envelope-personal/' + c['name'], h(eip191(d)), c['personalDigest'])
    check('envelope-signer/' + c['name'], recover_address(eip191(d), c['sig']), env['signerAddress'].lower())

# ---------- TAPI-21 §3.5 response hash of a stream, on bytes ----------
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

# ---------- TAPI-20 §3.9 amounts and model matching ----------
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

AIV = json.loads((HERE.parent.parent / 'sdk' / 'test' / 'fixtures' / 'ai-receipt-vectors.json').read_text(), parse_int=_no_negative_zero_int)
AI_PREFIX = 'TAPI-1/resp/v2'
check('ai/prefix is the TAPI-21 §3.3 prefix', AI_PREFIX, env['prefix'])
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
        check(name + '/requested model', json.loads(req.decode(), parse_int=_no_negative_zero_int)['model'], res['model'])
    digest = response_digest(AI_PREFIX, envl['container'], envl['id'], envl['method'], envl['params'], True, res, envl['ts'])
    check(name + '/signer', recover_address(eip191(digest), envl['sig']), AIV['signer'].lower())
    if c['receiptDelivery'] == 'header':
        check(name + '/header', json.loads(base64.urlsafe_b64decode(e['encoded'] + '=' * (-len(e['encoded']) % 4)), parse_int=_no_negative_zero_int), envl)
    else:
        check(name + '/comment', (': tapeapi-receipt ' + e['encoded'] + '\n').encode() in body, True)
# The worked amount of TAPI-20 §6.3. / TAPI-20 §6.3 的算例。
check('ai/§6.3 USDT', amount({'input': '1.25', 'cacheRead': '0.125', 'output': '10', 'reasoning': '12'}, {'prompt_tokens': 1200, 'cache_read_tokens': 1000, 'completion_tokens': 300, 'reasoning_tokens': 100}), '0.00357500')
check('ai/§6.3 BEM', amount({'input': '12.5', 'cacheRead': '1.25', 'output': '100'}, {'prompt_tokens': 1200, 'cache_read_tokens': 1000, 'completion_tokens': 300, 'reasoning_tokens': 100}), '0.03375000')
check('ai/rounded up once, on the sum', amount({'input': '0.00000001', 'output': '0.00000001'}, {'prompt_tokens': 500000, 'completion_tokens': 500000}), '0.00000001')
check('ai/exact past float precision', amount({'input': '999999999999999999.99999999', 'output': '0'}, {'prompt_tokens': 9007199254740991, 'completion_tokens': 0}), '9007199254740990999999999909.92800746')

# ======================================================= TAPI-20 §6.1 mainnet manifest of 11.1013.tape ====
# The recorded mainnet answers (sdk/test/fixtures/mainnet-11-1013-manifest.json, BSC, one pinned block), checked from
# TAPI-20 §3.2-§3.6 alone: the calldata is re-encoded here, every result ABI-decoded here, the manifest bytes hashed and
# parsed, and the delegation's EIP-712 digest recomputed and recovered to the ownerOf answer (a raw EIP-712 digest, not
# the EIP-191 message of TAPI-21).
# 录下的主网回答（BSC，钉在一个区块上），只按 TAPI-20 §3.2-§3.6 的文字核对：调用数据在此重新编码，结果在此 ABI 解码，
# 清单字节在此哈希并解析，委托的 EIP-712 摘要在此重算并恢复出 ownerOf 的回答（原始 EIP-712 摘要，不是 TAPI-21 的 EIP-191）。
MF = json.loads((HERE.parent.parent / 'sdk' / 'test' / 'fixtures' / 'mainnet-11-1013-manifest.json').read_text(), parse_int=_no_negative_zero_int)
HUB, FACTORY, SITE_REGISTRY = '0xe61a9c7213a6aa616c246a2b569e555b417b25ee', '0x68224f668083c29e9800be2a646d42d18cedf7e2', '0xd006ffdd5ae313b17729621a00999cd3c71ce5e6'

def sel(signature):
    return keccak256(signature.encode())[:4]

def w_uint(n):
    return int(n).to_bytes(32, 'big')

def w_str(s):
    b = s.encode()
    return w_uint(len(b)) + b + bytes(-len(b) % 32)

def word(data, i):
    return data[32 * i:32 * i + 32]

def dyn_bytes(data, offset):
    n = int.from_bytes(data[offset:offset + 32], 'big')
    return data[offset + 32:offset + 32 + n]

def mf_call(prefix):
    hits = [c for c in MF['calls'].values() if c['data'].startswith(prefix)]
    return hits[0] if len(hits) == 1 else None

key = MF['manifest']['key']
want_calls = {
    'cpuAt': (FACTORY, sel('cpuAt(uint256)') + w_uint(MF['processor'])),
    'accountOf': (HUB, sel('accountOf(address,uint256)') + addr32(MF['circuits']) + w_uint(MF['tokenId'])),
    'isCPU': (FACTORY, sel('isCPU(address)') + addr32(MF['circuits'])),
    'ownerOf': (MF['circuits'].lower(), sel('ownerOf(uint256)') + w_uint(MF['tokenId'])),
    'fileInfo': (SITE_REGISTRY, sel('fileInfo(address,string)') + addr32(MF['container']) + w_uint(64) + w_str(key)),
    'read': (SITE_REGISTRY, sel('read(address,string)') + addr32(MF['container']) + w_uint(64) + w_str(key)),
}
R = {}
for fn, (to, data) in want_calls.items():
    c = mf_call(h(data))
    check('tapi20-6.1/%s calldata re-encoded here is recorded exactly once' % fn, c is not None, True)
    if c is None: continue
    check('tapi20-6.1/%s target' % fn, c['to'].lower(), to)
    check('tapi20-6.1/%s answered by >= quorum operators' % fn, len(set(c['operators'])) >= MF['rpc']['quorum'], True)
    R[fn] = bytes.fromhex(c['result'][2:])
check('tapi20-6.1/no unexplained calls', len(MF['calls']), len(want_calls))
check('tapi20-6.1/name', MF['name'], '%s.%d.tape' % (MF['tokenId'], MF['processor']))
check('tapi20-6.1/cpuAt(1013) is the circuits', h(R['cpuAt'][12:32]), MF['circuits'].lower())
check('tapi20-6.1/accountOf is the container', h(R['accountOf'][12:32]), MF['container'].lower())
check('tapi20-6.1/isCPU(circuits) is true', int.from_bytes(R['isCPU'], 'big'), 1)
check('tapi20-6.1/ownerOf is the holder', h(R['ownerOf'][12:32]), MF['holder'].lower())
fi = R['fileInfo']
fi_size, fi_hash = int.from_bytes(word(fi, 0), 'big'), h(word(fi, 2))
check('tapi20-6.1/fileInfo.size', fi_size, MF['manifest']['size'])
check('tapi20-6.1/fileInfo.contentType', dyn_bytes(fi, int.from_bytes(word(fi, 1), 'big')).decode(), MF['manifest']['contentType'])
check('tapi20-6.1/fileInfo.sha256Hash', fi_hash, MF['manifest']['sha256Hash'].lower())
mbytes = dyn_bytes(R['read'], int.from_bytes(word(R['read'], 0), 'big'))
check('tapi20-6.1/read length equals fileInfo.size', len(mbytes), fi_size)
check('tapi20-6.1/sha256(read bytes) equals fileInfo.sha256Hash', '0x' + hashlib.sha256(mbytes).hexdigest(), fi_hash)
check('tapi20-6.1/bytesSha256 recorded', MF['manifest']['bytesSha256'], fi_hash)
mj = strict_parse(mbytes.decode('utf-8'))
check('tapi20-6.1/manifest.circuits', mj['circuits'].lower(), MF['circuits'].lower())
check('tapi20-6.1/manifest.tokenId', mj['tokenId'], MF['tokenId'])
check('tapi20-6.1/manifest.container', mj['container'].lower(), MF['container'].lower())
check('tapi20-6.1/manifest.signer', mj['signer'], MF['manifest']['signer'])
check('tapi20-6.1/manifest.delegation', mj['delegation'], MF['manifest']['delegation'])
# §3.4: the digest names the container and the signer, anchored on the BNB Chain DeWebHub, and recovers to the holder.
dom = eip712_domain('TapeAPI', '1', 56, HUB)
sh = keccak256(keccak256(b'Delegation(address container,address signer,uint64 expires)') + addr32(mj['container']) + addr32(mj['signer']) + u64(mj['delegation']['expires']).rjust(32, b'\x00'))
check('tapi20-6.1/delegation recovers to ownerOf at the block', recover_address(typed_digest(dom, sh), mj['delegation']['sig']), MF['holder'].lower())
exp, ts = mj['delegation']['expires'], MF['block']['timestamp']
check('tapi20-6.1/delegation live at the block, within 366 days', ts < exp <= ts + 366 * 86400, True)
check('tapi20-6.1/block hash is 32 bytes', len(bytes.fromhex(MF['block']['hash'][2:])), 32)
# TAPI-23 §6 cites this manifest: record that it offers no attestedRead method. / TAPI-23 §6 引用此清单：它没有 attestedRead 方法。
check('tapi20-6.1/manifest offers no TAPI-23 attestedRead method', any('attestedRead' in m for m in mj['methods']), False)

# ======================================================= TAPI-23 §6 two providers, one attested read ====
# Each envelope's TAPI-21 digest is rebuilt here and its signer recovered; agreement is then decided by the text of
# §3.4 step 4 alone and compared with each case's expectation. / 每个信封的 TAPI-21 摘要在此重建并恢复签名者；
# 然后只按 §3.4 第 4 步的文字判定一致，再与各用例的期望比较。
AR = load_vec('tapi-23-attested.json')
PA, PB = AR['providers']
check('tapi23/test keys are declared as such', 'TEST KEYS' in AR['testKeys'], True)
check('tapi23/different containers', PA['container'].lower() != PB['container'].lower(), True)
check('tapi23/different signers', PA['signerAddress'].lower() != PB['signerAddress'].lower(), True)
check('tapi23/different origins', PA['endpoint'].split('/')[2] != PB['endpoint'].split('/')[2], True)
check('tapi23/descriptor kind', AR['descriptor']['attestedRead'], {'kind': 'eth_call', 'chains': [AR['request']['params']['chainId']]})
RESULT_FIELDS = {'chainId', 'blockNumber', 'blockHash', 'stateRoot', 'blockRef', 'result'}

def agree(x, y):
    if any(x.get(k) != y.get(k) for k in ('chainId', 'blockNumber', 'blockHash', 'result')): return False
    return not ('stateRoot' in x and 'stateRoot' in y and x['stateRoot'] != y['stateRoot'])

rq = AR['request']
for c in AR['cases']:
    for side, p in (('a', PA), ('b', PB)):
        e = c[side]['envelope']
        d = response_digest('TAPI-1/resp/v2', p['container'], rq['id'], rq['method'], rq['params'], True, e['result'], e['ts'])
        check('tapi23/%s/%s digest' % (c['name'], side), h(d), c[side]['digest'])
        check('tapi23/%s/%s signer' % (c['name'], side), recover_address(eip191(d), e['sig']), p['signerAddress'].lower())
        check('tapi23/%s/%s only §3.3 fields' % (c['name'], side), set(e['result']) <= RESULT_FIELDS, True)
        check('tapi23/%s/%s echoes chainId and block' % (c['name'], side), (e['result']['chainId'], e['result']['blockNumber']), (rq['params']['chainId'], rq['params']['block']))
    got = 'agree' if agree(c['a']['envelope']['result'], c['b']['envelope']['result']) else 'ATTEST_DISAGREE'
    check('tapi23/%s verdict' % c['name'], got, c['expect'])
check('tapi23/at least one agreeing and one disagreeing case', {c['expect'] for c in AR['cases']}, {'agree', 'ATTEST_DISAGREE'})

# ======================================================= TAPI-20 §3.10 manifest content signature ====
# contentHash = keccak256(UTF-8(canonicalJSON(manifest without contentSig))); ManifestContent(address container,bytes32
# contentHash) in the delegation's EIP-712 domain; the holder's ECDSA signature recovers to the holder.
# contentHash 为去掉 contentSig 的清单的规范 JSON 的 keccak256；在委托的 EIP-712 域中签署 ManifestContent。
CS = load_vec('tapi-20-content.json')
d = CS['domain']
dom = eip712_domain(d['name'], d['version'], d['chainId'], d['verifyingContract'])
th = keccak256(CS['typeHash'].encode())
check('content/type string', CS['typeHash'], 'ManifestContent(address container,bytes32 contentHash)')
def content_hash(m):
    return keccak256(canonical({k: v for k, v in m.items() if k != CS['field']}).encode())
for c in CS['cases']:
    m = c['manifest']
    check('content/%s canonical' % c['name'], canonical(m), c['canonical'])
    ch = content_hash(m)
    check('content/%s contentHash' % c['name'], h(ch), c['contentHash'])
    check('content/%s contentSig is outside the hash' % c['name'], h(content_hash(c['published'])), c['contentHash'])
    sh = keccak256(th + addr32(m['container']) + ch)
    check('content/%s structHash' % c['name'], h(sh), c['structHash'])
    dg = typed_digest(dom, sh)
    check('content/%s digest' % c['name'], h(dg), c['digest'])
    check('content/%s signer' % c['name'], recover_address(dg, c['sig']), CS['holderAddress'].lower())
check('content/cases differ', CS['cases'][0]['contentHash'] != CS['cases'][1]['contentHash'], True)
mv = CS['moved']
moved_digest = typed_digest(dom, keccak256(th + addr32(CS['cases'][1]['manifest']['container']) + bytes.fromhex(CS['cases'][1]['contentHash'][2:])))
got = recover_address(moved_digest, mv['sig'])
check('content/moved signature recovers elsewhere', got, mv['recoversTo'].lower())
check('content/moved signature is not the holder', got != CS['holderAddress'].lower(), True)

# ============================================ TAPI-20 §3.2 (informative) Merkle proofs, EIP-1186 ====
# Written from the Yellow Paper (appendices B and D) and EIP-1186. Nibble paths are hex strings here; a trie is rebuilt
# from its key/value pairs to check ethereum/tests' roots, and proofs are walked against a root.
# 照黄皮书附录 B、D 与 EIP-1186 编写。半字节路径在这里用十六进制字符串表示；由键值对重建树以核对 ethereum/tests 的根，再对照根走一遍证明。
class ProofError(Exception):
    pass

def rlp_enc(x):
    def head(n, short, long_):
        if n < 56:
            return bytes([short + n])
        ln = n.to_bytes((n.bit_length() + 7) // 8, 'big')
        return bytes([long_ + len(ln)]) + ln
    if isinstance(x, (bytes, bytearray)):
        x = bytes(x)
        return x if len(x) == 1 and x[0] < 0x80 else head(len(x), 0x80, 0xb7) + x
    body = b''.join(rlp_enc(i) for i in x)
    return head(len(body), 0xc0, 0xf7) + body

# Lists nest at most 64 deep, as in the SDK (FIXED PROOFR-3): a list embedded in a trie node is under 32 bytes and each
# level costs a header byte, so a node holds at most 32 levels; deeper input raised a bare RecursionError here.
# 列表嵌套至多 64 层，与 SDK 相同（FIXED PROOFR-3）：树节点里内嵌的列表不足 32 字节、每层至少一个头字节，节点至多 32 层；
# 更深的输入原先在这里抛裸 RecursionError。
RLP_MAX_DEPTH = 64

def rlp_dec(data):
    """Canonical RLP only. Lists come back as tuples (encoded_length, [items])."""
    def length_of(pos, n, end):
        if n == 0 or pos + n > end or data[pos] == 0:
            raise ProofError('rlp: bad long length')
        v = int.from_bytes(data[pos:pos + n], 'big')
        if v < 56:
            raise ProofError('rlp: long form below 56')
        return v
    def item(pos, end, depth):
        if pos >= end:
            raise ProofError('rlp: truncated')
        b = data[pos]
        if b < 0x80:
            return data[pos:pos + 1], pos + 1
        if b < 0xc0:
            if b < 0xb8:
                start, n = pos + 1, b - 0x80
            else:
                k = b - 0xb7; n = length_of(pos + 1, k, end); start = pos + 1 + k
            if start + n > end:
                raise ProofError('rlp: string overruns')
            if n == 1 and data[start] < 0x80:
                raise ProofError('rlp: wrapped single byte')
            return data[start:start + n], start + n
        if b < 0xf8:
            start, n = pos + 1, b - 0xc0
        else:
            k = b - 0xf7; n = length_of(pos + 1, k, end); start = pos + 1 + k
        if start + n > end:
            raise ProofError('rlp: list overruns')
        if depth >= RLP_MAX_DEPTH:
            raise ProofError('rlp: lists nested too deep')
        out, q = [], start
        while q < start + n:
            it, q = item(q, start + n, depth + 1)
            out.append(it)
        return (start + n - pos, out), start + n
    it, end = item(0, len(data), 0)
    if end != len(data):
        raise ProofError('rlp: trailing bytes')
    return it

def _hp_encode(nib, leaf):
    flag = (2 if leaf else 0) + (len(nib) & 1)
    s = ('%x' % flag) + ('' if len(nib) & 1 else '0') + nib
    return bytes.fromhex(s)

def trie_root(pairs):
    """pairs: {nibble-hex-path: value bytes}. The root hash, built top-down."""
    def node(items, depth):
        if not items:
            return None
        if len(items) == 1:
            (k, v), = items.items()
            return [_hp_encode(k[depth:], True), v]
        common = 0
        keys = list(items)
        while all(len(k) > depth + common for k in keys) and len({k[depth + common] for k in keys}) == 1:
            common += 1
        if common:
            return [_hp_encode(keys[0][depth:depth + common], False), ref(node(items, depth + common))]
        slots = []
        for d in '0123456789abcdef':
            sub = {k: v for k, v in items.items() if len(k) > depth and k[depth] == d}
            slots.append(ref(node(sub, depth + 1)) if sub else b'')
        return slots + [items.get(keys[0][:depth], b'') if any(len(k) == depth for k in keys) else b'']
    def ref(n):
        e = rlp_enc(n)
        return n if len(e) < 32 else keccak256(e)
    root = node({k: v for k, v in pairs.items() if v}, 0)
    return keccak256(rlp_enc(root if root is not None else b''))

EMPTY_ROOT = keccak256(rlp_enc(b''))

def walk_proof(root, key_path, proof, secure):
    """The value under key_path (nibble hex), or None when the proof shows it absent. Raises ProofError."""
    def node_bytes(n):
        if not isinstance(n, str) or not re.fullmatch(r'0x(?:[0-9a-fA-F]{2})*', n):
            raise ProofError('proof node is not 0x-hex')
        return bytes.fromhex(n[2:])
    if not isinstance(proof, list):
        raise ProofError('proof is not a list')
    nodes = [node_bytes(n) for n in proof]
    if root == EMPTY_ROOT:
        if nodes in ([], [b'\x80']):
            return None
        raise ProofError('nodes for an empty trie')
    want, inline, i, rest = root, None, 0, key_path
    def finish(v):
        if i != len(nodes):
            raise ProofError('unused proof nodes')
        return v
    while True:
        if inline is not None:
            items, inline = inline, None
        else:
            if i == len(nodes):
                raise ProofError('proof too short')
            if keccak256(nodes[i]) != want:
                raise ProofError('hash mismatch at node %d' % i)
            dec = rlp_dec(nodes[i]); i += 1
            if not isinstance(dec, tuple):
                raise ProofError('node is not a list')
            items = dec[1]
        def descend(r):
            nonlocal want, inline
            if isinstance(r, tuple):
                if r[0] >= 32:
                    raise ProofError('embedded node too long')
                inline = r[1]
            elif len(r) == 32:
                want = r
            else:
                raise ProofError('bad reference')
        if len(items) == 17:
            if isinstance(items[16], tuple) or any(not isinstance(c, tuple) and len(c) not in (0, 32) for c in items[:16]):
                raise ProofError('bad branch')
            if not rest:
                if secure:
                    raise ProofError('secure key ends in a branch')
                return finish(items[16] or None)
            if secure and items[16]:
                raise ProofError('branch value in a secure trie')
            child = items[int(rest[0], 16)]; rest = rest[1:]
            if not isinstance(child, tuple) and len(child) == 0:
                return finish(None)
            descend(child)
        elif len(items) == 2:
            enc = items[0]
            if isinstance(enc, tuple) or not enc:
                raise ProofError('bad path')
            hx = enc.hex(); flag = int(hx[0], 16)
            if flag > 3 or (flag % 2 == 0 and hx[1] != '0'):
                raise ProofError('bad hex prefix')
            seg = hx[1:] if flag % 2 else hx[2:]
            if flag >= 2:
                if isinstance(items[1], tuple) or not items[1]:
                    raise ProofError('leaf without value')
                if rest == seg:
                    return finish(items[1])
                if secure and len(seg) != len(rest):
                    raise ProofError('secure leaf of the wrong length')
                return finish(None)
            if not seg:
                raise ProofError('empty extension')
            if not rest.startswith(seg):
                return finish(None)
            rest = rest[len(seg):]
            descend(items[1])
        else:
            raise ProofError('node of %d items' % len(items))

def account_and_slots(state_root, acc):
    ans = acc['answer']
    addr = bytes.fromhex(acc['address'][2:])
    leaf = walk_proof(state_root, keccak256(addr).hex(), ans['accountProof'], True)
    if leaf is None:
        exists, sroot, chash = False, EMPTY_ROOT, keccak256(b'')
    else:
        dec = rlp_dec(leaf)
        if not isinstance(dec, tuple) or len(dec[1]) != 4:
            raise ProofError('account is not four items')
        nonce, bal, sroot, chash = dec[1]
        if len(sroot) != 32 or len(chash) != 32 or any(isinstance(x, tuple) for x in dec[1]):
            raise ProofError('bad account fields')
        exists = True
        if int(ans['storageHash'], 16) != int.from_bytes(sroot, 'big'):
            raise ProofError('storageHash differs from the account')
    values = {}
    for slot in acc['slots']:
        n = int(slot, 16)
        entries = [e for e in ans['storageProof'] if int(e['key'], 16) == n]
        if len(entries) != 1:
            raise ProofError('slot answered %d times' % len(entries))
        raw = walk_proof(sroot, keccak256(n.to_bytes(32, 'big')).hex(), entries[0]['proof'], True)
        v = 0
        if raw is not None:
            w = rlp_dec(raw)
            if isinstance(w, tuple) or not w or len(w) > 32 or w[0] == 0:
                raise ProofError('storage value not canonical')
            v = int.from_bytes(w, 'big')
        if int(entries[0]['value'], 16) != v:
            raise ProofError('claimed value differs')
        values['0x%x' % n] = '0x%x' % v
    return {'exists': exists, 'storageRoot': h(sroot), 'codeHash': h(chash), 'values': values}

PV = load_vec('tapi-20-proof.json')
def _tb(s):
    return bytes.fromhex(s[2:]) if s.startswith('0x') else s.encode('utf-8')
for c in PV['trie']:
    nib = lambda k: (keccak256(k) if c['secure'] else k).hex()
    built = trie_root({nib(_tb(k)): _tb(v) for k, v in c['in'].items()})
    check('proof/trie/%s/%s root rebuilt' % (c['file'], c['name']), h(built), c['root'])
    for pr in c['proofs']:
        key = bytes.fromhex(pr['key'][2:])
        check('proof/trie/%s/%s path of %s' % (c['file'], c['name'], pr['key']), '0x' + nib(key), pr['path'])
        try:
            got = walk_proof(bytes.fromhex(c['root'][2:]), nib(key), pr['proof'], c['secure'])
            got = None if got is None else h(got)
        except ProofError as e:
            got = 'error: %s' % e
        check('proof/trie/%s/%s value of %s' % (c['file'], c['name'], pr['key']), got, pr['value'])
        # the proven value is the one in `in` (None for a key not there) / 证明出的值就是 `in` 里的那个（不在其中为 None）
        want = next((_tb(v) for k, v in c['in'].items() if _tb(k) == key and v), None)
        check('proof/trie/%s/%s membership of %s' % (c['file'], c['name'], pr['key']), got, None if want is None else h(want))
# RLP nesting is bounded as in the SDK (FIXED PROOFR-3): 64 nested lists decode, 65 or 5000 are a ProofError, never a
# RecursionError. / RLP 嵌套上限与 SDK 相同：64 层列表可解码，65 层或 5000 层是 ProofError，绝不是 RecursionError。
def _nested(lists):
    enc = b'\xc0'
    for _ in range(lists - 1):
        n = len(enc)
        enc = (bytes([0xc0 + n]) if n < 56 else bytes([0xf7 + (n.bit_length() + 7) // 8]) + n.to_bytes((n.bit_length() + 7) // 8, 'big')) + enc
    return enc
def _refused(data):
    try:
        rlp_dec(data)
        return False
    except ProofError:
        return True
check('proof/rlp 64 nested lists decode', _refused(_nested(64)), False)
check('proof/rlp 65 nested lists are refused', _refused(_nested(65)), True)
check('proof/rlp 5000 nested lists are refused, not a RecursionError', _refused(_nested(5000)), True)
check('proof/trie cases have keys absent from their trie', any(p['value'] is None for c in PV['trie'] for p in c['proofs']), True)
check('proof/trie has non-secure and secure cases', {c['secure'] for c in PV['trie']}, {True, False})

MN = PV['mainnet']
sroot = bytes.fromhex(MN['block']['stateRoot'][2:])
results = []
for idx, acc in enumerate(MN['accounts']):
    try:
        got = account_and_slots(sroot, acc)
    except ProofError as e:
        got = 'error: %s' % e
    results.append(got)
    check('proof/mainnet/account %d %s' % (idx, acc['address']), got, acc['expect'])
# the layouts, computed here, name the slots the proofs were asked for / 这里算出的布局正是证明所请求的槽
def u256(x):
    return int(x, 16).to_bytes(32, 'big') if isinstance(x, str) else x.to_bytes(32, 'big')
L = MN['layoutCheck']
site = int.from_bytes(keccak256(u256(L['container']) + u256(1)), 'big')
base = int.from_bytes(keccak256(keccak256(L['path'].encode()) + u256((site + 2) % 2**256)), 'big')
check('proof/layout fileInfo size slot', '0x%x' % ((base + 1) % 2**256), L['fileInfo']['size'])
check('proof/layout fileInfo sha256Hash slot', '0x%x' % ((base + 2) % 2**256), L['fileInfo']['sha256Hash'])
ns = int.from_bytes(keccak256(u256(int.from_bytes(keccak256(b'openzeppelin.storage.ERC721'), 'big') - 1)), 'big') & ~0xff
check('proof/layout ownerOf slot (ERC-7201 openzeppelin.storage.ERC721 + 2)', '0x%x' % int.from_bytes(keccak256(u256(int(L['tokenId'])) + u256(ns + 2)), 'big'), L['ownerOf'])
check('proof/layout cpuAt element', '0x%x' % ((int.from_bytes(keccak256(u256(6)), 'big') + int(L['processor'])) % 2**256), L['cpuAt']['element'])
check('proof/layout isCPU slot', '0x%x' % int.from_bytes(keccak256(u256(int('0xe02c26c7432A7121168AA9B610DE24eCf9a1a414', 16)) + u256(7)), 'big'), L['isCPU'])
# the proven words say what the nodes answered by eth_call / 已证明的字与节点 eth_call 的回答一致
proven = {}
for r in results:
    if isinstance(r, dict):
        proven.update(r['values'])
R = MN['reads']
check('proof/mainnet proven ownerOf', '0x' + ('%040x' % (int(proven[L['ownerOf']], 16) & (2**160 - 1))), R['ownerOf'])
check('proof/mainnet proven cpuAt(1013)', '0x' + ('%040x' % (int(proven[L['cpuAt']['element']], 16) & (2**160 - 1))), R['cpuAt'])
check('proof/mainnet proven isCPU', int(proven[L['isCPU']], 16) == 1, R['isCPU'])
check('proof/mainnet proven size (low 32 bits)', int(proven[L['fileInfo']['size']], 16) & 0xffffffff, R['size'])
check('proof/mainnet proven sha256Hash', '0x%064x' % int(proven[L['fileInfo']['sha256Hash']], 16), R['sha256Hash'])
# every single-byte change is refused / 每个单字节改动都被拒绝
refused = 0
for m in MN['mutations']:
    acc = json.loads(json.dumps(MN['accounts'][m['account']]))
    lst = acc['answer']['accountProof'] if m['list'] == 'accountProof' else acc['answer']['storageProof'][int(m['list'].split('.')[1])]['proof']
    b = bytearray.fromhex(lst[m['node']][2:]); b[m['byte']] ^= m['xor']; lst[m['node']] = '0x' + b.hex()
    try:
        account_and_slots(sroot, acc)
    except ProofError:
        refused += 1
check('proof/mainnet every mutation refused', refused, len(MN['mutations']))
wrong = bytes.fromhex(MN['wrongRoot']['stateRoot'][2:])
bad_root = 0
for acc in MN['accounts']:
    try:
        account_and_slots(wrong, acc)
    except ProofError:
        bad_root += 1
check('proof/mainnet a wrong stateRoot refuses every account', bad_root, len(MN['accounts']))

# ================================================ Container agents, phase 0 (experimental) ====
# Written from EIP-712 and the field lists below (internal design notes, phase 0): the holder's four types in the TAP-11
# delegation domain. encodeType appends referenced struct types; a struct array hashes as keccak256 of the concatenated
# hashStruct of its items, a bytes32 array as keccak256 of the concatenated elements, an empty one as keccak256("").
# 只按 EIP-712 与下面的字段表实现：持有人的四个类型，在 TAP-11 委托域中。
ca = load_vec('container-agent.json')
d = ca['domain']
ca_dom = eip712_domain(d['name'], d['version'], d['chainId'], d['verifyingContract'])
def ca_word(n):
    return int(n).to_bytes(32, 'big')
def ca_b32(x):
    b = bytes.fromhex(x[2:])
    assert len(b) == 32
    return b
CA_FIELDS = {
    'Scope': [('address', 'provider'), ('address', 'token'), ('uint256', 'cap')],
    'Mandate': [('address', 'principal'), ('address', 'agent'), ('address', 'agentKey'), ('uint8', 'mode'), ('bytes32', 'taskHash'),
                ('Scope[]', 'scope'), ('address', 'feeToken'), ('uint256', 'feeCap'), ('uint64', 'notBefore'), ('uint64', 'expires'),
                ('uint256', 'nonce'), ('bool', 'subdelegate')],
    'TaskOffer': [('address', 'principal'), ('address', 'agent'), ('bytes32', 'taskHash'), ('uint8', 'mode'), ('address', 'feeToken'),
                  ('uint256', 'fee'), ('uint64', 'deadline'), ('uint64', 'exp'), ('uint256', 'nonce')],
    'TaskVerdict': [('bytes32', 'mandateHash'), ('bytes32', 'deliverableHash'), ('uint8', 'verdict'), ('bytes32', 'reasonHash'), ('uint64', 'issued')],
    'MandateRevocation': [('address', 'principal'), ('bytes32[]', 'mandateHashes'), ('uint64', 'revokedBefore'), ('uint64', 'issued')],
}
def ca_type(name):
    own = '%s(%s)' % (name, ','.join('%s %s' % f for f in CA_FIELDS[name]))
    refs = sorted({t[:-2] if t.endswith('[]') else t for t, _ in CA_FIELDS[name]} & set(CA_FIELDS) - {name})
    return own + ''.join(ca_type(r) for r in refs)
ca_th = {n: keccak256(ca_type(n).encode()) for n in CA_FIELDS}
for n in CA_FIELDS:
    check('agent/encodeType ' + n, ca_type(n), ca['types'][n])
    check('agent/typehash ' + n, h(ca_th[n]), ca['typeHashes'][n])
def ca_struct(name, v):
    out = ca_th[name]
    for t, f in CA_FIELDS[name]:
        x = v[f]
        if t == 'address': out += addr32(x)
        elif t == 'bytes32': out += ca_b32(x)
        elif t == 'bool': out += ca_word(1 if x else 0)
        elif t.startswith('uint'): out += ca_word(x)
        elif t == 'Scope[]': out += keccak256(b''.join(ca_struct('Scope', s) for s in x))
        elif t == 'bytes32[]': out += keccak256(b''.join(ca_b32(e) for e in x))
        else: raise ValueError(t)
    return keccak256(out)
t = ca['task']
check('agent/task canonical', canonical(t['value']), t['canonical'])
check('agent/taskHash', h(keccak256(canonical(t['value']).encode('utf-8'))), t['taskHash'])
for c in ca['mandates']:
    for i, s in enumerate(c['scope']):
        check('agent/mandate scope hash %d/%s' % (i, c['name']), h(ca_struct('Scope', s)), c['intermediate']['scopeHashes'][i])
    sh = ca_struct('Mandate', c)
    check('agent/mandate structHash/' + c['name'], h(sh), c['intermediate']['structHash'])
    check('agent/mandate digest/' + c['name'], h(typed_digest(ca_dom, sh)), c['digest'])
oc = ca['otherChain']
check('agent/mandate on another chain', h(typed_digest(eip712_domain(d['name'], d['version'], oc['chainId'], d['verifyingContract']), ca_struct('Mandate', ca['mandates'][oc['mandate']]))), oc['digest'])
check('agent/another chain gives another hash', str(oc['digest'] != ca['mandates'][oc['mandate']]['digest']), 'True')
for key, name in [('offers', 'TaskOffer'), ('verdicts', 'TaskVerdict'), ('revocations', 'MandateRevocation')]:
    for c in ca[key]:
        sh = ca_struct(name, c)
        check('agent/%s structHash/%s' % (name, c['name']), h(sh), c['structHash'])
        check('agent/%s digest/%s' % (name, c['name']), h(typed_digest(ca_dom, sh)), c['digest'])
# none of the holder's agent types shares a typehash with the other types of the same domain (or the voucher's)
other = [b'Delegation(address container,address signer,uint64 expires)',
         b'ChannelKeys(address container,bytes32 x25519,bytes32 ed25519,bytes32 inbox,uint64 issued,uint64 expires)',
         b'ManifestContent(address container,bytes32 contentHash)',
         b'Voucher(address consumer,address provider,uint256 cumulative,uint64 expires)']
allth = list(ca_th.values()) + [keccak256(o) for o in other]
check('agent/every typehash in the hub domain differs', len(set(allth)), len(allth))


# ---------- revocation in a thread (draft TAP §7.4-§7.6), an independent model over abstract cases ----------
# Written from the draft text alone: the six messages reduced to the facts the state machine and the revocation rules
# read (times, the mandate's window, whether the mandate is refused). R comes from a first pass without the
# message-after-revocation checks; a second pass applies them and its problems are reported. Their order (the second
# pass in message order, then the problems of the revocation messages) is the reference implementation's; the draft
# does not fix one. The final checks put Cancelled before Expired. / 只按草稿文字实现的抽象模型；问题顺序是本实现的，草稿未规定。
tr = ca['threadRevocation']

def tr_pass(c, R):
    probs, st = [], None
    acc = mand = last = None
    site = None
    for name in c['messages']:
        k, _, idx = name.partition(':')
        if k == 'revocation':
            continue
        if k == 'offer':
            if st is not None: probs.append('out-of-order'); continue
            st = 'Offered'
        elif k == 'accept':
            if st != 'Offered': probs.append('out-of-order'); continue
            a = c['accept']
            if a['ts'] > c['offer']['exp']: probs.append('offer-expired'); continue
            if a['ts'] > R: probs.append('message-after-revocation'); continue
            acc, st = a, 'Accepted'
        elif k == 'mandate':
            if st != 'Accepted': probs.append('out-of-order'); continue
            m = c['mandate']
            if m['refused']: probs.append(m['refused']); continue
            mand, st = m, 'Active'
            sr = c['site']
            if sr and ('mandate' in sr['hashes'] or m['notBefore'] < sr['revokedBefore']):
                site = sr['issued']
        elif k == 'deliver':
            if st not in ('Active', 'Rejected'): probs.append('out-of-order'); continue
            d = dict(c['deliveries'][int(idx)], index=int(idx))
            if d['ts'] > R: probs.append('message-after-revocation'); continue
            if not (mand['notBefore'] <= d['ts'] <= mand['expires']): probs.append('deliver-outside-mandate'); continue
            if d['exp'] < d['ts']: probs.append('message-malformed'); continue
            if d['ts'] < acc['ts']: probs.append('deliver-before-accept'); continue
            if d['ts'] > c['offer']['deadline']: probs.append('deliver-after-deadline')
            last, st = d, 'Delivered'
        elif k == 'acceptance':
            if st != 'Delivered': probs.append('out-of-order'); continue
            v = c['verdict']
            if v['of'] != last['index']: probs.append('verdict-mismatch'); continue
            if v['issued'] < last['ts']: probs.append('verdict-before-delivery'); continue
            st = 'Settled' if v['verdict'] == 1 else 'Rejected'
    return {'problems': probs, 'state': st, 'accept': acc, 'mandate': mand, 'last': last, 'site': site}

def tr_thread(c):
    first = tr_pass(c, float('inf'))
    rprobs, times = [], []
    for name in c['messages']:
        k, _, idx = name.partition(':')
        if k != 'revocation':
            continue
        r = c['revocations'][int(idx)]
        m = first['mandate']
        applies = ('mandate' in r['hashes'] or m['notBefore'] < r['revokedBefore']) if m else r['revokedBefore'] > 0
        if not applies: rprobs.append('revocation-mismatch'); continue
        times.append((r['issued'], 'message'))
    if first['site'] is not None:
        times.append((first['site'], 'site'))
    R = min(times, key=lambda t: t[0]) if times else None
    p2 = tr_pass(c, R[0]) if R else first
    st, at = p2['state'], c['at']
    if st in ('Offered', 'Accepted', 'Active') and R and R[0] <= at: st = 'Cancelled'
    elif st == 'Offered' and at > c['offer']['exp']: st = 'Expired'
    elif st == 'Accepted' and at > p2['accept']['exp']: st = 'Expired'
    elif st == 'Active' and at > p2['mandate']['expires']: st = 'Expired'
    return {'R': R[0] if R else None, 'via': R[1] if R else None, 'state': st, 'problems': p2['problems'] + rprobs}

tr_out = []
for c in tr['cases']:
    got = tr_thread(c)
    tr_out.append(got)
    check('thread-revocation/R/' + c['name'], (got['R'], got['via']), (c['expect']['R'], c['expect']['via']))
    check('thread-revocation/state/' + c['name'], got['state'], c['expect']['state'])
    check('thread-revocation/problems/' + c['name'], got['problems'], c['expect']['problems'])
for a, b in tr['sameResult']:
    check('thread-revocation/message and site list give the same result %d %d' % (a, b), (tr_out[a]['state'], tr_out[a]['problems'], tr_out[a]['R']), (tr_out[b]['state'], tr_out[b]['problems'], tr_out[b]['R']))


# ---------- input forms (draft TAP §3.7, §7.2 steps 1-3, §8), 1.8: an independent form checker ----------
# Written from the tables of the draft alone (the JSON forms of §3.7, the field rules of §3.2-§3.5, the receipt members of
# §7.2 and §8 with TAP-13 §3-§4): not a port of the SDK. A Python bool is an int, so it is refused explicitly wherever a
# number is expected. / 只按草稿的表格实现的形式检查，不是 SDK 的移植；Python 的 bool 是 int，所以凡要数字处都明确拒绝 bool。
import re as _re
_ADDR = _re.compile(r'^0x[0-9a-fA-F]{40}$')
_B32 = _re.compile(r'^0x[0-9a-f]{64}$')
_DEC = _re.compile(r'^(0|[1-9][0-9]*)$')
_SIG65 = _re.compile(r'^0x[0-9a-fA-F]{130}$')
_SEGMENT = _re.compile(r'^[A-Za-z_][A-Za-z0-9_]{0,63}$')
_Z20 = '0x' + '00' * 20
_Z32 = '0x' + '00' * 32
# (named _num until the reviews section: it shadowed canonical's number formatter for every later canonical() call)
def _is_int(x): return isinstance(x, int) and not isinstance(x, bool)
def f_addr(x, nonzero=False): return isinstance(x, str) and bool(_ADDR.match(x)) and not (nonzero and x.lower() == _Z20)
def f_b32(x, nonzero=False): return isinstance(x, str) and bool(_B32.match(x)) and not (nonzero and x == _Z32)
def f_u8(x, allowed): return _is_int(x) and x in allowed
def f_u64(x): return _is_int(x) and 0 <= x <= 2 ** 53 - 1
def f_u256(x): return isinstance(x, str) and bool(_DEC.match(x)) and int(x) < 2 ** 256
def f_bool(x): return isinstance(x, bool)
def f_obj(x): return isinstance(x, dict)
def holder_form(t, v):
    if not f_obj(v): return False
    if t == 'Mandate':
        sc = v.get('scope')
        return (f_addr(v.get('principal'), True) and f_addr(v.get('agent'), True) and f_addr(v.get('agentKey'), True)
                and f_u8(v.get('mode'), (0, 1)) and f_b32(v.get('taskHash'), True)
                and isinstance(sc, list) and len(sc) <= 16
                and all(f_obj(i) and f_addr(i.get('provider'), True) and f_addr(i.get('token')) and f_u256(i.get('cap')) for i in sc)
                and f_addr(v.get('feeToken')) and f_u256(v.get('feeCap')) and f_u64(v.get('notBefore')) and f_u64(v.get('expires'))
                and f_u256(v.get('nonce')) and f_bool(v.get('subdelegate')) and v['expires'] > v['notBefore'])
    if t == 'TaskOffer':
        return (f_addr(v.get('principal'), True) and f_addr(v.get('agent'), True) and f_b32(v.get('taskHash'), True)
                and f_u8(v.get('mode'), (0, 1)) and f_addr(v.get('feeToken')) and f_u256(v.get('fee'))
                and f_u64(v.get('deadline')) and f_u64(v.get('exp')) and f_u256(v.get('nonce')))
    if t == 'TaskVerdict':
        return (f_b32(v.get('mandateHash'), True) and f_b32(v.get('deliverableHash'), True) and f_u8(v.get('verdict'), (1, 2))
                and f_b32(v.get('reasonHash')) and f_u64(v.get('issued')))
    if t == 'MandateRevocation':
        mh = v.get('mandateHashes')
        return (f_addr(v.get('principal'), True) and isinstance(mh, list) and len(mh) <= 24 and all(f_b32(h, True) for h in mh)
                and f_u64(v.get('revokedBefore')) and f_u64(v.get('issued')))
    raise ValueError(t)
def f_id(x, empty=False): return isinstance(x, str) and (empty or len(x) > 0) and len(x.encode('utf-16-le')) // 2 <= 128   # 1..128 code units; "" only under TAP-13 §8 binding rule 1 (ok false)
def agent_message_outcome(r, kind, agent):
    if not (f_obj(r) and r.get('v') == 1 and f_obj(r.get('service')) and f_addr(r['service'].get('container'))
            and r.get('ok') is True and f_obj(r.get('result'))):
        return 'message-malformed'
    if not (isinstance(r.get('method'), str) and _SEGMENT.match(r['method']) and ('params' not in r or f_obj(r['params']))
            and f_id(r.get('id')) and isinstance(r.get('sig'), str) and _SIG65.match(r['sig'])):
        return 'message-malformed'
    if r['service']['container'].lower() != agent.lower():
        return 'agent-mismatch'
    if r['result'].get('kind') != 'tape.agent/' + kind or not f_u64(r.get('ts')) or not f_u64(r['result'].get('exp')):
        return 'message-malformed'
    return 'ok'
def hash_only_outcome(r):
    good = (f_obj(r) and r.get('v') == 2 and f_obj(r.get('service')) and f_addr(r['service'].get('container'))
            and f_b32(r.get('requestHash')) and f_b32(r.get('bodyHash')) and f_u64(r.get('ts')) and f_bool(r.get('ok'))
            and f_id(r.get('id'), r.get('ok') is False) and isinstance(r.get('sig'), str) and bool(_SIG65.match(r['sig'])))
    return 'ok' if good else 'receipt-not-hash-only'
inf = ca['inputForms']
for c in inf['cases']:
    if c['type'] in ('Mandate', 'TaskOffer', 'TaskVerdict', 'MandateRevocation'):
        got = 'ok' if holder_form(c['type'], c['value']) else ('mandate-malformed' if c['type'] == 'Mandate' else 'message-malformed')
    elif c['type'] == 'agentMessage':
        got = agent_message_outcome(c['value'], c['kind'], c['agent'])
    elif c['type'] == 'hashOnlyReceipt':
        got = hash_only_outcome(c['value'])
    else:
        raise ValueError(c['type'])
    check('input-forms/%s/%s' % (c['type'], c['name']), got, c['expect'])


# ---------- container agents, phase 1 (experimental): the static rules and the plan ----------
# The static rules are written from the internal design notes, phase 1, §5.1-§5.2; the order of the static problems
# is the reference implementation's (the draft fixes none). The plan (p1_plan below) was, up to M3, close to a port of
# the SDK's escrowPlan (review p1m3 R2 said so); it is now a table of rules written from §6.1 S4 and §2.3-§2.5, every
# rule evaluated, the first in the draft's order reported. The ORDER is still the draft's, which the SDK follows too.
# 阶段 1（实验）：静态规则按设计稿 §5.1–§5.2 实现（问题顺序取参考实现的）。计划段到 M3 为止近乎 SDK 的移植（审查 p1m3 R2 指出）；
# 现按 §6.1 S4 与 §2.3–§2.5 重写为规则表：全部求值，按设计稿顺序取第一条。顺序本身仍是设计稿的，SDK 也照此实现。
p1v = ca['phase1']
def p1_funded(m):
    return any(s['cap'] != '0' or s['token'].lower() != _Z20 for s in m['scope']) or m['feeCap'] != '0' or m['feeToken'].lower() != _Z20
def p1_phase0(m):
    out = []
    if p1_funded(m): out.append('phase0-no-funds')
    if m['subdelegate']: out.append('subdelegate-not-allowed')
    return out
def p1_static(m):
    out = []
    for s in m['scope']:
        if (s['token'].lower() == _Z20) != (s['cap'] == '0'): out.append('scope-token-cap-mismatch')
    if (m['feeToken'].lower() == _Z20) != (m['feeCap'] == '0'): out.append('fee-token-cap-mismatch')
    capped = [s['provider'].lower() for s in m['scope'] if s['cap'] != '0']
    reported = set()
    for s in m['scope']:
        k = s['provider'].lower()
        if capped.count(k) > 1 and k not in reported:
            out.append('scope-duplicate-provider'); reported.add(k)
    if m['mode'] == 0 and any(s['cap'] != '0' or s['token'].lower() != _Z20 for s in m['scope']): out.append('mode-scope-mismatch')
    if m['subdelegate']: out.append('subdelegate-not-allowed')
    return out
P1_BLOCKS_NONCE = {'phase0-no-funds', 'subdelegate-not-allowed', 'scope-token-cap-mismatch', 'fee-token-cap-mismatch', 'scope-duplicate-provider', 'mode-scope-mismatch'}
for c in p1v['static']:
    m, e = c['mandate'], c['expect']
    funded = p1_funded(m)
    probs = p1_static(m) if funded else p1_phase0(m)
    warns = ['scope-includes-agent' for s in m['scope'] if s['cap'] != '0' and s['provider'].lower() == m['agent'].lower()] if funded else []
    check('phase1/static/funded/' + c['name'], funded, e['funded'])
    check('phase1/static/without the switch/' + c['name'], p1_phase0(m), e['withoutSwitch'])
    check('phase1/static/phase/' + c['name'], 1 if funded else 0, e['phase'])
    check('phase1/static/problems/' + c['name'], probs, e['problems'])
    check('phase1/static/warnings/' + c['name'], warns, e['warnings'])
    check('phase1/static/nonce/' + c['name'], not any(p in P1_BLOCKS_NONCE for p in probs), e['recordsNonce'])

AUDITED = {56: []}   # chains.js AUDITED_ESCROWS: none is audited yet / 尚无已审计托管
MAX_SESSION = 30 * 86400
# The plan (§6.1 S4, §2.3-§2.5), rewritten after review p1m3 R2. Each refusal is a rule written from the draft's text:
# a predicate over the case's facts that says whether the rule applies, evaluated for EVERY rule (none depends on an
# earlier one having passed); the refusal reported is the first applicable rule in the order §6.1 S4 lists them
# ("计划拒绝的输入，按此顺序"), transcribed below. So the structure is not the SDK's (which stops at its first throw), but
# the ORDER is the draft's and therefore the SDK's too: an order both got wrong would be caught only by the vectors' hand-
# written expectations. The steps are built from §2.5 steps 1-4 and the budget of a re-run from §10.4 B1.
# 计划段（审查 p1m3 R2 后重写）：每条拒绝都是按设计稿文字写的谓词，全部求值（互不依赖前一条通过），报告 §6.1 S4 所列顺序中第一条适用的。
# 结构不是 SDK 的；顺序抄自设计稿，因此与 SDK 相同：两边都错的顺序只有手写的向量期望能抓住。
P1_PLAN_ORDER_GLOBAL = ['static', 'nothing-to-plan', 'session-expired', 'session-too-long', 'holder-not-current', 'holder-changed-since-signing',
                        'principal-not-deployed', 'principal-not-opened', 'execute-fee-too-high', 'holder-short-of-fee',
                        'execute-reverts', 'key-reused', 'pin-not-after-record']
P1_PLAN_ORDER_ITEM = ['agent-key-on-fee-channel', 'provider-is-consumer', 'provider-is-escrow', 'provider-unresolvable',
                      'escrow-not-allowed', 'escrow-other-chain', 'escrow-token-mismatch', 'funded-elsewhere', 'other-path-funded', 'withdraw-pending',
                      'channel-exceeds-cap', 'key-already-authorised', 'channel-spent', 'channel-exceeds-budget',
                      'budget-exhausted', 'channel-session-live']
def p1_mandate_hash(m, base):
    return h(typed_digest(eip712_domain(ca['domain']['name'], ca['domain']['version'], base['chainId'], base['hub']), ca_struct('Mandate', m)))
def p1_plan(c, base):
    m, facts, path = c['mandate'], c.get('facts', {}), c['path']
    lo = lambda a: a.lower() if isinstance(a, str) else a
    now, hist = c.get('now'), c.get('history')
    holder = base['holder'] if path == 'holder' else c.get('holder', base['holder'])   # S6: both paths have a holder
    consumer = lo(base['holder'] if path == 'holder' else m['principal'])
    capped = [s for s in m['scope'] if s['cap'] != '0']
    mh = p1_mandate_hash(m, base) if hist is not None else None
    expires = m['expires']
    # an entry of the history that is this mandate's: its hash, or (from the logs, no hash) one of its channels for this
    # consumer ending at its expires (§2.4, §10.3 e) / 属于本授权书的历史条目
    def ours(e):
        if e['mandateHash'] is not None: return lo(e['mandateHash']) == mh
        return lo(e['consumer']) == consumer and e['expires'] == expires and lo(e['provider']) in {lo(s['provider']) for s in capped}
    static = p1_static(m) if p1_funded(m) else []
    glob = {
        'static': bool(static),
        'nothing-to-plan': not p1_funded(m) or not capped,
        'session-expired': now is not None and expires <= now,
        'session-too-long': now is not None and expires > now + MAX_SESSION,
        'holder-not-current': 'currentHolder' in facts and holder is not None and lo(holder) != lo(facts['currentHolder']),
        # review p1m3 recheck 3: the mandate's signer (the holder when it was signed) is not the plan's holder, or null
        # 复核 3：签署人（签署时的持有人）不是本计划的 holder，或为 null
        'holder-changed-since-signing': 'signer' in facts and (facts['signer'] is None or lo(facts['signer']) != lo(holder)),
        'principal-not-deployed': path == 'container' and facts.get('principalDeployed') is False,
        'principal-not-opened': path == 'container' and facts.get('principalOpened') is False,
        # the case's maxExecuteFee, else planBase's (an executeFee without one is an input error, review p1m3 recheck)
        'execute-fee-too-high': path == 'container' and int(base['executeFee']) > int(facts.get('maxExecuteFee', base['maxExecuteFee'])),
        # review p1m3 S4: the holder cannot pay even one execute's fee / 持有人连一笔 execute 的费都付不起
        'holder-short-of-fee': path == 'container' and 'holderBalance' in facts and int(base['executeFee']) > 0 and int(facts['holderBalance']) < int(base['executeFee']),
        'execute-reverts': path == 'container' and facts.get('executeReverts') is not None,
        'key-reused': hist is not None and any(e['chainId'] == base['chainId'] and lo(e['key']) == lo(m['agentKey']) and not ours(e) for e in hist),
        # review p1m3 recheck 3: a record at or after the pinned block, of this mandate (its key, any channel) or on a
        # channel this plan funds (the item's escrow, this consumer, its provider) / 不早于钉块的记录：本授权书的，或本计划所充通道的
        'pin-not-after-record': hist is not None and 'pinBlock' in facts and any(
            e['chainId'] == base['chainId'] and e.get('block') is not None and e['block'] >= facts['pinBlock'] and (
                (lo(e['key']) == lo(m['agentKey']) and ours(e)) or
                any(lo(e['provider']) == lo(s['provider']) and lo(e['consumer']) == consumer and lo(e['escrow']) == lo(next((p['escrow'] for p in c['providers'] if lo(p['provider']) == lo(s['provider'])), None)) for s in capped))
            for e in hist),
    }
    for code in P1_PLAN_ORDER_GLOBAL:
        if glob[code]: return {'refused': static[0] if code == 'static' else code}
    allowed = {lo(a) for a in AUDITED.get(base['chainId'], []) + base['allowEscrows']}
    by = {lo(e['provider']): e for e in c['providers']}
    named = {lo(by[lo(s['provider'])].get('escrow')) for s in capped if by.get(lo(s['provider']), {}).get('escrow')}
    items = []
    for i, s in enumerate(capped):
        e, prov, cap = by[lo(s['provider'])], lo(s['provider']), int(s['cap'])
        esc, tok = lo(e.get('escrow')), lo(e.get('token'))
        ch, session = int(e.get('channel', '0')), int(e.get('session', 0))
        claimed = None if e.get('claimed') is None else int(e['claimed'])
        # this session's own history entries with claimedAtPlan (§10.4 B1): same chain, escrow, consumer, provider, key,
        # expires, and a hash that is this mandate's or none / 本会话自己的、带 claimedAtPlan 的历史条目
        starts = [int(x['claimedAtPlan']) for x in (hist or []) if x.get('claimedAtPlan') is not None and x['chainId'] == base['chainId']
                  and lo(x['escrow']) == esc and lo(x['consumer']) == consumer and lo(x['provider']) == prov and lo(x['key']) == lo(m['agentKey'])
                  and x['expires'] == expires and (x['mandateHash'] is None or lo(x['mandateHash']) == mh)]
        applied = session == expires   # the key's session is already this mandate's: the plan was applied / 计划已应用过
        budgeted = applied and bool(starts) and claimed is not None
        # review p1m3 recheck (§10.5): the cap is per (mandate, provider). The history's entries of this mandate (ours) for
        # this provider on ANOTHER channel (escrow, consumer); such a channel is released only when its consumer is this
        # plan's, the history has its claimedAtPlan, and the case's `elsewhere` fact for it says channel 0, no live request,
        # with its claimedOf. What the key spent on the released channels counts toward this channel's budget.
        # 复核（§10.5）：cap 按（授权书, provider）计。历史里本授权书在另一条通道上的条目；只有同一 consumer、有 claimedAtPlan、
        # 事实显示余额 0 且无存活请求并给出 claimedOf 时才放行；放行通道上钥匙花掉的计入本通道预算。
        others = {}
        for x in (hist or []):
            if x['chainId'] == base['chainId'] and lo(x['provider']) == prov and lo(x['key']) == lo(m['agentKey']) and ours(x) and (lo(x['escrow']), lo(x['consumer'])) != (esc, consumer):
                others.setdefault((lo(x['escrow']), lo(x['consumer'])), []).append(x)
        seen = {(lo(f['escrow']), lo(f['consumer'])): f for f in e.get('elsewhere', [])}
        def base_of(xs): return min([int(x['claimedAtPlan']) for x in xs if x.get('claimedAtPlan') is not None], default=None)
        def released(k, xs):
            f = seen.get(k)
            return (k[1] == consumer and base_of(xs) is not None and f is not None and f.get('claimed') is not None
                    and int(f.get('channel', '0')) == 0 and not f.get('pendingLive'))
        blocked = any(not released(k, xs) for k, xs in others.items())
        spent_else = 0 if blocked else sum(int(seen[k]['claimed']) - base_of(xs) for k, xs in others.items())
        spent_here = claimed - min(starts) if budgeted else 0
        budget = max(cap - spent_else - spent_here, 0)
        earlier_tokens = {lo(by[lo(x['provider'])].get('escrow')): lo(by[lo(x['provider'])].get('token')) for x in reversed(capped[:i]) if by[lo(x['provider'])].get('escrow')}
        rules = {
            'agent-key-on-fee-channel': prov == lo(m['agent']),
            'provider-is-consumer': prov == consumer,
            'provider-is-escrow': prov in named,
            'provider-unresolvable': esc is None,
            'escrow-not-allowed': esc is not None and esc not in allowed,
            'escrow-other-chain': e.get('escrowCode') is False,
            'escrow-token-mismatch': tok is None or tok != lo(s['token']) or (esc in earlier_tokens and earlier_tokens[esc] != tok),
            'funded-elsewhere': blocked,
            # review p1m3 S1: the other funding path's channel to this provider holds money or a session of this key
            'other-path-funded': 'otherPath' in e and (int(e['otherPath'].get('channel', '0')) != 0 or int(e['otherPath'].get('session', 0)) != 0),
            'withdraw-pending': bool(e.get('pendingLive')),
            'channel-exceeds-cap': ch > cap,
            'key-already-authorised': session not in (0, expires),
            # review p1m3 recheck (2): without this session's claimedAtPlan, a claimedOf above 0 is never taken as the baseline
            'channel-spent': applied and not budgeted and (ch < cap or (not starts and claimed not in (None, 0))),
            'channel-exceeds-budget': ch > budget,
            # review p1m3 recheck 3 (N2): nothing left of the cap on a fresh channel: no session alone on an empty channel
            'budget-exhausted': budget == 0 and ch == 0 and session == 0,
            'channel-session-live': hist is not None and any(x['chainId'] == base['chainId'] and lo(x['escrow']) == esc and lo(x['consumer']) == consumer
                                                             and lo(x['provider']) == prov and lo(x['key']) != lo(m['agentKey']) and x['expires'] >= now for x in hist),
        }
        for code in P1_PLAN_ORDER_ITEM:
            if rules[code]: return {'refused': code}
        start = min(starts) if applied and starts else claimed   # the history's baseline is kept, claimed or not / 沿用历史基线
        items.append({'prov': prov, 'esc': esc, 'need': budget - ch, 'session': session, 'claimedAtPlan': None if start is None else str(start), 'spentElsewhere': str(spent_else)})
    # §2.5 steps 1-3: per escrow (in the order first named) one approve of what its channels need; a fund per channel that
    # needs anything; an authorizeSession per channel without the key's session; step 4: an allowance check per approve
    # §2.5 第 1–3 步与第 4 步
    escrows = list(dict.fromkeys(it['esc'] for it in items))
    approves = [(x, sum(it['need'] for it in items if it['esc'] == x)) for x in escrows]
    steps = [['approve', x, None, str(n)] for x, n in approves if n]
    steps += [['fund', it['esc'], it['prov'], str(it['need'])] for it in items if it['need']]
    steps += [['authorizeSession', it['esc'], it['prov'], None] for it in items if it['session'] == 0]
    fee = int(base['executeFee'])
    # review p1m3 S4, last: the holder must pay the fee of every execute of the plan / 最后：持有人须付得起计划中每笔 execute 的费
    if path == 'container' and 'holderBalance' in facts and int(facts['holderBalance']) < fee * len(steps): return {'refused': 'holder-short-of-fee'}
    return {'steps': steps, 'checks': [x for x, n in approves if n], 'to': 'principal' if path == 'container' else 'direct',
            'claimedAtPlan': [it['claimedAtPlan'] for it in items], 'spentElsewhere': [it['spentElsewhere'] for it in items],
            'recordBlock': [facts.get('pinBlock') for it in items],
            'fees': {'perExecute': str(fee), 'executes': len(steps), 'total': str(fee * len(steps))} if path == 'container' else None,
            # review p1m3 recheck 3: a history left out is not an empty one / 没给历史不等于空历史
            'checked': {'history': hist is not None, 'signer': 'signer' in facts}}
low = lambda v: v.lower() if isinstance(v, str) else v
for c in p1v['plan']:
    got, e = p1_plan(c, p1v['planBase']), c['expect']
    if 'refused' in e:
        check('phase1/plan/refused/' + c['name'], got.get('refused'), e['refused'])
        continue
    check('phase1/plan/steps/' + c['name'], got.get('steps'), [[row[0], low(row[1]), low(row[2]), row[3]] for row in e['steps']])
    check('phase1/plan/checks/' + c['name'], got.get('checks'), [low(x) for x in e['checks']])
    check('phase1/plan/to/' + c['name'], got.get('to'), e['to'])
    if 'claimedAtPlan' in e: check('phase1/plan/claimedAtPlan/' + c['name'], got.get('claimedAtPlan'), e['claimedAtPlan'])
    if 'spentElsewhere' in e: check('phase1/plan/spentElsewhere/' + c['name'], got.get('spentElsewhere'), e['spentElsewhere'])
    if 'fees' in e: check('phase1/plan/fees/' + c['name'], got.get('fees'), e['fees'])
    if 'checked' in e: check('phase1/plan/checked/' + c['name'], got.get('checked'), e['checked'])
    if 'recordBlock' in e: check('phase1/plan/recordBlock/' + c['name'], got.get('recordBlock'), e['recordBlock'])

# ---------- phase 1, M3: the close-out (§2.3 rule 6, §2.6) and the read-back after a plan (§2.5 step 4) ----------
# Written from the draft and TapeAPIEscrow.sol (requestWithdraw replaces a request and restarts its clock; withdraw pays
# min(requested, channel) inside [requestedAt + 48 h, + 7 d]). Its refusal order is the draft's (§6.1 S4), which the
# SDK follows too; only the hand-written expectations would catch an order both got wrong. / 按设计稿与合约文字实现；拒绝顺序取设计稿的。
def p1_close(c, cb):
    m = c['mandate']
    facts = c.get('facts', {})
    holder = cb['holder'] if c['path'] == 'holder' else c.get('holder')
    if c['path'] == 'container' and 'currentHolder' in facts and holder is not None and holder.lower() != facts['currentHolder'].lower(): return {'refused': 'holder-not-current'}
    if c['path'] == 'container' and int(cb['executeFee']) > int(facts.get('maxExecuteFee', cb['maxExecuteFee'])): return {'refused': 'execute-fee-too-high'}
    fee = int(cb['executeFee'])
    if c['path'] == 'container' and 'holderBalance' in facts and fee > 0 and int(facts['holderBalance']) < fee: return {'refused': 'holder-short-of-fee'}
    if c['path'] == 'container' and facts.get('executeReverts') is not None: return {'refused': 'execute-reverts'}
    # review p1m3 S2: the history's sessions of this mandate name the consumer that funded / 历史里本授权书的会话写明出资的 consumer
    m_ = c['mandate']
    consumer = (cb['holder'] if c['path'] == 'holder' else m_['principal']).lower()
    capped_ = {s['provider'].lower() for s in m_['scope'] if s['cap'] != '0'}
    rec = [x for x in c.get('history', []) if x['chainId'] == cb['chainId'] and x['key'].lower() == m_['agentKey'].lower() and x['expires'] == m_['expires'] and x['provider'].lower() in capped_]
    if rec and not any(x['consumer'].lower() == consumer for x in rec): return {'refused': 'consumer-unknown'}
    if any(e['escrow'] is None for e in c['channels']): return {'refused': 'escrow-unknown'}
    now, cool, win = cb['now'], cb['cooldown'], cb['window']
    by = {e['provider'].lower(): e for e in c['channels']}
    reqs, wds, items, windows = [], [], [], {}
    for s in [x for x in m['scope'] if x['cap'] != '0']:
        e = by[s['provider'].lower()]
        ch = int(e['channel'])
        p = e.get('pending') or {}
        amt, at = int(p.get('amount', 0)), int(p.get('requestedAt', 0))
        prov = s['provider'].lower()
        if ch == 0: items.append([prov, 'empty', None, '0']); continue
        live = at != 0 and now <= at + cool + win
        if live and not (c.get('fullRequest') and amt < ch):   # S5: fullRequest replaces a request for less / 全额重新请求
            out = min(amt, ch)
            items.append([prov, 'requested', str(out), str(ch - out)]); wds.append(['withdraw', prov, None]); windows[prov] = (at + cool, at + cool + win)
            continue
        items.append([prov, 'replace' if live else 'lapsed' if at != 0 else 'request', str(ch), '0'])
        reqs.append(['requestWithdraw', prov, str(ch)]); wds.append(['withdraw', prov, None])
    if not reqs and not wds: return {'refused': 'nothing-to-close'}
    n = len(reqs) + len(wds)
    if c['path'] == 'container' and 'holderBalance' in facts and int(facts['holderBalance']) < fee * n: return {'refused': 'holder-short-of-fee'}
    return {'steps': reqs + wds, 'items': items, 'windows': windows, 'to': 'principal' if c['path'] == 'container' else 'direct',
            'fees': {'perExecute': str(fee), 'executes': n, 'total': str(fee * n)} if c['path'] == 'container' else None,
            'checked': {'history': 'history' in c}}
for c in p1v['closeOut']:
    got, e = p1_close(c, p1v['closeOutBase']), c['expect']
    if 'refused' in e:
        check('phase1/closeOut/refused/' + c['name'], got.get('refused'), e['refused'])
        continue
    check('phase1/closeOut/steps/' + c['name'], got.get('steps'), [[r[0], low(r[1]), r[2]] for r in e['steps']])
    check('phase1/closeOut/items/' + c['name'], got.get('items'), [[low(r[0]), r[1], r[2], r[3]] for r in e['items']])
    for prov, a, b in e.get('windows', []):
        check('phase1/closeOut/window/' + c['name'], got['windows'].get(prov.lower()), (a, b))
    check('phase1/closeOut/to/' + c['name'], got.get('to'), e['to'])
    if 'fees' in e: check('phase1/closeOut/fees/' + c['name'], got.get('fees'), e['fees'])
    if 'checked' in e: check('phase1/closeOut/checked/' + c['name'], got.get('checked'), e['checked'])
for c in p1v['applied']:
    pc = p1v['plan'][c['plan']]
    plan = p1_plan(pc, p1v['planBase'])
    m, rd = pc['mandate'], c['readings']
    allow = {a['escrow'].lower(): int(a['allowance']) for a in rd['allowances']}
    chans = {x['provider'].lower(): x for x in rd['channels']}
    probs, zero, causes = [], [], []
    for esc in plan['checks']:
        if allow[esc] != 0: probs.append('allowance-not-zero'); zero.append(esc)
    for i, s in enumerate([x for x in m['scope'] if x['cap'] != '0']):
        r = chans[s['provider'].lower()]
        start = plan['claimedAtPlan'][i]
        # review p1m3 B1: what the key spent since the plan counts toward the cap / 钥匙自计划以来花掉的计入 cap
        spent = 0 if start is None else int(r['claimed']) - int(start)
        # review p1m3 recheck: after a release the channel is compared with what is left of the cap / 放行后按 cap 的余量比较
        target = max(int(s['cap']) - int(plan['spentElsewhere'][i]), 0)
        if int(r['channel']) + spent != target:
            probs.append('channel-not-at-cap')
            # review p1m3 recheck (3): above is excess; below, a fund that failed leaves its allowance, else withdrawn or never sent
            # 复核建议 3：超出即 excess；不足时失败的 fund 会留下额度，否则是取回或没发
            esc = [x for x in plan['steps'] if x[0] == 'fund' and x[2] == s['provider'].lower()]
            esc = esc[0][1] if esc else None
            if start is not None:
                causes.append('excess' if int(r['channel']) + spent > target else 'fund-failed' if allow.get(esc, 0) != 0 else 'withdrawn-or-not-sent')
        if int(r['session']) != m['expires']: probs.append('session-not-set')
    check('phase1/applied/problems/' + c['name'], probs, c['expect']['problems'])
    check('phase1/applied/approveZero/' + c['name'], zero, [x.lower() for x in c['expect']['approveZero']])
    if 'causes' in c['expect']: check('phase1/applied/causes/' + c['name'], causes, c['expect']['causes'])

# review p1m3 recheck 3 (N3): the session history, one entry per session; a later record only fills a null
# claimedAtPlan; a log entry (no hash) of a session kept with its hash adds nothing. Written from the rule text.
# 复核 3（N3）：会话历史每会话一条；之后的记录只填 null 的 claimedAtPlan；无哈希的日志条目对带哈希的会话不新增。按规则文字实现。
def p1_session_key(e, with_hash=True):
    return (e['chainId'], e['escrow'].lower(), e['consumer'].lower(), e['provider'].lower(), e['key'].lower(), e['expires'],
            (e['mandateHash'].lower() if e['mandateHash'] is not None else None) if with_hash else None)
for c in p1v.get('history', []):
    kept = []
    for e in c['records']:
        same = [x for x in kept if p1_session_key(x) == p1_session_key(e)]
        if same:
            if same[0]['claimedAtPlan'] is None and e.get('claimedAtPlan') is not None: same[0]['claimedAtPlan'] = e['claimedAtPlan']
            if e.get('block') is not None and (same[0]['block'] is None or e['block'] > same[0]['block']): same[0]['block'] = e['block']
            continue
        if e['mandateHash'] is None and any(p1_session_key(x, False) == p1_session_key(e, False) for x in kept): continue
        kept.append(dict(e, claimedAtPlan=e.get('claimedAtPlan'), block=e.get('block')))
    got = [[x['escrow'].lower(), x['mandateHash'], x['claimedAtPlan'], x['block']] for x in kept]
    check('phase1/history/' + c['name'], [g[:len(w)] for g, w in zip(got, c['expect'])] if len(got) == len(c['expect']) else got, [[w[0].lower()] + list(w[1:]) for w in c['expect']])


# ---------- phase 1: the channel mapping (§3b.2 items 2-7) and the lifetime of a withdraw request (R21) ----------
# Written from §3b.2, §2.4 and §2.6 alone: the chain state of each abstract case is read the way the draft says a verifier
# reads it, and the problems, warnings and enforcement compared with what the case requires. Not a port of the SDK.
# 阶段 1：通道映射核验与提现请求的存活，只按设计稿 §3b.2、§2.4、§2.6 的文字实现，不是 SDK 的移植。
LIFETIME = 48 * 3600 + 7 * 86400
def p1_live(requested_at, now): return requested_at != 0 and now <= requested_at + LIFETIME
lv = p1v['liveness']
check('phase1/liveness/lifetime', LIFETIME, p1v['mapping']['times']['lifetime'])
for at, now, live in lv['cases']:
    check('phase1/liveness/%d at %d' % (at, now), p1_live(at, now), live)
TOKENS_WITH_DECIMALS = {'A': 8, 'B': 18}   # C answers no decimals() / C 没有 decimals()
def p1_channel(party, token, consumer_kind, now, probs, unresolvable):
    if party is None or party.get('manifest') in ('none', 'no-escrow'):
        probs.append(unresolvable); return None
    e = party['escrow']
    if not e['listed']: probs.append('escrow-not-allowed'); return None
    if not e['code']: probs.append('escrow-other-chain'); return None
    if e['token'] != token: probs.append('escrow-token-mismatch'); return None
    st = party.get(consumer_kind) or {'channel': '0', 'session': 0, 'pending': None, 'claimed': '0'}
    pend = st.get('pending') or ['0', 0]
    live = p1_live(pend[1], now)
    avail = max(0, int(st['channel']) - (int(pend[0]) if live else 0))
    return {'channel': int(st['channel']), 'session': st['session'], 'live': live, 'available': str(avail), 'decimals': TOKENS_WITH_DECIMALS.get(token)}
T1 = p1v['mapping']['times']
for c in p1v['mapping']['cases']:
    now, expires = c.get('at', T1['N']), T1['expires']
    kind = 'principal' if c['path'] == 'container' else 'holder'
    probs, warns, readings = [], [], []
    for item in c['scope']:
        r = p1_channel(c['chain'].get(item['provider']), item['token'], kind, now, probs, 'provider-unresolvable')
        readings.append(r)
        if r is None: continue
        se = r['session']
        if se == 0 or se < now: probs.append('session-missing')
        elif se != expires: probs.append('session-expiry-mismatch')
        if r['live']: probs.append('withdraw-pending')
        if r['available'] == '0': probs.append('channel-empty')
        if r['channel'] > int(item['cap']): probs.append('channel-exceeds-cap')   # review p1m12 F2: fails closed / 失败关闭
    if c['fee']:
        r = p1_channel(c['chain'].get('agent'), c['fee']['token'], kind, now, probs, 'agent-unresolvable')
        if r is not None:
            if r['session'] != 0: probs.append('agent-key-on-fee-channel')
            if 'feeDue' in c and int(r['available']) < int(c['feeDue']): probs.append('fee-channel-short')
    e = c['expect']
    if now > expires: probs.insert(0, 'mandate-expired')   # the mandate's own window comes first / 授权书自身的时间窗先报
    check('phase1/mapping/problems/' + c['name'], probs, e['problems'])
    check('phase1/mapping/warnings/' + c['name'], warns, e['warnings'])
    check('phase1/mapping/enforcement/' + c['name'], 'escrow-channel' if not probs else 'none', e['enforcement'])
    if 'live' in e: check('phase1/mapping/live/' + c['name'], [r['live'] if r else None for r in readings], e['live'])
    if 'available' in e: check('phase1/mapping/available/' + c['name'], [r['available'] if r else None for r in readings], e['available'])
    if 'decimals' in e: check('phase1/mapping/decimals/' + c['name'], [r['decimals'] if r else None for r in readings], e['decimals'])


# ---------- phase 1, M4: the agent runtime's spend limiter (draft §3b.2, §6.1 S5, §10.7) ----------
# Written from the vectors' own rule text (phase1.rules.spend, phase1.rules.recheck) as a table of predicates: every rule is
# evaluated on the case and the first that applies, in the rule text's order, is the refusal. Not a port of the SDK; the
# order is the rule text's, which the SDK follows too, so an order wrong in both is caught only by the hand-written expect.
# 阶段 1 的 M4：代理运行时的花费限额器，按向量里的规则文字写成谓词表：全部求值，取规则文字顺序中第一条适用的。不是 SDK 的移植。
SPEND_STOP = {'spend-other-chain', 'spend-escrow-changed', 'spend-consumer-changed', 'spend-expired'}
def p1_spend(rec, rq):
    lo = lambda a: a.lower() if isinstance(a, str) else a
    pin = next((x for x in rec.get('providers', []) if lo(x['provider']) == lo(rq['provider'])), None)
    cum, price = int(rq['cumulative']), int(rq['price'])
    ceiling = int(pin['base']) + int(pin['cap']) if pin else None
    started = rec.get('state') == 'started'
    rules = [
        ('spend-not-started', not started),
        ('spend-stopped', started and rec.get('stopped') is not None),
        ('spend-other-chain', rq['chainId'] != rec['chainId']),
        ('spend-out-of-scope', pin is None),
        ('spend-escrow-changed', pin is not None and lo(rq['escrow']) != lo(pin['escrow'])),
        ('spend-consumer-changed', started and lo(rq['consumer']) != lo(rec['consumer'])),
        ('spend-not-yet', started and rq['now'] < rec['notBefore']),
        ('spend-expired', started and rq['now'] > rec['expires']),
        ('spend-bad-amount', price == 0 or cum == 0),
        # the per-call ceiling (Bruce, 2026-10-08): maxPrice when given, else floor(cap * 10 / 100); 0 is no default
        ('spend-call-price-ceiling-above-cap', pin is not None and rq.get('maxPrice') is not None and int(rq['maxPrice']) > int(pin['cap'])),
        ('spend-call-price-ceiling-unset', pin is not None and rq.get('maxPrice') is None and int(pin['cap']) * 10 // 100 == 0),
        ('spend-call-price-above-ceiling', pin is not None and price > (int(rq['maxPrice']) if rq.get('maxPrice') is not None else int(pin['cap']) * 10 // 100)),
        ('spend-cap-exceeded', ceiling is not None and cum > ceiling),
    ]
    for code, applies in rules:
        if applies: return {'refused': code, 'stop': code in SPEND_STOP}
    hi = max(int(pin['hi']), cum)
    return {'hi': str(hi), 'spent': str(hi - int(pin['base'])), 'remaining': str(ceiling - hi)}
for c in p1v['spend']:
    check('phase1/spend/' + c['name'], p1_spend(c['record'], c['request']), c['expect'])
def p1_recheck(rec, ck):
    lo = lambda a: a.lower() if isinstance(a, str) else a
    stop = []
    if ck.get('mandateHash') is not None and lo(ck['mandateHash']) != lo(rec['mandateHash']): stop.append('spend-mandate-changed')
    if 'mandate-revoked' in ck['problems']: stop.append('spend-revoked')
    if 'mandate-expired' in ck['problems']: stop.append('spend-expired')
    if ck.get('consumer') is not None and lo(ck['consumer']) != lo(rec['consumer']): stop.append('spend-consumer-changed')
    same_consumer = ck.get('consumer') is not None and lo(ck['consumer']) == lo(rec['consumer'])
    readings = {lo(x['provider']): x for x in ck.get('scope', [])}
    moved = False
    every_reading = True
    hi = []
    for p in rec['providers']:
        r = readings.get(lo(p['provider']))
        if r is None or r.get('escrow') is None or r.get('claimedAtCheck') is None: every_reading = False
        on_pin = r is not None and r.get('escrow') is not None and lo(r['escrow']) == lo(p['escrow'])
        if r is not None and r.get('escrow') is not None and not on_pin: moved = True
        counts = same_consumer and on_pin and r.get('claimedAtCheck') is not None
        hi.append(str(max(int(p['hi']), int(r['claimedAtCheck']) if counts else 0)))
    if moved: stop.append('spend-escrow-changed')
    problems = list(ck['problems'])
    # review p1m4: no problem of its own, yet not an enforced phase-1 check with every reading / 审查 p1m4
    if not problems and (ck.get('phase') != 1 or ck.get('enforcement') != 'escrow-channel' or not every_reading): problems.append('spend-not-enforced')
    return {'ok': not stop and not problems and ck['ok'] is True, 'stop': stop, 'problems': problems, 'hi': hi}
for c in p1v['recheck']:
    check('phase1/recheck/' + c['name'], p1_recheck(c['record'], c['check']), c['expect'])

# ---------- @experimental TAPI-22 §3.6 / TAP draft "Payment Vouchers" (TAPs#52): USD prices paid in BEM ----------
# Written from the draft's text: exact integer conversion (§4.3), the voucher with v of 27 or 28 only (§3.1), the signed
# answers that carry quotes and charge records (§4.4, §6, §7), and the reference-rate arithmetic (§4.5) in Decimal.
# 照草稿正文独立实现：精确整数换算、只收 v 为 27/28 的凭证、带报价与计费记录的签名回答、用 Decimal 算参考汇率。
from decimal import Decimal as _D, getcontext as _getcontext
_getcontext().prec = 120
usd = load_vec('tapi-22-usd.json')
_PRICE = re.compile(r'^[0-9]+(\.[0-9]{1,8})?$'); _RATE = re.compile(r'^[0-9]+(\.[0-9]{1,18})?$'); _AMT = re.compile(r'^[0-9]+\.[0-9]{8}$')
def _units(s, rx, d):
    if not isinstance(s, str) or not rx.match(s): return None
    i, _, f = s.partition('.')
    return int(i) * 10 ** d + int((f + '0' * d)[:d] or '0')
def _amount8(n):
    s = str(n).rjust(9, '0')
    return s[:-8] + '.' + s[-8:]
def usd_convert(p, r, c):
    U = _units(p, _PRICE, 8)
    if not U: return {'refused': 'priceUSD'}
    R = _units(r, _RATE, 18)
    if not R: return {'refused': 'rate'}
    P = _units(c, _PRICE, 8)
    if not P: return {'refused': 'priceBEM'}
    conv = (U * 10 ** 18 + R - 1) // R
    return {'U': str(U), 'R': str(R), 'P': str(P), 'converted': str(conv), 'charge': str(min(conv, P)), 'capped': conv > P,
            'usd': {'currency': 'USD', 'amount': _amount8(U)}, 'bem': {'currency': 'BEM', 'amount': _amount8(min(conv, P))}}
for c in usd['conversion']['cases']:
    got = usd_convert(c['priceUSD'], c['rate'], c['priceBEM'])
    check('usd/conversion/' + c['name'], got, {k: c[k] for k in got})
for c in usd['conversion']['invalid']:
    check('usd/conversion-refused/' + c['name'], usd_convert(c['priceUSD'], c['rate'], c['priceBEM']).get('refused'), c['refused'])

uv = usd['voucher']; d = uv['domain']
udom = eip712_domain(d['name'], d['version'], d['chainId'], d['verifyingContract'])
check('usd/voucher/domainSeparator', h(udom), uv['domainSeparator'])
check('usd/voucher/typeHash', h(keccak256(uv['type'].encode())), uv['typeHash'])
def voucher_struct(v):
    return keccak256(keccak256(uv['type'].encode()) + addr32(v['consumer']) + addr32(v['provider']) +
                     int(v['cumulative']).to_bytes(32, 'big') + u64(v['expires']).rjust(32, b'\x00'))
def recover_voucher(digest32, sig_hex):
    """§3.1: 65 bytes, v of 27 or 28 only (0 and 1 refused, unlike TAP-13 §5), r in [1, n-1], s in [1, n/2]."""
    sig = bytes.fromhex(sig_hex[2:])
    if len(sig) != 65: return 'length'
    if sig[64] not in (27, 28): return 'v'
    r, s = int.from_bytes(sig[:32], 'big'), int.from_bytes(sig[32:64], 'big')
    if not (0 < r < _SN and 0 < s <= _SN // 2): return 'r-or-s'
    return recover_address(digest32, sig_hex)
for c in uv['cases']:
    sh = voucher_struct(c); dg = typed_digest(udom, sh)
    check('usd/voucher-struct/' + c['name'], h(sh), c['structHash'])
    check('usd/voucher-digest/' + c['name'], h(dg), c['digest'])
    check('usd/voucher-signer/' + c['name'], recover_voucher(dg, c['sig']), c['recoversTo'].lower())
first = uv['cases'][0]; fdg = typed_digest(udom, voucher_struct(first))
for e in uv['refusedEncodingsOfCase1']:
    check('usd/voucher-refused/' + e['name'], recover_voucher(fdg, e['sig']), e['refused'])
    if 'recoversWhenUnchecked' in e:   # the high-s twin really is a valid signature of the same key / 高 s 孪生签名确是同一把钥匙的签名
        sig = bytes.fromhex(e['sig'][2:]); r, s, v = int.from_bytes(sig[:32], 'big'), int.from_bytes(sig[32:64], 'big'), sig[64] - 27
        y2 = (pow(r, 3, _SP) + 7) % _SP; y = pow(y2, (_SP + 1) // 4, _SP)
        if y & 1 != v: y = _SP - y
        ri = pow(r, -1, _SN); Q = _sec_add(_sec_mul(s * ri % _SN, (r, y)), _sec_mul((-int.from_bytes(fdg, 'big') * ri) % _SN, _SG))
        check('usd/voucher-highs-unchecked', '0x' + keccak256(Q[0].to_bytes(32, 'big') + Q[1].to_bytes(32, 'big'))[12:].hex(), e['recoversWhenUnchecked'].lower())

# canonical() reads the module-level _num, which a later section rebinds (line "def _num(x)"); these bodies hold only
# strings, booleans and safe integers, so a local copy of TAP-11 §6 for them / 局部的规范 JSON（只含字符串、布尔与安全整数）
def usd_canonical(v):
    if v is None or isinstance(v, bool): return canonical(v)
    if isinstance(v, int):
        assert abs(v) <= 2 ** 53 - 1
        return str(v)
    if isinstance(v, str): return _str(v)
    if isinstance(v, list): return '[' + ','.join(usd_canonical(x) for x in v) + ']'
    return '{' + ','.join(_str(k) + ':' + usd_canonical(v[k]) for k in sorted(v, key=_utf16_key)) + '}'
def usd_response_digest(container, id_, method, params, ok, body, ts):
    return keccak256(b'TAPI-1/resp/v2' + bytes.fromhex(container[2:]) + keccak256(id_.encode()) +
                     keccak256(usd_canonical({'method': method, 'params': params}).encode()) + (b'\x01' if ok else b'\x00') +
                     keccak256(usd_canonical(body).encode()) + u64(ts))
ue = usd['envelopes']; up = ue['manifestExcerpt']['usdPricing']; ucap = ue['manifestExcerpt']['methods'][0]['priceBEM']
def quote_ok(q, ts):
    return (isinstance(q, dict) and sorted(q) == ['asOf', 'rate', 'validUntil'] and bool(_units(q['rate'], _RATE, 18))
            and q['asOf'] <= ts and q['asOf'] < q['validUntil'] <= q['asOf'] + up['maxQuoteS'])
for c in ue['cases']:
    check('usd/envelope-canonical/' + c['name'], usd_canonical(c['body']), c['canonicalBody'])
    dg = usd_response_digest(ue['container'], c['id'], c['request']['method'], c['request']['params'], c['ok'], c['body'], c['ts'])
    check('usd/envelope-digest/' + c['name'], h(dg), c['digest'])
    check('usd/envelope-eip191/' + c['name'], h(eip191(dg)), c['eip191Digest'])
    check('usd/envelope-signer/' + c['name'], recover_address(eip191(dg), c['sig']), ue['signer'].lower())
    data = c['body']['charge'] if c['ok'] else c['body']['data']
    check('usd/envelope-quote/' + c['name'], quote_ok(data['quote'], c['ts']), True)
    price = up['methods']['search']
    if c['ok']:
        cv = usd_convert(price, data['rate'], ucap)
        # §7: amount = cumulative − last (last = 0 here), price = the manifest's, capped present exactly when it caps
        check('usd/charge-record/' + c['name'], (data['amount'], data['price'], 'capped' in data, data['cumulative']), (cv['bem'], cv['usd'], cv['capped'], cv['charge']))
    else:
        cv = usd_convert(price, data['quote']['rate'], ucap)
        check('usd/error-price/' + c['name'], (data['price'], data['priceUSD']), (cv['charge'], cv['usd']))
        if c['body']['code'] == 'BAD_VOUCHER':
            check('usd/error-reason/' + c['name'], data['reason'] in ('malformed', 'provider', 'expired', 'lifetime', 'signature', 'rate', 'stale', 'insufficient', 'funds'), True)

urs = usd['rateSource']
def usd_rate(t, bem0, du):
    p = _D('1.0001') ** t
    return p * _D(10) ** (8 - du) if bem0 else 1 / (p * _D(10) ** (du - 8))
_rates = []
for s in urs['constructed']:
    t = (int(s['tickCumulatives'][1]) - int(s['tickCumulatives'][0])) // s['window']   # floor: toward negative infinity
    check('usd/meanTick/' + s['name'], str(t), s['meanTick'])
    r = usd_rate(t, s['bemIsToken0'], s['usdDecimals'])
    check('usd/rate/' + s['name'], abs(r - _D(repr(s['rate']))) / r < _D('1e-9'), True)
    _rates.append(r)
_ref = (_rates[0] + _rates[1]) / 2
check('usd/median-of-two', abs(_ref - _D(repr(urs['referenceOfFirstTwo']))) / _ref < _D('1e-9'), True)
for c in urs['checks']:
    check('usd/check/%s @%d' % (c['name'], c['toleranceBps']), _D(c['rate']) * 10000 >= _ref * (10000 - c['toleranceBps']), c['accepted'])
for r in urs['recordedReads']['reads']:
    check('usd/recorded/' + r['pool'], str((int(r['tickCumulatives'][1]) - int(r['tickCumulatives'][0])) // r['window']), r['meanTick'])

# phase 1, restart: may an order resume with the key its vault opened (phase1.rules.resume), predicates in the rule's order
# 阶段 1 的重启：能否恢复订单，按规则文字顺序的谓词
def p1_resume(rec, rq):
    lo = lambda a: a.lower() if isinstance(a, str) else a
    key, mh = rq['key'], rq.get('mandateHash')
    started = rec is not None and rec.get('state') == 'started'
    rules = [
        ('spend-state-lost', rec is None),
        ('spend-stopped', rec is not None and rec.get('stopped') is not None),
        ('spend-key-lost', key == 'missing'),
        ('spend-key-unreadable', key == 'unreadable'),
        ('spend-key-mismatch', rec is not None and (rq['chainId'] != rec['chainId'] or lo(rq['agentKey']) != lo(rec['agentKey']) or lo(key) != lo(rec['agentKey']))),
        ('spend-resume-mismatch', rec is not None and ((started and (mh is None or lo(mh) != lo(rec['mandateHash']))) or (not started and mh is not None))),
    ]
    for code, applies in rules:
        if applies: return {'ok': False, 'refused': code}
    return {'ok': True}
for c in p1v['resume']:
    check('phase1/resume/' + c['name'], p1_resume(c['record'], c['request']), c['expect'])

# ---------- phase 1, M7: the spend statement of a delivery and its reconciliation (draft §2.3 rule 5, §6.1 S8, R16) ----------
# Written from the vectors' rule text (phase1.rules.statement, phase1.rules.evidence) as predicates, not ported from the
# SDK: the order is the rule text's, which the SDK follows too, so an order wrong in both is caught only by the
# hand-written expect. Addresses compare in any case (the statement is compared in lower case).
# 阶段 1 的 M7：交付的花费说明与对账，按规则文字写成谓词，不是 SDK 的移植；地址不区分大小写（说明按小写比较）。
import re as _re
_DEC = _re.compile(r'^(0|[1-9][0-9]*)$')
def _dec(v): return isinstance(v, str) and bool(_DEC.match(v)) and int(v) < 2 ** 256
def _addr(v): return isinstance(v, str) and bool(_re.match(r'^0x[0-9a-fA-F]{40}$', v))
def _lo(v): return v.lower() if isinstance(v, str) else v
def p1_statement(rec, ck):
    if ck.get('consumer') is None or _lo(ck['consumer']) != _lo(rec['consumer']): return []
    out = []
    for p in rec['providers']:
        r = next((x for x in ck.get('scope', []) if _lo(x.get('provider')) == _lo(p['provider'])), None)
        if r is None or r.get('escrow') is None or _lo(r['escrow']) != _lo(p['escrow']) or not _dec(r.get('claimedAtCheck')): continue
        if int(r['claimedAtCheck']) < int(p['base']): continue
        out.append({'provider': _lo(p['provider']), 'escrow': _lo(p['escrow']), 'claimedAtStart': p['base'], 'claimedAtDelivery': r['claimedAtCheck'], 'spent': str(int(r['claimedAtCheck']) - int(p['base']))})
    return out
for c in p1v['statement']:
    want = [{k: _lo(x) for k, x in e.items()} for e in c['expect']]
    check('phase1/statement/' + c['name'], p1_statement(c['record'], c['check']), want)
def p1_evidence(spend, mandate, calls, readings, prices):
    capped = [s for s in mandate['scope'] if s['cap'] != '0']
    probs, warns, items = [], [], []
    if not isinstance(spend, list) or len(spend) > len(capped): return {'problems': ['spend-evidence-malformed'], 'warnings': [], 'items': []}
    named, seen = set(), set()
    for e in spend:
        has_addr = isinstance(e, dict) and _addr(e.get('provider'))
        if has_addr: named.add(_lo(e['provider']))
        well_formed = has_addr and _addr(e.get('escrow')) and int(e['escrow'], 16) != 0 and all(_dec(e.get(k)) for k in ('claimedAtStart', 'claimedAtDelivery', 'spent'))
        rules = [
            ('spend-evidence-malformed', not well_formed or _lo(e['provider']) in seen),
            ('spend-provider-out-of-scope', well_formed and not any(_lo(s['provider']) == _lo(e['provider']) for s in capped)),
            ('spend-evidence-inconsistent', well_formed and (int(e['claimedAtDelivery']) < int(e['claimedAtStart']) or int(e['spent']) != int(e['claimedAtDelivery']) - int(e['claimedAtStart']))),
        ]
        hit = next((code for code, applies in rules if applies), None)
        if well_formed and hit != 'spend-evidence-malformed': seen.add(_lo(e['provider']))
        if hit: probs.append(hit); continue
        cap = next(s for s in capped if _lo(s['provider']) == _lo(e['provider']))
        start, spent = int(e['claimedAtStart']), int(e['spent'])
        it = {'reconciled': None, 'spentNow': None, 'expected': None}
        r = next((x for x in (readings or []) if _lo(x.get('provider')) == _lo(e['provider'])), None) if readings is not None else None
        if r is not None and _addr(r.get('escrow')) and _dec(r.get('claimedAtCheck')):
            if _lo(r['escrow']) != _lo(e['escrow']): warns.append('spend-escrow-changed')
            else:
                now = int(r['claimedAtCheck'])
                if now >= start: it['spentNow'] = str(now - start)
                if now < int(e['claimedAtDelivery']): warns.append('spend-above-chain')
        if (int(it['spentNow']) if it['spentNow'] is not None else spent) > int(cap['cap']): warns.append('spend-above-cap')
        mine = [c for c in calls if c.get('ok') is True and _lo(c.get('provider')) == _lo(e['provider'])]
        table = (prices or {}).get(_lo(e['provider'])) if prices is not None else None
        if isinstance(table, dict) and all(isinstance(c.get('method'), str) and c['method'] in table and _dec(table[c['method']]) for c in mine):
            expected = sum(int(table[c['method']]) for c in mine)
            it['expected'] = str(expected)
            measured = int(it['spentNow']) if it['spentNow'] is not None else spent
            it['reconciled'] = 'equal' if measured == expected else ('above' if measured > expected else 'below')
            if it['reconciled'] == 'above': warns.append('spend-exceeds-receipts')
            if it['reconciled'] == 'below': warns.append('spend-below-receipts')
        items.append(it)
    for s in capped:
        if _lo(s['provider']) not in named: warns.append('spend-evidence-incomplete')
    return {'problems': probs, 'warnings': warns, 'items': items}
for c in p1v['evidence']:
    r = p1_evidence(c['spend'], c['mandate'], c['calls'], c['readings'], c['prices'])
    got = {'problems': r['problems'], 'warnings': r['warnings'], 'reconciled': [i['reconciled'] for i in r['items']], 'spentNow': [i['spentNow'] for i in r['items']], 'expected': [i['expected'] for i in r['items']]}
    check('phase1/evidence/' + c['name'], got, c['expect'])


# ---------- phase 1, restart: the key vault (phase1.rules.keyVault) ----------
# scrypt is checked with hashlib.scrypt where this Python has it (OpenSSL builds, e.g. CI's 3.12); a Python linked against
# LibreSSL has none, and scrypt at N = 2^17 in pure Python is too slow to run here, so the KDF step is then reported as not
# checked (never counted as passed). The AEAD step is always checked, with the key each case gives: XChaCha20-Poly1305 from
# this file's own ChaCha20, Poly1305 and HChaCha20; opening = decrypt, then seal again and compare.
# 阶段 1 的重启：钥匙保险箱。scrypt 只在本 Python 带 hashlib.scrypt 时核对（OpenSSL 构建，如 CI 的 3.12）；LibreSSL 构建没有它，
# 纯 Python 的 scrypt（N = 2^17）太慢，此时 KDF 一步明确报"未核对"（不计入通过）。AEAD 一步总是核对，用各例给出的密钥。
import hashlib as _hashlib
kv = p1v['keyVault']
KV_PREFIX = kv['params']['prefix']
kv_kdf_checked = 0
def kv_kdf(passphrase, salt_hex):
    global kv_kdf_checked
    if not hasattr(_hashlib, 'scrypt'): return None
    kv_kdf_checked += 1
    pr = kv['params']
    return _hashlib.scrypt(passphrase.encode('utf-8'), salt=bytes.fromhex(salt_hex), n=pr['N'], r=pr['r'], p=pr['p'], maxmem=2 ** 28, dklen=pr['dkLen']).hex()
def kv_aad(context): return ('tapeapi/key-vault/v1\n' + context).encode('utf-8')
def kv_parse(blob):
    if not isinstance(blob, str) or not blob.startswith(KV_PREFIX): return None
    h = blob[len(KV_PREFIX):]
    if len(h) < 2 * (16 + 24 + 16) or len(h) % 2 or any(ch not in '0123456789abcdef' for ch in h): return None
    b = bytes.fromhex(h)
    return b[:16], b[16:40], b[40:]
def kv_open(key, blob, context):
    parts = kv_parse(blob)
    if parts is None: return 'key-vault-malformed', None
    salt, nonce, sealed = parts
    ct = sealed[:-16]
    sub = _hchacha20(key, nonce[:16])
    pt = _chacha20(sub, 1, b'\x00' * 4 + nonce[16:24], ct)
    if xchacha20poly1305_seal(key, nonce, kv_aad(context), pt) != sealed: return 'key-vault-open-failed', None
    return 'ok', pt
for c in kv['seal']:
    check('phase1/keyVault/aad/' + c['name'], kv_aad(c['context']).hex(), c['aad'])
    blob = KV_PREFIX + c['salt'] + c['nonce'] + xchacha20poly1305_seal(bytes.fromhex(c['key']), bytes.fromhex(c['nonce']), kv_aad(c['context']), bytes.fromhex(c['plaintext'])).hex()
    check('phase1/keyVault/seal/' + c['name'], blob, c['blob'])
    check('phase1/keyVault/open/' + c['name'], kv_open(bytes.fromhex(c['key']), c['blob'], c['context']), ('ok', bytes.fromhex(c['plaintext'])))
    k = kv_kdf(c['passphrase'], c['salt'])
    if k is not None: check('phase1/keyVault/kdf/' + c['name'], k, c['key'])
for c in kv['open']:
    parts = kv_parse(c['blob'])
    check('phase1/keyVault/parse/' + c['name'], parts is None, c['expect'] == 'key-vault-malformed')
    if c['key'] is not None:
        check('phase1/keyVault/open/' + c['name'], kv_open(bytes.fromhex(c['key']), c['blob'], c['context'])[0], c['expect'])
        k = kv_kdf(c['passphrase'], parts[0].hex())
        if k is not None: check('phase1/keyVault/kdf/' + c['name'], k, c['key'])
if kv_kdf_checked == 0:
    # on stderr: stdout stays the one summary line sdk/test/vectors.test.mjs reads / 写到 stderr：stdout 只留一行总结
    print('NOTE: this Python has no hashlib.scrypt (built against %s): the key-vault KDF step (scrypt N=2^17) was NOT checked here; the AEAD step was. CI (Python 3.12, OpenSSL) checks both.' % __import__('ssl').OPENSSL_VERSION, file=sys.stderr)

# ======================================== Evidence-backed reviews (experimental, draft TAPs #54) ====
# Written from the draft's §2.1, §4.2 and §4.3 alone: the Review type in the TAP-11 domain whose chainId is the
# reviewer's (read from its endpoint ID, TAP-10 §12.1), the review hash of every case the vectors accept, the signer of
# every case signed by the holder or the delegate, every level-1 subject (the TAP-13 §5 digest rebuilt from a hash-only
# receipt) and its signer, every level-2 subject (the mandate hash in the principal's chain) and the delivery's signer.
# The rules of §6 (which problem, counted or not) are the SDK's; this checks only the hashes and signatures they rest on.
# 只按草稿 §2.1、§4.2、§4.3 实现：类型哈希、域、每条被接受用例的评价哈希与签名者、1 级 subject 与签名者、2 级 subject 与交付签名者。
rv = load_vec('tap-draft-container-reviews.json')
RV_FIELDS = [('bytes32', 'reviewer'), ('bytes32', 'reviewee'), ('uint8', 'kind'), ('uint8', 'score'), ('bytes32', 'subject'),
             ('bytes32', 'evidenceHash'), ('bytes32', 'textHash'), ('uint64', 'issued')]
rv_type = 'Review(%s)' % ','.join('%s %s' % f for f in RV_FIELDS)
check('review/type', rv_type, rv['constants']['REVIEW_TYPE'])
rv_th = keccak256(rv_type.encode())
check('review/typehash', h(rv_th), rv['constants']['REVIEW_TYPEHASH'])
check('review/typehash as the draft prints it', h(rv_th), '0xb9c66a727a6fba79714dcc4f0dfdbaf876840b1a35de576ed8fe3eef1f1b9a0b')
rv_hub = rv['constants']['hub']
for cid, dsep in rv['constants']['domainSeparator'].items():
    check('review/domain %s' % cid, h(eip712_domain('TapeAPI', '1', int(cid), rv_hub)), dsep)
check('review/domain 56 is TAP-11\'s', rv['constants']['domainSeparator']['56'], '0xa73ee348b5672f12dbc174f66a7d162c69e0d64befdba88475d9d7e3c0fd3ac7')
def rv_chain(ep):
    return int(ep[10:26], 16)
def rv_digest(r):
    out = rv_th
    for t, f in RV_FIELDS:
        out += ca_b32(r[f]) if t == 'bytes32' else ca_word(r[f])
    return typed_digest(eip712_domain('TapeAPI', '1', rv_chain(r['reviewer']), rv_hub), keccak256(out))
def rv_facts(c, k):
    m = dict(rv['facts'][k]); m.update((c.get('facts') or {}).get(k) or {})
    return {a.lower(): b.lower() for a, b in m.items()}
rv_counts = {'hash': 0, 'signer': 0, 'l1': 0, 'l2': 0}
for c in rv['cases']:
    e, rec = c['expect'], c['record']
    if not e['valid']:
        if 'record-signature' in e['problems']:
            check('review/high-s is refused/' + c['name'], recover_address(rv_digest(rec['review']), rec['sig']), None)
        continue
    r = rec['review']
    dg = rv_digest(r)
    check('review/hash/' + c['name'], h(dg), e['hash']); rv_counts['hash'] += 1
    holders, signers = rv_facts(c, 'holders'), rv_facts(c, 'signers')
    if e['signedBy'] == 'holder':
        check('review/signer holder/' + c['name'], recover_address(dg, rec['sig']), holders[r['reviewer']]); rv_counts['signer'] += 1
    elif e['signedBy'] == 'delegate':
        check('review/signer delegate/' + c['name'], recover_address(dg, rec['sig']), signers[r['reviewer']]); rv_counts['signer'] += 1
    if 'text' in rec and r['textHash'] != '0x' + '00' * 32:
        check('review/textHash/' + c['name'], h(keccak256(canonical(rec['text']).encode('utf-8'))), r['textHash'])
    if e['level'] == 1:
        rc = rec['evidence']['receipt']
        reviewee = '0x' + r['reviewee'][26:]
        sd = keccak256(b'TAPI-1/resp/v2' + bytes.fromhex(reviewee[2:]) + keccak256(rc['id'].encode('utf-8')) + ca_b32(rc['requestHash']) +
                       (b'\x01' if rc['ok'] else b'\x00') + ca_b32(rc['bodyHash']) + u64(rc['ts']))
        check('review/level-1 subject/' + c['name'], h(sd), r['subject'])
        check('review/level-1 signer/' + c['name'], recover_address(eip191(sd), rc['sig']), signers[r['reviewee']])
        check('review/level-1 id names the reviewer/' + c['name'], rc['id'].startswith('tape-review:0x' + r['reviewer'][26:] + ':'), True)
        check('review/evidenceHash/' + c['name'], h(keccak256(canonical(rec['evidence']).encode('utf-8'))), r['evidenceHash'])
        rv_counts['l1'] += 1
    if e['level'] == 2:
        ev = rec['evidence']
        m = ev['mandate']
        parties = {('0x' + r['reviewer'][26:]).lower(): r['reviewer'], ('0x' + r['reviewee'][26:]).lower(): r['reviewee']}
        pep, aep = parties[m['principal'].lower()], parties[m['agent'].lower()]
        pdom = eip712_domain('TapeAPI', '1', rv_chain(pep), rv_hub)
        md = typed_digest(pdom, ca_struct('Mandate', m))
        check('review/level-2 subject/' + c['name'], h(md), r['subject'])
        check('review/level-2 mandate signer/' + c['name'], recover_address(md, ev['mandateSig']), holders[pep])
        check('review/level-2 verdict signer/' + c['name'], recover_address(typed_digest(pdom, ca_struct('TaskVerdict', ev['verdict'])), ev['verdictSig']), holders[pep])
        dl = ev['deliver']
        dd = response_digest('TAPI-1/resp/v2', '0x' + aep[26:], dl['id'], dl['method'], dl.get('params', {}), True, dl['result'], dl['ts'])
        check('review/level-2 delivery signer/' + c['name'], recover_address(eip191(dd), dl['sig']), signers[aep])
        check('review/evidenceHash/' + c['name'], h(keccak256(canonical(ev).encode('utf-8'))), r['evidenceHash'])
        rv_counts['l2'] += 1
check('review/coverage (hashes, signers, level 1, level 2)', (rv_counts['hash'], rv_counts['signer'], rv_counts['l1'], rv_counts['l2']), (45, 39, 12, 4))
allth.append(rv_th)
check('review/the Review typehash differs from every other type of the hub domain', len(set(allth)), len(allth))

if fail:
    print('FAIL: %d of %d checks disagreed with the reference implementation\n' % (len(fail), checked))
    for f in fail:
        print('  ' + f)
    sys.exit(1)
print('ok: %d checks, an independent Python implementation agrees with the reference SDK' % checked)
