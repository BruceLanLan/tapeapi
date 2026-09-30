// The holder console's page script (a module, loaded from index.html so the page can run under script-src 'self').
// Steps: 1 connect, 2 read the circuit, 3 service key and variables, 4 sign the delegation, 5 publish the manifest;
// "Advanced" (A deploy, B verify) is only for someone deploying their own ChannelBus.
// 持有人操作台的页面脚本（模块，从 index.html 加载，使页面能在 script-src 'self' 下运行）。
// 步骤：1 连接、2 读电路、3 服务密钥与变量、4 签委托、5 发布清单；“高级”（A 部署、B 核对）只给自己部署 ChannelBus 的人。
import * as C from './lib.js?v=97ef583782'

const $ = (id) => document.getElementById(id)
// ChannelBus (Advanced) runs on BNB Chain only (TapeAPI does not follow it to L2s). / ChannelBus（高级）只在 BNB Chain。
const BSC = '0x38'
// The chain steps 1-5 read and publish on: ?chain=56|196|8453 (the selector in step 1 sets it), BNB Chain by default.
// The page reloads when it changes, so everything below runs for one chain.
// 第 1–5 步读取与发布所在的链：?chain=56|196|8453（第 1 步的选择框设置它），默认 BNB Chain。切换时页面重新加载。
const pre = C.prefillFromQuery(location.search)
const CHAIN = C.useChain(pre.chainId ?? 56)   // lib reads, signs and builds for this chain from here on / 此后 lib 按这条链读、签、构造
const CHAIN_HEX = CHAIN.hex
const store = { get: (k) => { try { return JSON.parse(localStorage.getItem(k)) } catch { return null } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* private mode */ } } }
// Text in the current language (for strings: errors, button labels). / 当前语言的文本（用于字符串：错误、按钮文字）。
const t = (zh, en) => (document.documentElement.getAttribute('data-lang') === 'zh' ? zh : en)
// Both languages as <span lang> nodes, so a message follows the language switch. / 两种语言的 <span lang>，随语言切换。
const bi = (zh, en) => { const f = document.createDocumentFragment(); for (const [l, s] of [['zh', zh], ['en', en]]) { const sp = document.createElement('span'); sp.lang = l; sp.textContent = s; f.append(sp) } return f }
const nodes = (content) => [].concat(content)
const say = (el, content, cls = '') => { el.className = `status ${cls}`; el.replaceChildren(...nodes(content)) }
// A transaction hash as a link to the chain's explorer (BscScan, OKLink, BaseScan); anything that is not a hash stays
// plain text. / 交易哈希显示为该链浏览器的链接；不是哈希的保持纯文本。
const txLink = (hash) => {
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(hash))) return document.createTextNode(String(hash))
  const a = document.createElement('a'); a.href = CHAIN_HEX === BSC ? `https://bscscan.com/tx/${hash}` : `${CHAIN.explorer}/tx/${hash}`; a.target = '_blank'; a.rel = 'noopener'; a.className = 'mono'; a.textContent = hash; return a
}
const eth = window.ethereum
let cfg = null, account = null

// Anti-phishing: a copy of this page anywhere but tapeapi.fun/console/ says so in the banner.
// 防钓鱼：本页不在 tapeapi.fun/console/ 打开时，在顶部横幅里直接说明。
if (location.origin !== 'https://tapeapi.fun' || !location.pathname.startsWith('/console/')) {
  const here = `${location.origin}${location.pathname}`
  $('phish').classList.add('bad')
  $('phish-here').replaceChildren(bi(` 注意：本页现在打开在 ${here}，不是 https://tapeapi.fun/console/。`, ` Warning: this copy is open at ${here}, not https://tapeapi.fun/console/.`))
}

async function rpc(method, params = []) { return eth.request({ method, params }) }
// A wallet that switches account or chain mid-way would sign or send as someone else (security review F4): start over.
// 钱包中途切换账户或链，会以别人的身份签名或发送（安全审查 F4）：重新开始。
eth?.on?.('accountsChanged', () => location.reload())
eth?.on?.('chainChanged', () => location.reload())
async function ensureSame() {
  const [a] = await rpc('eth_accounts')
  if (!a || a.toLowerCase() !== account.toLowerCase()) throw new Error(t(`钱包当前账户（${a || '无'}）不是连接时的 ${account}，请刷新页面重新连接`, `the wallet's current account (${a || 'none'}) is not ${account}, which was connected; reload the page and connect again`))
  if ((await rpc('eth_chainId')) !== CHAIN_HEX) throw new Error(t(`钱包已不在 ${CHAIN.name}`, `the wallet is no longer on ${CHAIN.name}`))
}
const hexToBig = (h) => BigInt(h)
const fmtBNB = (wei, cur = 'BNB') => { const s = (Number(wei) / 1e18).toFixed(8).replace(/0+$/, '').replace(/\.$/, ''); return `${s} ${cur}` }
const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const notMined = (hash) => t(`6 分钟内没有上链，稍后用交易哈希 ${hash} 在 ${CHAIN.explorerName} 查看`, `not mined within 6 minutes; look up ${hash} on ${CHAIN.explorerName} later`)
const failed = (rc) => t(`交易失败（status ${rc.status}）`, `the transaction failed (status ${rc.status})`)

const svcState = () => store.get('svc') || {}
const saveSvc = (patch) => store.set('svc', { ...svcState(), ...patch })
// Reads go through the wallet, on the chain it was switched to in step 1. / 读取经过钱包，在第 1 步切换到的链上进行。
const call = async (to, data) => rpc('eth_call', [{ to, data }, 'latest'])
const copyBtn = (label, value) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'ghost'; b.textContent = label; b.onclick = async () => { try { await navigator.clipboard.writeText(value); b.textContent = t('已复制', 'Copied') } catch { b.textContent = t('复制失败，请长按上面的文字', 'Copy failed; long-press the text above') } }; return b }
const kv = (host, rows) => { const dl = document.createElement('dl'); for (const [k, v] of rows) { const dt = document.createElement('dt'); dt.replaceChildren(...nodes(k)); const dd = document.createElement('dd'); dd.className = 'mono'; dd.textContent = v; dl.append(dt, dd) } host.append(dl) }
const note = (host, ok, content) => { const p = document.createElement('p'); p.className = `status ${ok === true ? 'ok' : ok === false ? 'bad' : ''}`; p.replaceChildren(...nodes(content)); host.append(p); return p }

async function load() {
  try {
    cfg = await (await fetch('./channelbus.json', { cache: 'no-store' })).json()
    $('bus-src').href = cfg.source
    const runtimeSha = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', hexBytes(cfg.runtime)))).map((b) => b.toString(16).padStart(2, '0')).join('')
    const rows = [[bi('编译器', 'Compiler'), `solc ${cfg.compiler.split('+')[0]} · ${cfg.evmVersion} · runs ${cfg.optimizerRuns}`], [bi('代码大小', 'Code size'), `${(cfg.runtime.length - 2) / 2} bytes`], [bi('代码 SHA-256', 'Code SHA-256'), runtimeSha]]
    for (const [k, v] of rows) { const dt = document.createElement('dt'); dt.append(k); const dd = document.createElement('dd'); dd.className = 'mono'; dd.textContent = v; $('bus-facts').append(dt, dd) }
  } catch (e) { say($('bus-status'), bi(`读不到 channelbus.json：${e.message}`, `cannot read channelbus.json: ${e.message}`), 'bad') }
  const prev = store.get('channelbus.deployed')
  if (prev?.address) { $('bus-prev').hidden = false; $('bus-prev').replaceChildren(bi(`这台设备上已部署过：${prev.address}（${new Date(prev.at).toLocaleString()}）。通常不需要再部署。`, `Already deployed from this device: ${prev.address} (${new Date(prev.at).toLocaleString()}). There is usually no need to deploy again.`)); $('again-wrap').hidden = false; $('verify-addr').value = prev.address }
  if (!eth) { say($('wallet-status'), bi('没有检测到钱包。请在 MetaMask、OKX、Trust 等钱包的内置浏览器里打开本页。', 'No wallet found. Open this page in the in-app browser of a wallet such as MetaMask, OKX or Trust.'), 'bad'); $('btn-connect').disabled = true }
}
function hexBytes(h) { const s = h.replace(/^0x/, ''); const out = new Uint8Array(s.length / 2); for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16); return out }

