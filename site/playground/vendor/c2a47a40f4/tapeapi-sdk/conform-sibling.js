// Internal, not a package export. For each createTapeAPI() client, a function returning the client that resolves as
// TAP-11 §2 says (conform: 'tap10') with the same options: the client itself when it is in the conformance mode, or else a
// sibling made on first use from the client's own options and RPC client (the same nodes, quorum, timeout and fetch), never
// with allChains, and refused for every other chain. It throws INVALID_ARGUMENT when the conformance mode cannot be built
// from those options (a hub, factory, opener, site store or payment contract that TAP-10 does not list for the chain).
// Set by createTapeAPI (index.js); read by createAgentKit (agent-verify.js) when its caller gives no `resolve`.
// 内部模块，不导出。每个 createTapeAPI() 客户端对应一个函数，返回按 TAP-11 §2 解析（conform: 'tap10'）、选项相同的客户端：
// 本身已是一致模式就是它自己，否则首次用到时用它自己的选项与 RPC 客户端（同样的节点、法定数、超时与 fetch）建一个同胞客户端，
// 绝不开 allChains，并拒绝其它链。选项无法建立一致模式时（TAP-10 没有为该链列出的中枢、工厂、开通器、站点存储或付费合约）抛出
// INVALID_ARGUMENT。由 createTapeAPI 设置；createAgentKit 在调用方没给 resolve 时读取。
export const CONFORM_SIBLINGS = new WeakMap()
// 2.0: whether a createTapeAPI() client is in the conformance mode (the default since 2.0; false with conform: false or
// dev: true). Set by createTapeAPI for every client it makes (forChain sub-clients too); read by the doctor (doctor.js) to
// say which resolution it checked with. / 2.0：createTapeAPI() 客户端是否处于一致模式（2.0 起默认；conform: false 或 dev: true
// 时为否）。createTapeAPI 为它建的每个客户端设置（含 forChain 子客户端）；诊断工具读取，以说明按哪种解析检查。
export const CONFORM_MODE = new WeakMap()
