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
//
// X Layer (chain 196) and Base (chain 8453), measured 2026-09-28 from one machine (eth_chainId, eth_blockNumber,
// eth_getBlockByNumber, eth_call pinned by an EIP-1898 blockHash, CORS preflight and batch; 8 repeated eth_calls each):
// X Layer (链 196) 与 Base (链 8453)，2026-09-28 实测（同上各项，外加 CORS 预检、批量与 8 次重复 eth_call）：
// - X Layer has two independent operators, and only two: OKX (rpc.xlayer.tech and xlayerrpc.okx.com; OKX also runs the
//   sequencer) and dRPC. thirdweb (196.rpc.thirdweb.com) answers unknown methods and out-of-range blocks with OKX's exact
//   words ("rpc method is not whitelisted", -32019 "block is out of range"): it forwards OKX. Sentio
//   (xlayer-mainnet.rpc.sentio.xyz) answered an early eth_getLogs range with OKX's exact words ("block range greater
//   than 100 max") and a full-range eth_getLogs with [] while sites exist: counted as OKX and not a default. With two
//   operators, quorum 2 has NO spare: either operator down (or rate limiting) stops every X Layer read; createRpc says
//   so once. The two OKX URLs are spares for each other only. Add your own node (opts.chains[196].rpcUrls) for a spare.
//   X Layer 只有两家独立运营方：OKX（两个域名；OKX 也是排序器）与 dRPC。thirdweb 对未知方法与越界区块的报错与 OKX 逐字相同，
//   是转发 OKX；Sentio 对早期区间的 eth_getLogs 报错与 OKX 逐字相同、对全区间 eth_getLogs 答 []（而链上有网站）：按 OKX 计，
//   不作默认。两家时 quorum 2 **没有余量**：任一家宕机或限流，X Layer 的读取全部停下；createRpc 会提示一次。两个 OKX 域名只是
//   彼此的备份。要有余量，请加自己的节点（opts.chains[196].rpcUrls）。
// - Base: Coinbase (mainnet.base.org; fast, but answered 5 of 8 calls, the rest HTTP 429), Allnodes (publicnode),
//   dRPC and Tenderly: four operators, all 8/8 except Coinbase, so 2 of 4 keeps two spares. dRPC on Base and X Layer
//   DOES accept EIP-1898 blockHash objects (bsc.drpc.org did not). Not in the set: 1rpc (2.8 s median, 5/8, upstream
//   unknown), base-pokt/base-public.nodies.app (the CORS preflight carries no allow-origin), Sentio (see X Layer),
//   Blast API (unknown methods answered HTTP 401; TapeKit saw heavy rate limits), thirdweb (forwards dRPC per TapeKit),
//   bloXroute (pruned history), llamarpc and blockpi (HTTP 5xx), ankr and zan (keys required for eth_call).
//   Base：Coinbase（快，但 8 次只答 5 次，其余 HTTP 429）、Allnodes（publicnode）、dRPC、Tenderly，四家，除 Coinbase 外都是
//   8/8，二取四留两家余量。dRPC 在 Base 与 X Layer 上**接受** EIP-1898 blockHash 对象（bsc.drpc.org 不接受）。未入选：1rpc（中位
//   2.8 秒、5/8、上游不明）、nodies（CORS 预检不带 allow-origin）、Sentio、Blast API（未知方法答 HTTP 401；TapeKit 见到严重限流）、
//   thirdweb（按 TapeKit 计为 dRPC）、bloXroute（历史被裁剪）、llamarpc 与 blockpi（HTTP 5xx）、ankr 与 zan（eth_call 需要密钥）。
const freeze = (list) => Object.freeze(list.map((n) => Object.freeze({ ...n })))
export const RPC_DEFAULTS = Object.freeze({
  56: freeze([
    { url: 'https://bsc-dataseed.bnbchain.org', operator: 'nodereal' },
    { url: 'https://bsc-mainnet.public.blastapi.io', operator: 'alchemy' },
    { url: 'https://rpc-bsc.48.club', operator: '48club' },
  ]),
  196: freeze([
    { url: 'https://rpc.xlayer.tech', operator: 'okx' },
    { url: 'https://xlayerrpc.okx.com', operator: 'okx' },
    { url: 'https://xlayer.drpc.org', operator: 'drpc' },
  ]),
  8453: freeze([
    { url: 'https://mainnet.base.org', operator: 'coinbase' },
    { url: 'https://base-rpc.publicnode.com', operator: 'allnodes' },
    { url: 'https://base.drpc.org', operator: 'drpc' },
    { url: 'https://base.gateway.tenderly.co', operator: 'tenderly' },
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
  // X Layer: OKX runs rpc.xlayer.tech and xlayerrpc.okx.com; thirdweb's and Sentio's X Layer nodes answer with OKX's
  // exact error words (measured 2026-09-28). These entries come before the generic thirdweb / Sentio ones: the first
  // matching suffix wins. / X Layer：两个 OKX 域名；thirdweb 与 Sentio 的 X Layer 节点报错与 OKX 逐字相同。须排在通用条目之前。
  ['xlayer.tech', 'okx'], ['okx.com', 'okx'], ['196.rpc.thirdweb.com', 'okx'], ['xlayer-mainnet.rpc.sentio.xyz', 'okx'],
  // thirdweb's BSC and Base RPC forwards dRPC (TapeKit audit) / thirdweb 的 BSC 与 Base RPC 转发 dRPC
  ['drpc.org', 'drpc'], ['rpc.thirdweb.com', 'drpc'],
  // Base: Coinbase runs mainnet.base.org and developer-access-mainnet.base.org / Base 官方节点属于 Coinbase
  ['base.org', 'coinbase'],
  ['tenderly.co', 'tenderly'],
  ['sentio.xyz', 'sentio'],
  // Pocket Network gateways: nodies.app and pocket.network / Pocket 网络的网关
  ['nodies.app', 'pokt'], ['pocket.network', 'pokt'],
  ['blxrbdn.com', 'bloxroute'],
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