$('btn-connect').onclick = async () => {
  try {
    const accs = await rpc('eth_requestAccounts')
    let cid = await rpc('eth_chainId')
    if (cid !== CHAIN_HEX) {
      // A wallet without this chain answers 4902: it has to be added in the wallet first. / 钱包没有这条链时答 4902：须先在钱包里添加。
      try { await rpc('wallet_switchEthereumChain', [{ chainId: CHAIN_HEX }]); cid = await rpc('eth_chainId') } catch { /* the user refused, or the wallet lacks the chain */ }
    }
    if (cid !== CHAIN_HEX) { say($('wallet-status'), bi(`钱包当前不在 ${CHAIN.name}（chainId ${parseInt(cid, 16)}），请在钱包里切换到 ${CHAIN.name}（chainId ${CHAIN.chainId}；钱包里没有这条链就先添加）再连接。`, `The wallet is not on ${CHAIN.name} (chainId ${parseInt(cid, 16)}). Switch the wallet to ${CHAIN.name} (chainId ${CHAIN.chainId}; add the network first if the wallet lacks it) and connect again.`), 'bad'); return }
    account = accs[0]   // only once the chain is right, so steps 2-5 stay off on another chain / 链正确之后才记下账户
    const bal = await rpc('eth_getBalance', [account, 'latest'])
    say($('wallet-status'), bi(`已连接 ${account}（${CHAIN.name}，余额 ${fmtBNB(hexToBig(bal), CHAIN.currency)}）`, `Connected ${account} (${CHAIN.name}, balance ${fmtBNB(hexToBig(bal), CHAIN.currency)})`), 'ok')
    // ChannelBus (Advanced) is BNB Chain only / ChannelBus（高级）只在 BNB Chain
    $('btn-estimate').disabled = !cfg || CHAIN_HEX !== BSC; $('btn-verify').disabled = CHAIN_HEX !== BSC
    await checkPending()
    refreshDeployButton()
  } catch (e) { say($('wallet-status'), bi(`连接失败：${e.message}`, `Could not connect: ${e.message}`), 'bad') }
}

// ---------------------------------------------------------------- Advanced A/B: deploy and verify a ChannelBus ----
// A deployment sent earlier whose receipt the page never saw (timeout, reload): promote it or say it is still waiting.
// 之前发出、页面没等到回执的部署（超时、刷新）：已上链就记下，否则提示仍在等待。
async function checkPending() {
  const p = store.get('channelbus.pending')
  if (!p?.hash || store.get('channelbus.deployed')?.address) return
  const rc = await rpc('eth_getTransactionReceipt', [p.hash]).catch(() => null)
  if (rc?.status === '0x1' && rc.contractAddress) {
    store.set('channelbus.deployed', { address: rc.contractAddress, hash: p.hash, at: p.at }); store.set('channelbus.pending', null)
    $('bus-prev').hidden = false; $('bus-prev').replaceChildren(bi(`之前发出的部署已上链：${rc.contractAddress}。不需要再部署。`, `The deployment sent earlier is on chain: ${rc.contractAddress}. No need to deploy again.`)); $('again-wrap').hidden = false; $('verify-addr').value = rc.contractAddress
    $('s-advanced').open = true
  } else if (rc) store.set('channelbus.pending', null)
  else {
    $('bus-prev').hidden = false; $('bus-prev').replaceChildren(bi('有一笔部署交易还在等待上链：', 'A deployment transaction is still waiting to be mined: '), txLink(p.hash), bi('。先在 BscScan 查看，不要重复部署。', '. Check it on BscScan first; do not deploy twice.'))
    $('again-wrap').hidden = false; store.set('channelbus.deployed', null); $('s-advanced').open = true
  }
}
function refreshDeployButton() {
  const prev = store.get('channelbus.deployed')
  const waiting = store.get('channelbus.pending')?.hash && !prev?.address
  $('btn-deploy').disabled = !account || !cfg || CHAIN_HEX !== BSC || ((prev?.address || waiting) && !$('again').checked)
}
$('again').onchange = refreshDeployButton

$('btn-estimate').onclick = async () => {
  try {
    const [gas, price] = await Promise.all([rpc('eth_estimateGas', [{ from: account, data: cfg.creation }]), rpc('eth_gasPrice')])
    say($('bus-status'), bi(`预计约 ${hexToBig(gas).toLocaleString()} gas，按当前 gas 价格约 ${fmtBNB(hexToBig(gas) * hexToBig(price))}（钱包里显示的为准）`, `About ${hexToBig(gas).toLocaleString()} gas, about ${fmtBNB(hexToBig(gas) * hexToBig(price))} at the current gas price (your wallet's figure is the one that counts)`))
  } catch (e) { say($('bus-status'), bi(`估算失败：${e.message}`, `Estimate failed: ${e.message}`), 'bad') }
}

$('btn-deploy').onclick = async () => {
  $('btn-deploy').disabled = true
  try {
    await ensureSame()
    const gas = hexToBig(await rpc('eth_estimateGas', [{ from: account, data: cfg.creation }]))
    say($('bus-status'), bi('请在钱包里确认部署交易…', 'Confirm the deployment in your wallet…'))
    // No `to`: a contract creation with exactly the tested bytes / 没有 `to`：以测试过的字节创建合约
    const hash = await rpc('eth_sendTransaction', [{ from: account, chainId: BSC, data: cfg.creation, gas: '0x' + ((gas * 12n) / 10n).toString(16) }])
    store.set('channelbus.pending', { hash, at: Date.now() })
    say($('bus-status'), [bi('已发出 ', 'Sent '), txLink(hash), bi('，等待上链…', ', waiting for it to be mined…')])
    let rc = null
    for (let i = 0; i < 120 && !rc; i++) { await sleep(3000); rc = await rpc('eth_getTransactionReceipt', [hash]) }
    if (!rc) throw new Error(notMined(hash))
    if (rc.status !== '0x1') throw new Error(failed(rc))
    const address = rc.contractAddress
    store.set('channelbus.deployed', { address, hash, at: Date.now() }); store.set('channelbus.pending', null)
    say($('bus-status'), bi(`已部署：${address}`, `Deployed: ${address}`), 'ok')
    $('verify-addr').value = address
    await verify(address)
  } catch (e) { say($('bus-status'), bi(`部署没有完成：${e.message}`, `The deployment did not complete: ${e.message}`), 'bad') }
  refreshDeployButton()
}

$('btn-verify').onclick = () => verify($('verify-addr').value.trim())

