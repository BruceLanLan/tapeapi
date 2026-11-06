# Differential driver: evaluate (policy, state, word) cases with the TAP-02 reference evaluator the Policy Circuit Gate
# draft vendors (test/vectors/reference: tapnft.py, tap02_reference.py, SHA-256 pinned by the vectors). Reads the cases as
# JSON on stdin, writes [[newState, outputs], ...] as JSON on stdout. Run as: python3 -I policy-circuit-diff-ref.py <dir>
# 差分驱动：用草稿附带的 TAP-02 参考求值器计算各例。标准输入读 JSON，标准输出写 JSON。
import json, os, sys
here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(here, "vectors", "reference"))
import tap02_reference as tap02  # noqa: E402
import tapnft  # noqa: E402

policies_dir = sys.argv[1]
cases = json.load(sys.stdin)
circ, out = {}, []
for c in cases:
    if c["policy"] not in circ:
        with open(os.path.join(policies_dir, c["policy"] + ".tapnet"), "rb") as f:
            n_in, n_out, recs = tapnft.decode_file(f.read())
        circ[c["policy"]] = tap02.load(recs, n_in, n_out)
    k = circ[c["policy"]]
    ns, o = tap02.beat(k, tap02.unpack(bytes.fromhex(c["state"]), k.n_state), tap02.unpack(bytes.fromhex(c["word"]), k.n_in))
    out.append([tap02.pack(ns).hex(), tap02.pack(o).hex()])
json.dump(out, sys.stdout)
