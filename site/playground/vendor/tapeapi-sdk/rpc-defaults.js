// Default JSON-RPC nodes per chain, and who operates a node. The one place a default node list lives: every example,
// worker, script and page takes its list from here (rpcUrlsFor), so a change of operators is one edit.
// 各链默认 JSON-RPC 节点，以及节点由谁运营。默认节点列表只在这里：所有示例、Worker、脚本与页面都从这里取（rpcUrlsFor），
// 换运营方只改一处。
//
// Why operators: a quorum is only as independent as the parties running the nodes. TapeKit's audit (kernel/src/config.js,
// 2026-09-19) found that bsc-dataseed*.bnbchain.org, *.defibit.io, *.ninicoin.io and *.binance.org are ALL run by
// NodeReal (same tracing headers and versions), so the old default "2 of 3 dataseeds" was one operator agreeing with
// itself. createRpc counts agreement by DISTINCT OPERATORS (operatorOf), never by URL.
// 为什么按运营方：法定数的独立性取决于节点背后是谁。TapeKit 审计发现 bsc-dataseed*.bnbchain.org、*.defibit.io、
// *.ninicoin.io、*.binance.org 全由 NodeReal 运营，旧默认"三个 dataseed 取二"其实是一家与自己一致。createRpc 按
// **不同运营方**计票，绝不按 URL。
//
// Leaf module: no imports, so a browser page or a Worker can take it alone. / 叶子模块：不导入任何东西。

// BSC (chain 56), measured 2026-09-28: each answers eth_blockNumber, eth_getBlockByNumber and eth_call pinned by an
// EIP-1898 blockHash, and each allows browser CORS. Not in the set, as measured the same day: publicnode (timeouts),
// bsc.drpc.org (refuses blockHash objects), meowrpc (rate limits), 1rpc.io (a relay of unknown upstream), thirdweb
// (forwards dRPC). None of the three serves eth_getLogs history well enough for ChannelBus: use BUS_RPC_URLS for that.
// BSC（链 56），2026-09-28 实测：三者都正确回答 eth_blockNumber、eth_getBlockByNumber 与按 EIP-1898 blockHash 钉块的
// eth_call，且都允许浏览器跨域。同日未入选：publicnode（超时）、bsc.drpc.org（拒绝 blockHash 对象）、meowrpc（限流）、
// 1rpc.io（上游不明的转发）、thirdweb（转发 dRPC）。读 ChannelBus 需要 eth_getLogs 历史，请用 BUS_RPC_URLS。
//
// Chains 196 (X Layer) and 8453 (Base) are added by their own measurement; until then rpcUrlsFor answers [].
// 链 196（X Layer）与 8453（Base）待各自实测后加入；在此之前 rpcUrlsFor 返回 []。
const freeze = (list) => Object.freeze(list.map((n) => Object.freeze({ ...n })))
export const RPC_DEFAULTS = Object.freeze({
  56: freeze([
    { url: 'https://bsc-dataseed.bnbchain.org', operator: 'nodereal' },
    { url: 'https://bsc-mainnet.public.blastapi.io', operator: 'alchemy' },
    { url: 'https://rpc-bsc.48.club', operator: '48club' },
  ]),
})

/** The default node URLs for a chain, as a fresh array ([] for a chain without defaults). / 某链的默认节点 URL。 */
export function rpcUrlsFor(chainId) {
  const list = Object.prototype.hasOwnProperty.call(RPC_DEFAULTS, Number(chainId)) ? RPC_DEFAULTS[Number(chainId)] : []
  return list.map((n) => n.url)
}

// Host suffix -> operator. A host matches a suffix when it IS the suffix or ends with "." + suffix. Grouping errs on the
// side of one operator: two hosts wrongly grouped only cost a spare, two wrongly split fake an independent vote.
// 主机后缀 -> 运营方。主机等于后缀或以 "." + 后缀结尾即匹配。宁可多归并：错并两个主机只损失余量，错拆则伪造一张独立票。
const OPERATOR_HOSTS = [
  // NodeReal runs BNB Chain's public endpoints (TapeKit audit, 2026-09-19) / NodeReal 运营 BNB Chain 的公共节点
  ['bnbchain.org', 'nodereal'], ['binance.org', 'nodereal'], ['defibit.io', 'nodereal'], ['ninicoin.io', 'nodereal'], ['nodereal.io', 'nodereal'],
  // Blast API is Alchemy's / Blast API 属于 Alchemy
  ['blastapi.io', 'alchemy'], ['alchemy.com', 'alchemy'],
  ['48.club', '48club'],
  ['publicnode.com', 'allnodes'],
  // thirdweb's BSC RPC forwards dRPC (TapeKit audit) / thirdweb 的 BSC RPC 转发 dRPC
  ['drpc.org', 'drpc'], ['rpc.thirdweb.com', 'drpc'],
  ['ankr.com', 'ankr'],
  ['llamarpc.com', 'llamarpc'],
  ['1rpc.io', '1rpc'],
  ['meowrpc.com', 'meowrpc'],
  ['blockpi.network', 'blockpi'],
  ['getblock.io', 'getblock'],
  ['quiknode.pro', 'quicknode'],
  ['infura.io', 'infura'],
  ['chainstack.com', 'chainstack'],
]

/**
 * Who operates the node at `url`: a known operator's name, or else the URL's hostname (an unknown host is its own
 * operator). A string that is not a URL is its own operator. / 节点的运营方：已知运营方的名字，否则就是 URL 的主机名。
 */
export function operatorOf(url) {
  let host
  try { host = new URL(String(url)).hostname.toLowerCase().replace(/\.$/, '') } catch { return String(url) }
  if (!host) return String(url)
  for (const [suffix, operator] of OPERATOR_HOSTS) if (host === suffix || host.endsWith('.' + suffix)) return operator
  return host
}