async function verify(address) {
  const out = $('verify-out')
  out.replaceChildren()
  const line = (ok, content) => { const p = document.createElement('p'); p.className = `status ${ok ? 'ok' : 'bad'}`; p.append(ok ? '✓ ' : '✗ ', ...nodes(content)); out.append(p); return ok }
  if (!isAddr(address)) return line(false, bi('不是有效地址', 'not a valid address'))
  try {
    if ((await rpc('eth_chainId')) !== BSC) return line(false, bi('钱包不在 BNB Chain', 'the wallet is not on BNB Chain'))
    const code = String(await rpc('eth_getCode', [address, 'latest'])).toLowerCase()
    const same = code === cfg.runtime.toLowerCase()
    let all = line(same, code === '0x' ? bi('这个地址上没有代码', 'there is no code at this address') : same ? bi('链上代码与测试过的构建逐字节一致', 'the code on chain equals the tested build byte for byte') : bi('链上代码与测试过的构建不一致', 'the code on chain differs from the tested build'))
    if (!all) return false   // not our contract: its constants mean nothing / 不是我们的合约：常量没有意义
    for (const c of cfg.checks) {
      const v = hexToBig(await rpc('eth_call', [{ to: address, data: c.call }, 'latest']))
      all = line(v === BigInt(c.expect), bi(`${c.name} = ${v}（应为 ${c.expect}）`, `${c.name} = ${v} (expected ${c.expect})`)) && all
    }
    if (all) {
      const p = document.createElement('p')
      const addrCode = document.createElement('code'); addrCode.textContent = address
      const a = document.createElement('a'); a.href = `https://bscscan.com/address/${address}`; a.target = '_blank'; a.rel = 'noopener'; a.append(bi('在 BscScan 上查看', 'View on BscScan'))
      p.append(bi('请保存这个地址备查：', 'Keep this address for your records: '), document.createElement('br'), addrCode, document.createElement('br'), a)
      const b = document.createElement('button'); b.type = 'button'; b.className = 'ghost'; b.append(bi('复制地址', 'Copy address'))
      b.onclick = async () => { try { await navigator.clipboard.writeText(address); b.textContent = t('已复制', 'Copied') } catch { b.textContent = t('复制失败，请长按上面的地址', 'Copy failed; long-press the address above') } }
      out.append(p, b)
      // A first real frame: it proves a message goes on chain and comes back through real nodes, before anyone relies on it.
      // 第一条真实的消息：在有人依赖它之前，证明消息能上链、并能通过真实节点读回来。
      const tb = document.createElement('button'); tb.type = 'button'; tb.className = 'ghost'; tb.append(bi('发一条测试消息（约 5 万 gas）', 'Send a test message (about 50,000 gas)'))
      const note3 = document.createElement('p'); note3.className = 'status'
      tb.onclick = async () => {
        tb.disabled = true
        try {
          await ensureSame()
          const tx = C.probeTx({ bus: address, text: `tapeapi probe ${new Date().toISOString()}` })
          note3.replaceChildren(bi('请在钱包里确认…', 'Confirm in your wallet…'))
          const hash = await rpc('eth_sendTransaction', [{ from: account, chainId: BSC, to: tx.to, data: tx.data, value: tx.value }])
          note3.replaceChildren(bi('已发出 ', 'Sent '), txLink(hash), bi('，等待上链…', ', waiting for it to be mined…'))
          let rc = null
          for (let i = 0; i < 120 && !rc; i++) { await sleep(3000); rc = await rpc('eth_getTransactionReceipt', [hash]) }
          if (!rc || rc.status !== '0x1') throw new Error(rc ? failed(rc) : notMined(hash))
          const block = parseInt(rc.blockNumber, 16)
          note3.className = 'status ok'
          note3.replaceChildren(bi(`✓ 测试消息已上链（区块 ${block}）。请保存交易备查：`, `✓ The test message is on chain (block ${block}). Keep the transaction for your records: `), txLink(hash))
          out.append(copyBtn(t('复制交易哈希', 'Copy transaction hash'), hash))
        } catch (e) { note3.className = 'status bad'; note3.replaceChildren(bi(`没有完成：${e.message}`, `Not completed: ${e.message}`)); tb.disabled = false }
      }
      out.append(tb, note3)
    }
  } catch (e) { line(false, bi(`核对失败：${e.message}`, `Verification failed: ${e.message}`)) }
}

load()
// A link such as the dashboard's "Renew in console" may carry ?processor=&circuit=&url=. Only values that pass
// lib prefillFromQuery fill the step 2 and step 4 fields; nothing is read, signed or sent until you tap a button.
// 面板“去操作台续期”这类链接可带 ?processor=&circuit=&url=。只有通过 lib prefillFromQuery 检查的值会填进第 2 步和第 4 步的
// 输入框；在你点按钮之前，本页不读取、不签名、不发送任何东西。
// The chain selector (step 1): a change reloads the page on that chain, keeping the other prefilled values.
// 选链（第 1 步）：切换后在那条链上重新加载页面，其它预填值保留。
$('chain').value = String(CHAIN.chainId)
$('chain').addEventListener('change', () => {
  const u = new URL(location.href)
  if ($('chain').value === '56') u.searchParams.delete('chain'); else u.searchParams.set('chain', $('chain').value)
  location.replace(u.toString())
})
$('chain-note').hidden = CHAIN_HEX === BSC
{
  if (pre.processor) $('c-proc').value = pre.processor
  if (pre.circuit) $('c-id').value = pre.circuit
  if (pre.url) $('svc-url').value = pre.url
}

// ---------------------------------------------------------------- steps 2-5: publish a service ----
function showVars() {
  const s = hereSvc(), out = $('vars-out'); out.replaceChildren()
  if (!s.container) return
  note(out, null, bi('在同一个 Cloudflare 页面再添加这几个变量（类型 Text）：', 'On the same Cloudflare page, also add these variables (type Text):'))
  for (const [k, v] of [['CIRCUITS', s.circuits], ['TOKEN_ID', s.tokenId], ['CONTAINER', s.container], ...(s.sig ? [['DELEGATION_EXPIRES', String(s.expires)], ['DELEGATION_SIG', s.sig]] : [])]) {
    kv(out, [[k, v]]); out.append(copyBtn(t(`复制 ${k}`, `Copy ${k}`), v))
  }
}
// ---------------------------------------------------------------- renewal: the manifest already on chain ----
// What the manifest in the container authorises (lib onChainAuthorisation), for the circuit read in step 2; kept in
// memory only: step 4 reads the chain again before it signs. / 容器里的清单授权了什么（第 2 步读到的电路）；只放在内存里：第 4 步签名前会重新读链。
let onChain = null
const sha256Hex = async (b) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', b))).map((x) => x.toString(16).padStart(2, '0')).join('')
const readOnChain = (s) => C.readManifestFile(call, s.container, sha256Hex)
const fmtDate = (sec) => new Date(sec * 1000).toLocaleString()
// Why the manifest on chain cannot be renewed (codes from lib.js). / 链上清单为何不能续期（lib.js 的代码）。
const whyNot = (a) => ({
  NO_MANIFEST: bi('这个容器还没有清单', 'this container has no manifest yet'),
  INVALID: bi(`链上清单不完整（${a.detail}）`, `the manifest on chain is incomplete (${a.detail})`),
  WRONG_CIRCUIT: bi(`链上清单写的是另一个电路（${a.detail}）`, `the manifest on chain names another circuit (${a.detail})`),
  BAD_SIGNATURE: bi('链上清单的委托签名不是客户端能验证的普通签名', 'the delegation on chain is not a plain signature that clients can verify'),
  NOT_HOLDER: bi(`链上清单的委托是 ${a.detail} 签的，不是当前持有人（电路可能换过主人）`, `the delegation on chain was signed by ${a.detail}, not by the current holder (the circuit may have changed hands)`),
}[a.code] || bi(`代码 ${a.code}`, `code ${a.code}`))
function showOnChain(out, a) {
  if (!a.ok) { note(out, null, [whyNot(a), bi('。不能续期：请用第 3 步生成的新密钥设置服务。', '. Nothing to renew: set the service up with a new key from step 3.')]); return }
  const expired = a.expires <= Date.now() / 1000
  kv(out, [[bi('链上已授权的签名地址', 'Signing address authorised on chain'), a.signer], [bi('链上服务网址', 'Service URL on chain'), a.endpoints.join(' ')], [bi('委托到期', 'Delegation expires'), fmtDate(a.expires)]])
  if (expired) note(out, false, bi('链上这份委托已经过期：客户端现在不接受这个服务的回答，续期后恢复。', 'This delegation on chain has expired: clients refuse this service\'s answers until it is renewed.'))
  note(out, true, bi('✓ 链上清单的委托是你（当前持有人）签的，授权的就是上面这个签名地址。续期不必换密钥：在第 4 步点「续期」。', '✓ The delegation on chain was signed by you, the current holder, and authorises the signing address above. Renewing needs no new key: use "Renew" in step 4.'))
}

// A circuit read on another chain (the selector changed since) is not this page's circuit. / 在别的链上读到的电路不算。
const hereSvc = () => { const s = svcState(); return (s.chainId ?? 56) === CHAIN.chainId ? s : {} }
const enableSvc = () => {
  const s = hereSvc(), again = s.published || s.publishPending
  $('btn-circuit').disabled = !account; $('btn-deleg').disabled = !account || !s.container
  $('renew-box').hidden = !onChain?.ok
  $('btn-renew').disabled = !account || !s.container || !onChain?.ok || $('moved').checked
  $('btn-publish').disabled = !account || !s.sig || (again && !$('republish').checked)
  if (again) {
    $('republish-wrap').hidden = false; $('publish-prev').hidden = false
    $('publish-prev').replaceChildren(...(s.published
      ? [bi('这台设备上已发布过（', 'Already published from this device ('), txLink(s.published), bi('）。只有在第 4 步续期委托后才需要再发布。', '). Publish again only after renewing the delegation in step 4.')]
      : [bi('有一笔发布交易还在等待：', 'A publish transaction is still waiting: '), txLink(s.publishPending), bi(`。先在 ${CHAIN.explorerName} 查看，不要重复发送。`, `. Check it on ${CHAIN.explorerName} first; do not send it twice.`)]))
  }
}
new MutationObserver(enableSvc).observe($('wallet-status'), { childList: true, characterData: true, subtree: true })

$('btn-circuit').onclick = async () => {
  const out = $('circuit-out'); out.replaceChildren()
  onChain = null; $('moved').checked = false; enableSvc()
  try {
    const c = await C.readCircuit(call, { processor: $('c-proc').value.trim(), tokenId: $('c-id').value.trim() })
    kv(out, [[bi('电路合约', 'Circuit contract'), c.circuits], [bi('电路编号', 'Circuit number'), c.tokenId], [bi('容器', 'Container'), c.container], [bi('当前持有人', 'Current holder'), c.holder]])
    if (c.holder.toLowerCase() !== account.toLowerCase()) { note(out, false, bi(`你连接的钱包（${account}）不是这个电路的持有人。请用持有它的钱包打开本页。`, `The connected wallet (${account}) is not this circuit's holder. Open this page with the wallet that holds it.`)); return }
    note(out, true, bi('✓ 你就是这个电路的持有人', '✓ You are this circuit\'s holder'))
    // An unopened container has no code, and SiteRegistry refuses its files (NotOwner) even from the holder.
    // 没开通的容器没有代码，SiteRegistry 连持有人也会拒绝（NotOwner）。
    if ((await rpc('eth_getCode', [c.container, 'latest'])) === '0x') { note(out, false, bi('这个电路的容器还没开通（电路页面 →「容器」→ 开通）。开通后再读取一次。', 'This circuit\'s container is not opened yet (circuit page → "Container" → open it). Read again once it is.')); return }
    note(out, true, bi('✓ 容器已开通', '✓ The container is open'))
    // A circuit read here starts a new publication: the previous one's "already published" guard does not carry over.
    // 在这里读到的电路是一次新的发布：上一个的“已发布过”标记不沿用。
    saveSvc({ chainId: CHAIN.chainId, circuits: c.circuits, tokenId: c.tokenId, container: c.container, holder: c.holder, sig: undefined, expires: undefined, published: undefined, publishPending: undefined })
    showVars(); enableSvc()
    // A manifest already on chain whose delegation you signed can be renewed for the same key (step 4).
    // 链上已有、委托由你签的清单，可以为同一把密钥续期（第 4 步）。
    try { onChain = C.onChainAuthorisation(await readOnChain(c), c); showOnChain(out, onChain) }
    catch (e) { note(out, false, bi(`读不出可核对的链上清单（${e.message}），不能续期；可以用第 3 步的新密钥设置（第 5 步会替换它）。`, `Could not read a verifiable manifest on chain (${e.message}), so there is nothing to renew; you can set up with a new key from step 3 (step 5 replaces it).`)) }
    enableSvc()
  } catch (e) { note(out, false, bi(`读取失败：${e.message}`, `Read failed: ${e.message}`)) }
}

$('btn-key').onclick = () => {
  const out = $('key-out'); out.replaceChildren()
  const k = C.newSignerKey(), keyAddress = C.addressOfKey(k)
  // Only the address is kept (it is public); step 4 signs for this address and no other. / 只保存地址（公开的）；第 4 步只为它签。
  saveSvc({ keyAddress, sig: undefined, expires: undefined })
  note(out, null, bi('这是服务密钥（只显示这一次）。它不是你的钱包，泄露了只会让别人能以你的服务名义回答，直到委托到期；但请像密码一样对待它。', 'This is the service key (shown only this once). It is not your wallet: if it leaks, someone can answer in your service\'s name until the delegation expires. Treat it like a password.'))
  note(out, false, bi('只粘贴到 Cloudflare。不要发给任何人，不要截图。', 'Paste it into Cloudflare only. Do not send it to anyone, and do not take a screenshot.'))
  const box = document.createElement('div'); kv(box, [['SIGNER_KEY', k]]); box.append(copyBtn(t('复制 SIGNER_KEY', 'Copy SIGNER_KEY'), k)); out.append(box)
  kv(out, [[bi('它的地址（服务会报出这个地址）', 'Its address (the service will report this address)'), keyAddress]])
  // Once pasted, take the key off the page and out of the clipboard (review F3). / 粘贴好后，把密钥从页面和剪贴板清掉（审查 F3）。
  const done = document.createElement('button'); done.type = 'button'; done.className = 'ghost'; done.append(bi('已粘贴到 Cloudflare：清除页面上的密钥和剪贴板', 'Pasted into Cloudflare: clear the key from the page and the clipboard'))
  done.onclick = async () => { box.remove(); done.remove(); try { await navigator.clipboard.writeText('') } catch { /* nothing to do / 无需处理 */ } note(out, true, bi('✓ 密钥已从页面清除。上面的地址会在第 4 步用来核对。', '✓ The key is cleared from the page. Step 4 checks the address above.')) }
  out.append(done)
  showVars(); enableSvc()
}

// Step 4, either path: "fresh" signs for the key generated in step 3; "renew" signs for the key the manifest on chain
// already names, which the current holder authorised (lib decideSigner). Both need the service to report exactly that
// address, and both go through the same wallet checks below. / 第 4 步两条路：新密钥只为第 3 步生成的密钥签；续期只为链上
// 清单里、当前持有人授权过的那把密钥签（lib decideSigner）。两者都要求服务报出的正是这个地址，并经过下面同样的钱包检查。
$('btn-deleg').onclick = () => signDelegation(false)
$('btn-renew').onclick = () => signDelegation(true)
$('moved').onchange = enableSvc
async function signDelegation(renew) {
  const out = $('deleg-out'); out.replaceChildren()
  try {
    const s = hereSvc(), base = $('svc-url').value.trim().replace(/\/+$/, '')
    if (!C.isServiceBase(base)) { note(out, false, bi(`服务网址必须是 https://主机名，不带路径（现在是 ${base}）。`, `The service URL must be https://hostname with no path (it is ${base}).`)); return }
    if (!renew && !s.keyAddress) { note(out, false, bi('本页没有记录你生成的服务密钥。请回到第 3 步重新生成，并把新的 SIGNER_KEY 设到 Cloudflare。', 'This page has no record of a generated service key. Go back to step 3, generate one, and set the new SIGNER_KEY in Cloudflare.')); return }
    const h = await (await fetch(`${base}/tapeapi/v1/health`, { cache: 'no-store' })).json()
    if (!h.signer || !/^0x[0-9a-fA-F]{40}$/.test(h.signer)) {
      const missing = (Array.isArray(h.missing) ? h.missing : []).filter((m) => /^[A-Z_]{1,32}( \(secret\))?$/.test(m))
      note(out, false, bi(`服务还没有签名地址（缺：${missing.join('、') || '未知'}）。先在 Cloudflare 设好 SIGNER_KEY 并等它重新部署。`, `The service has no signing address yet (missing: ${missing.join(', ') || 'unknown'}). Set SIGNER_KEY in Cloudflare first and wait for it to redeploy.`)); return
    }
    // The manifest on chain, read again now (never through the service), decides renewal and whether the URL may
    // differ from the one on chain. One that cannot be verified gives nothing to renew and no URL to keep, but must not
    // block a fresh setup, which is how it gets replaced. / 现在重新读链上清单（从不经过服务），决定能否续期、网址能否与链上
    // 不同。无法核对的清单没有可续期的东西、也没有要保持的网址，但不能挡住新密钥设置——坏清单正是靠它替换。
    let text
    try { text = await readOnChain(s) } catch (e) {
      if (renew || e.code !== 'UNVERIFIABLE') throw e
      note(out, null, bi(`链上已有的清单无法核对（${e.message}），不能续期；按第 3 步的新密钥继续。`, `The manifest on chain cannot be verified (${e.message}), so there is nothing to renew; continuing with the new key from step 3.`))
      text = null
    }
    onChain = C.onChainAuthorisation(text, s); enableSvc()
    // Sign only for the key generated on this page (security review F1). / 只为本页生成的密钥签（安全审查 F1）。
    if (!renew && h.signer.toLowerCase() !== s.keyAddress.toLowerCase()) {
      note(out, false, bi(`服务报出的签名地址 ${h.signer} 不是你在第 3 步生成的密钥（${s.keyAddress}）。检查服务网址；或把第 3 步最后生成的那把 SIGNER_KEY 重新粘贴到 Cloudflare，等一分钟再试。`, `The service reports signing address ${h.signer}, which is not the key you generated in step 3 (${s.keyAddress}). Check the service URL, or paste the SIGNER_KEY generated last in step 3 into Cloudflare again and retry in a minute.`))
      if (onChain.ok && h.signer.toLowerCase() === onChain.signer.toLowerCase()) note(out, null, bi('服务报出的正是链上已授权的签名地址：如果只是续期，请点下面的「续期」。', 'The service reports the signing address already authorised on chain: if you are renewing, use "Renew" below.'))
      return
    }
    const d = C.decideSigner({ text, circuit: s, base, health: h, keyAddress: s.keyAddress, renew, moved: $('moved').checked })
    if (!d.ok) {
      const why = {
        ENDPOINT_MISMATCH: () => bi(`链上清单的服务网址是 ${d.endpoints?.join(' ')}，不是你填的 ${base}/tapeapi/v1。续期请填链上的网址；如果服务确实搬到了新网址，勾选「服务已搬到新网址」，并用第 3 步生成的新密钥设置。`, `The service URL on chain is ${d.endpoints?.join(' ')}, not ${base}/tapeapi/v1 as typed. To renew, enter the URL on chain; if the service really moved, tick "The service moved" and set it up with a new key from step 3.`),
        MOVED: () => bi('你勾选了「服务已搬到新网址」：不能续期，只能用第 3 步生成的新密钥。', 'You ticked "The service moved": renewal is off, only a new key from step 3 can be authorised.'),
        SIGNER_MISMATCH: () => bi(`服务报出的签名地址 ${d.reported} 不是链上已授权的 ${d.signer}。续期只为链上那把密钥签：检查服务网址，或确认 Cloudflare 里的 SIGNER_KEY 没有换过。`, `The service reports signing address ${d.reported}, not ${d.signer}, which is authorised on chain. Renewal signs only for that key: check the service URL, or make sure SIGNER_KEY in Cloudflare was not changed.`),
        KEY_MISMATCH: () => bi(`服务报出的签名地址 ${d.reported} 不是你在第 3 步生成的密钥（${d.signer}）。`, `The service reports signing address ${d.reported}, not the key you generated in step 3 (${d.signer}).`),
      }[d.code]
      note(out, false, why ? why() : [whyNot(d), bi('。不能续期。', '. There is nothing to renew.')])
      return
    }
    const expires = Math.floor(Date.now() / 1000) + 90 * 86400
    // signed for the page's chain (C.useChain): EIP-712 domain (chainId, DeWebHub) / 为本页的链签：EIP-712 域 (chainId, DeWebHub)
    const typed = renew ? C.delegationTypedData({ container: s.container, signer: d.signer, expires }) : C.delegationTypedData({ container: s.container, signer: s.keyAddress, expires })
    kv(out, [[renew ? bi('授权的签名地址（链上清单里你已授权的密钥）', 'Signing address authorised (the key you already authorised on chain)') : bi('授权的签名地址（第 3 步生成的密钥）', 'Signing address authorised (the key from step 3)'), d.signer], [bi('代表的容器', 'For the container'), s.container], [bi('服务网址', 'Service URL'), `${base}/tapeapi/v1`], [bi('到期', 'Expires'), new Date(expires * 1000).toLocaleString()]])
    if (renew) note(out, null, bi(`续期：链上委托（到期 ${fmtDate(d.onChain.expires)}）是你签给这个地址的，服务也报出同一个地址。新委托只把它的期限延长到上面的日期，不授权任何新密钥。`, `Renewal: the delegation on chain (expires ${fmtDate(d.onChain.expires)}) is yours, for this address, and the service reports the same address. The new delegation only extends it to the date above; it authorises no new key.`))
    note(out, null, bi('请在钱包里确认签名（EIP-712 "Delegation"，不涉及资金）…', 'Confirm the signature in your wallet (EIP-712 "Delegation", no funds involved)…'))
    await ensureSame()
    const sig = await rpc('eth_signTypedData_v4', [account, JSON.stringify(typed)])
    // The signature must be a plain 65-byte one from the holder read in step 2 (review F4): some wallets sign with
    // whichever account is active, and smart accounts return other formats that clients cannot verify.
    // 签名必须是第 2 步读到的持有人做出的普通 65 字节签名（审查 F4）：有些钱包用当前活动账户签，智能账户返回的格式客户端无法验证。
    const by = C.recoverAddress(C.delegationDigest({ container: s.container, signer: d.signer, expires }), sig)
    if (!by) throw new Error(t('钱包返回的不是客户端能验证的普通签名（65 字节、低 s；智能账户钱包不行），请换用普通钱包账户', 'the wallet did not return a plain signature that clients can verify (65 bytes, low s; smart-account wallets cannot); use an ordinary wallet account'))
    if (by.toLowerCase() !== String(s.holder || '').toLowerCase()) throw new Error(t(`签名来自 ${by}，不是电路持有人 ${s.holder}。请切回持有人账户，刷新后从第 2 步重来`, `the signature is from ${by}, not the circuit's holder ${s.holder}. Switch back to the holder's account, reload, and start again from step 2`))
    saveSvc({ signer: d.signer, expires, sig, endpoint: `${base}/tapeapi/v1` })
    note(out, true, renew
      ? bi('✓ 已签名（续期）。SIGNER_KEY 不用改：在 Cloudflare 里只把 DELEGATION_EXPIRES 和 DELEGATION_SIG 换成下面两个值（类型选“文本”，“密钥”方框不打勾），保存部署后做第 5 步。', '✓ Signed (renewal). Leave SIGNER_KEY as it is: in Cloudflare, only replace DELEGATION_EXPIRES and DELEGATION_SIG with the two values below (type Text, Encrypt / Secret not ticked); once saved and redeployed, go to step 5.')
      : bi('✓ 已签名。把下面两个值加到 Cloudflare 的变量里（类型选“文本”，“密钥”方框不打勾），保存部署后做第 5 步。', '✓ Signed. Add the two values below to the Cloudflare variables (type Text, Encrypt / Secret not ticked); once saved and redeployed, go to step 5.'))
    kv(out, [['DELEGATION_EXPIRES', String(expires)]]); out.append(copyBtn(t('复制 DELEGATION_EXPIRES', 'Copy DELEGATION_EXPIRES'), String(expires)))
    kv(out, [['DELEGATION_SIG', sig]]); out.append(copyBtn(t('复制 DELEGATION_SIG', 'Copy DELEGATION_SIG'), sig))
    showVars(); enableSvc()
  } catch (e) { note(out, false, bi(`没有完成：${e.message}`, `Not completed: ${e.message}`)) }
}

// The tools of a taped-out MCP server, as the holder must see them before signing: every field the digest pins (name,
// title, description, inputSchema with its nested descriptions, outputSchema, annotations), as text. A one-line summary
// per tool, then the whole pinned tool as pretty-printed JSON. Invisible characters were refused before this runs
// (mcpToolsProblems), so what is shown is all a model will read. / 已 tape out 的 MCP 服务器的工具：签名前持有人必须看到摘要钉住的
// 每个字段（name、title、description、含嵌套说明的 inputSchema、outputSchema、annotations），都作为纯文本显示。每个工具先一行摘要，
// 再是整个钉住的工具（格式化 JSON）。不可见字符在此之前已被拒绝（mcpToolsProblems），所以显示的就是模型将读到的全部内容。
function showTools(out, mcp, tools) {
  note(out, true, bi(`✓ MCP 工具定义核对通过：从 ${mcp.endpoint} 读到的 ${tools.length} 个工具，本页算出的摘要等于服务报出的 toolsSha256（${mcp.toolsSha256}），且不含看不见的字符。这个摘要随清单写上链，客户端只接受与它一致的工具定义，模型会读到下面每个字段（name、title、description、inputSchema 及其中的说明、outputSchema、annotations）。签名前请逐个看一遍：`,
    `✓ The MCP tool definitions check out: the ${tools.length} tools read from ${mcp.endpoint} hash, as computed by this page, to the toolsSha256 the service reports (${mcp.toolsSha256}), and carry no invisible characters. That digest goes on chain with the manifest, clients accept only tool definitions that match it, and a model reads every field below (name, title, description, inputSchema with the descriptions inside it, outputSchema, annotations). Read each one before you sign:`))
  const ul = document.createElement('ul'); ul.className = 'tools'
  for (const tool of C.normalizeTools(tools)) {
    const li = document.createElement('li'), name = document.createElement('code'), desc = document.createElement('span')
    name.textContent = tool.name
    desc.textContent = `${typeof tool.title === 'string' && tool.title ? ` (${tool.title})` : ''}${typeof tool.description === 'string' && tool.description ? ` — ${tool.description}` : ''}`
    // Everything pinned for this tool, exactly as hashed: title, description, inputSchema, outputSchema, annotations.
    // 这个工具被钉住的全部内容，与参与哈希的完全一致。
    const pre = document.createElement('pre'); pre.className = 'mono'; pre.textContent = JSON.stringify(tool, null, 2)
    li.append(name, desc, pre); ul.append(li)
  }
  out.append(ul)
}

// ---------------------------------------------------------------- an AI service's price table ----
// The `ai` field (TAPI-20 §3.9): every API format's address and every model's prices, per currency, per 1M tokens, as the
// holder must see them before the wallet writes them on chain. Stated prices in plain type; a price the spec fills in
// (a cache price from input, reasoning from output) in grey italics; a hinted cell highlighted. Hints never block.
// Everything is text (textContent), never markup: the model ids come from the service or the pasted file.
// ai 字段：每种接口格式的地址、每个模型各币种的价格（每 1M tokens），钱包写上链之前持有人必须看到。写明的价格正常显示；按规范
// 缺省补上的（缓存价取 input、推理价取 output）灰色斜体；有提示的格子高亮。提示从不拦截。全部是纯文本（textContent），从不是标记。
// Strings, not fragments: a fragment is emptied when appended, so the second table would lose its headers.
// 存字符串而不是片段：片段插入后即清空，第二次渲染会丢掉表头。
const AI_COLS = [['input', '输入', 'Input'], ['output', '输出', 'Output'], ['cacheRead', '缓存读', 'Cache read'], ['cacheWrite', '缓存写', 'Cache write'], ['cacheWrite1h', '缓存写 1h', 'Cache write 1h'], ['reasoning', '推理', 'Reasoning']]
const cell = (tag, content, cls = '') => { const c = document.createElement(tag); if (cls) c.className = cls; c.replaceChildren(...nodes(content)); return c }
function showPriceTable(out, field) {
  const tb = C.aiPriceTable(field)
  const eps = document.createElement('table'); eps.className = 'prices'
  eps.append(cell('tr', [cell('th', bi('接口格式', 'API format')), cell('th', bi('地址（baseUrl）', 'Address (baseUrl)'))]))
  for (const e of tb.endpoints) eps.append(cell('tr', [cell('td', `${e.format}${e.api ? ` (${e.api})` : ''}`), cell('td', e.baseUrl, 'mono')]))
  const w1 = cell('div', eps, 'scroll')
  const flagged = new Set(tb.hints.filter((h) => h.key || h.code === 'OUTPUT_BELOW_INPUT' || h.code === 'CACHE_READ_ABOVE_INPUT').flatMap((h) => {
    const keys = h.key ? [h.key] : h.code === 'OUTPUT_BELOW_INPUT' ? ['input', 'output'] : ['input', 'cacheRead']
    return keys.map((k) => `${h.model}\u0000${h.currency}\u0000${k}`)
  }))
  const tbl = document.createElement('table'); tbl.className = 'prices'
  tbl.append(cell('tr', [cell('th', bi('模型 id / 别名', 'Model id / aliases')), cell('th', bi('币种', 'Currency')), ...AI_COLS.map(([, zh, en]) => cell('th', bi(zh, en)))]))
  for (const m of tb.models) {
    m.prices.forEach((p, i) => {
      const tr = document.createElement('tr')
      if (i === 0) {
        const td = cell('td', m.id, 'model mono'); td.rowSpan = m.prices.length
        if (m.aliases.length) td.append(document.createElement('br'), cell('span', m.aliases.join(', '), 'muted'))
        if (m.formats) td.append(document.createElement('br'), cell('span', `formats: ${m.formats.join(', ')}`, 'muted'))
        tr.append(td)
      }
      tr.append(cell('td', p.currency))
      for (const [k] of AI_COLS) {
        const c = p.cells[k], bad = flagged.has(`${m.id}\u0000${p.currency}\u0000${k}`)
        const td = cell('td', c.value, `num${c.from ? ' dflt' : ''}${bad ? ' flag' : ''}`)
        if (c.from) td.title = t(`未单列，按 ${c.from} 计`, `not stated: priced as ${c.from}`)
        tr.append(td)
      }
      tbl.append(tr)
    })
  }
  const w2 = cell('div', tbl, 'scroll')
  const models = tb.models.length, rows = tb.models.reduce((n, m) => n + m.prices.length, 0)
  note(out, true, bi(`✓ 价目表符合 TAPI-20 §3.9（与 SDK 的检查相同）：${tb.endpoints.length} 个接口地址，${models} 个模型，${rows} 行价格，单位都是每 1M tokens。`, `✓ The price table follows TAPI-20 §3.9 (the SDK's own checks): ${tb.endpoints.length} API addresses, ${models} models, ${rows} price rows, every price per 1M tokens.`))
  if (CHAIN.chainId !== 56) note(out, null, bi(`本页在 ${CHAIN.name} 上：这里支付暂不开放，价格只作公示。`, `This page is on ${CHAIN.name}: payments are not open here yet; the prices are for display only.`))
  out.append(w1, w2)
  out.append(cell('p', bi('灰色斜体：清单里没有单列，按规范取另一列的价格（缓存读、缓存写取输入价，1 小时缓存写取缓存写价，推理取输出价）。高亮：下面有提示。', 'Grey italics: not stated in the manifest, so the spec prices it as another column (cache reads and writes as input, 1-hour cache writes as cache writes, reasoning as output). Highlighted: see the hints below.'), 'muted'))
  const warns = tb.hints.filter((h) => h.level === 'warn')
  if (tb.hints.length) {
    if (warns.length) note(out, false, bi(`${warns.length} 条提示，请签名前核对（只是提示，不会阻止发布）：`, `${warns.length} hints to check before you sign (hints only; they do not stop publishing):`))
    const ul = document.createElement('ul'); ul.className = 'hints'
    for (const h of tb.hints) { const li = cell('li', bi(h.zh, h.en), h.level); ul.append(li) }
    out.append(ul)
  } else note(out, true, bi('没有异常提示。', 'No hints: nothing looks unusual.'))
}
// The table the holder previewed, normalised; memory only. When set, step 5 publishes only if the service serves exactly
// it. / 持有人预览过的价目表（规范化后），只放在内存里；设置后，第 5 步只在服务提供的与它一字不差时才发布。
let aiPreviewed = null
const aiBase = () => $('svc-url').value.trim().replace(/\/+$/, '')
function previewAI() {
  const out = $('ai-out'); out.replaceChildren(); aiPreviewed = null
  const text = $('ai-json').value.trim()
  if (!text) { note(out, false, bi('先粘贴价目表，或上传 models.json。', 'Paste a price table or upload a models.json first.')); return }
  let field
  try { field = C.aiFieldOf(C.strictParseJSON(text), { base: aiBase() }) } catch (e) { note(out, false, bi(`读不懂这段价目表：${e.message}`, `Cannot read this price table: ${e.message}`)); return }
  const bad = C.aiProblems(field, { allowHttp: aiBase().startsWith('http:') })
  if (bad.length) { note(out, false, bi(`价目表不符合 TAPI-20 §3.9，客户端会拒绝它：${bad.join('；')}`, `The price table breaks TAPI-20 §3.9, and clients would refuse it: ${bad.join('; ')}`)); return }
  aiPreviewed = C.normalizeAI(field, { allowHttp: aiBase().startsWith('http:') })
  showPriceTable(out, aiPreviewed)
}
$('btn-ai-preview').onclick = previewAI
$('ai-file').onchange = async () => {
  const f = $('ai-file').files?.[0]
  if (!f) return
  if (f.size > 1024 * 1024) { say($('ai-out'), bi('文件超过 1 MB，不像价目表。', 'The file is over 1 MB; that is not a price table.'), 'bad'); return }
  $('ai-json').value = await f.text()
  previewAI()
}
$('ai-l2-note').hidden = CHAIN.chainId === 56

$('btn-publish').onclick = async () => {
  const out = $('publish-out'); out.replaceChildren()
  $('btn-publish').disabled = true   // one tap, one transaction (review F5) / 一次点击一笔交易
  let sent = false
  try {
    const s = hereSvc(), base = s.endpoint.replace(/\/tapeapi\/v1$/, '')
    const served = await (await fetch(`${base}/.well-known/tapeapi.json`, { cache: 'no-store' })).text()
    const problems = C.manifestProblems(served, s)
    if (problems.length) { note(out, false, bi(`服务提供的清单与你签的不一致，暂不上链：${problems.join('；')}。通常是变量还没生效，等一两分钟再试。`, `The manifest the service serves does not match what you signed, so nothing is published: ${problems.join('; ')}. Usually the variables have not taken effect yet; retry in a minute or two.`)); return }
    // Publish the page's own bytes, built from what you read and signed; the service only has to agree (review F2).
    // 发布页面自己构造的字节（来自你读到和签过的内容）；服务只需与之一致（审查 F2）。
    const sm = JSON.parse(served)
    // A taped-out MCP server (the manifest has `mcp`): the page reads the tools from mcp.endpoint itself and hashes them as
    // every client will (lib toolsDigest); only if that equals the toolsSha256 the service reports, and every method is one
    // of those tools, is anything published. / 已 tape out 的 MCP 服务器：页面自己从 mcp.endpoint 读工具、按客户端的方法算摘要；
    // 等于服务报出的 toolsSha256、且每个方法都是其中的工具，才发布。
    let tools = null
    if (sm.mcp !== undefined) {
      note(out, null, bi(`这是一个 MCP 服务：正在从 ${sm.mcp.endpoint} 读取它的工具定义…`, `This is an MCP service: reading its tool definitions from ${sm.mcp.endpoint}…`))
      try { tools = await C.fetchMcpTools(sm.mcp.endpoint) } catch (e) {
        note(out, false, bi(`读不到 ${sm.mcp.endpoint} 的工具列表（${e.message}），暂不上链。本页必须自己核对工具定义：这个 MCP 端点要允许 https://tapeapi.fun 跨域访问（CORS：允许 POST 以及 content-type、mcp-session-id、mcp-protocol-version 请求头，并暴露 mcp-session-id 响应头）。`,
          `Could not read the tool list from ${sm.mcp.endpoint} (${e.message}), so nothing is published. This page must check the tool definitions itself: the MCP endpoint has to allow cross-origin requests from https://tapeapi.fun (CORS: POST with the content-type, mcp-session-id and mcp-protocol-version request headers, and the mcp-session-id response header exposed).`))
        return
      }
      const bad = await C.mcpToolsProblems({ mcp: sm.mcp, methods: sm.methods, tools })
      if (bad.length) { note(out, false, bi(`MCP 工具定义核对不通过，暂不上链：${bad.join('；')}。`, `The MCP tool definitions do not check out, so nothing is published: ${bad.join('; ')}.`)); return }
    }
    // An AI service (the manifest has `ai`): manifestProblems has checked it as the SDK does; a table previewed above must
    // be exactly the one served, and the table is shown before the wallet asks. / AI 服务：manifestProblems 已按 SDK 的规则
    // 核对；上面预览过的价目表必须与服务提供的一字不差，并在钱包请求之前展示。
    let aiField = null
    if (sm.ai !== undefined) {
      aiField = C.normalizeAI(sm.ai, { allowHttp: base.startsWith('http:') })
      const diff = aiPreviewed ? C.aiDiff(aiPreviewed, aiField) : []
      if (diff.length) { note(out, false, bi(`服务提供的价目表与你上面预览的不一致，暂不上链：${diff.join('；')}。`, `The price table the service serves is not the one you previewed above, so nothing is published: ${diff.join('; ')}.`)); return }
    } else if (aiPreviewed) { note(out, false, bi('你上面预览了价目表，但服务提供的清单没有 ai 字段，暂不上链。检查旁路的 models.json 与服务网址。', 'You previewed a price table above, but the manifest the service serves has no ai field, so nothing is published. Check the sidecar\'s models.json and the service URL.')); return }
    const text = C.manifestText({ ...s, name: sm.name, methods: sm.methods, mcp: sm.mcp, ai: sm.ai })
    const size = new TextEncoder().encode(text).length, names = sm.methods.map((x) => x.name)
    note(out, true, bi(`✓ 清单核对通过（${size} 字节）。服务名「${sm.name}」，${names.length} 个免费方法：${names.join('、')}。将写上链的完整内容：`, `✓ The manifest checks out (${size} bytes). Service name "${sm.name}", ${names.length} free methods: ${names.join(', ')}. The full content to be written on chain:`))
    if (tools) showTools(out, sm.mcp, tools)
    if (aiField) { note(out, null, bi('这是一个 AI 服务，清单带下面这份价目表：', 'This is an AI service; the manifest carries this price table:')); showPriceTable(out, aiField) }
    const pre = document.createElement('pre'); pre.className = 'mono'; pre.textContent = JSON.stringify(JSON.parse(text), null, 2); out.append(pre)
    const sha = '0x' + Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))).map((b) => b.toString(16).padStart(2, '0')).join('')
    const tx = C.putFileTx({ container: s.container, text, sha256Hex: sha })
    await ensureSame()
    try { await rpc('eth_estimateGas', [{ from: account, to: tx.to, data: tx.data }]) } catch (e) {
      const why = /30cd7471/.test(JSON.stringify(e?.data ?? '') + (e?.message ?? '')) ? t('这个钱包不能写这个容器的站点（NotOwner）：容器没开通，或你不是持有人', 'this wallet cannot write this container\'s site (NotOwner): the container is not opened, or you are not the holder') : e.message
      throw new Error(t(`预检没有通过，没有发送交易：${why}`, `the pre-flight check failed, no transaction was sent: ${why}`))
    }
    // What the wallet will show, to compare before confirming: the transaction goes to SiteRegistry, and its data carries
    // the container and the manifest's SHA-256 (both without 0x). / 确认前可对照钱包显示的内容：发往 SiteRegistry，数据里有容器和清单的 SHA-256（都不带 0x）。
    kv(out, [[bi('容器', 'Container'), s.container], [bi('清单 SHA-256', 'Manifest SHA-256'), sha], [bi('交易发往（SiteRegistry）', 'Transaction to (SiteRegistry)'), tx.to]])
    note(out, null, bi('请在钱包里确认写入交易（SiteRegistry.putFile）。确认前请对照：交易发往上面的 SiteRegistry 地址，交易数据里包含上面的容器地址和 SHA-256（不带 0x）。', 'Confirm the write (SiteRegistry.putFile) in your wallet. Before confirming, compare: the transaction goes to the SiteRegistry address above, and its data contains the container address and the SHA-256 above (without 0x).'))
    const hash = await rpc('eth_sendTransaction', [{ from: account, chainId: CHAIN_HEX, to: tx.to, data: tx.data, value: tx.value }])
    sent = true; saveSvc({ publishPending: hash })
    note(out, null, [bi('已发出 ', 'Sent '), txLink(hash), bi('，等待上链…', ', waiting for it to be mined…')])
    let rc = null
    for (let i = 0; i < 120 && !rc; i++) { await sleep(3000); rc = await rpc('eth_getTransactionReceipt', [hash]) }
    if (!rc) throw new Error(notMined(hash))
    if (rc.status !== '0x1') throw new Error(failed(rc))
    saveSvc({ published: hash, sha, publishPending: undefined })
    note(out, true, [bi(`✓ 清单已写上链（容器 ${s.container}）。请保存交易备查：`, `✓ The manifest is on chain (container ${s.container}). Keep the transaction for your records: `), txLink(hash)])
    out.append(copyBtn(t('复制交易哈希', 'Copy transaction hash'), hash))
    // Read it back from the chain as every client reads it (fileInfo, read, exact length and SHA-256) and compare with the
    // bytes sent, the price table included. The wallet's node may lag a block: a few tries, and a miss says "check later".
    // 像每个客户端一样从链上回读（fileInfo、read、长度与 SHA-256 严格一致），与发出的字节比较（包括价目表）。钱包的节点可能
    // 落后一个区块：多试几次；仍不一致只提示稍后再核对。
    let back = []
    for (let i = 0; i < 5; i++) {
      try { back = C.readBackProblems(await readOnChain(s), text) } catch (e) { back = [e.message] }
      if (!back.length) break
      await sleep(4000)
    }
    if (back.length) note(out, null, bi(`交易已上链，但回读核对还没通过（${back.join('；')}）。可能是节点还没同步，稍后在第 2 步重新读取即可核对。`, `The transaction is on chain, but reading it back does not match yet (${back.join('; ')}). The node may be behind; read the circuit again in step 2 later to check.`))
    else note(out, true, bi(`✓ 回读核对通过：链上的清单与本页发出的字节完全一致（${size} 字节${aiField ? '，包括价目表' : ''}）。`, `✓ Read back from the chain: the manifest there is byte for byte what this page sent (${size} bytes${aiField ? ', the price table included' : ''}).`))
  } catch (e) { note(out, false, bi(`没有完成：${e.message}`, `Not completed: ${e.message}`)) } finally {
    // After a send, publishing again needs the explicit box (renewing the delegation is the reason to); a check that
    // failed before sending leaves the button on for a retry. / 发出后再发布需要勾选；发送前失败则按钮保持可用以便重试。
    if (sent) { $('republish-wrap').hidden = false; $('republish').checked = false }
    enableSvc()
  }
}
$('republish').onchange = enableSvc
showVars(); enableSvc()
