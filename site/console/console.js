// The holder console's page script (a module, loaded from index.html so the page can run under script-src 'self').
// Steps: 1 connect, 2 read the circuit, 3 service key and variables, 4 sign the delegation, 5 publish the manifest;
// "Advanced" (A deploy, B verify) is only for someone deploying their own ChannelBus.
// 持有人操作台的页面脚本（模块，从 index.html 加载，使页面能在 script-src 'self' 下运行）。
// 步骤：1 连接、2 读电路、3 服务密钥与变量、4 签委托、5 发布清单；“高级”（A 部署、B 核对）只给自己部署 ChannelBus 的人。
import * as C from './lib.js'

const $ = (id) => document.getElementById(id)
const BSC = '0x38'
const store = { get: (k) => { try { return JSON.parse(localStorage.getItem(k)) } catch { return null } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* private mode */ } } }
// Text in the current language (for strings: errors, button labels). / 当前语言的文本（用于字符串：错误、按钮文字）。
const t = (zh, en) => (document.documentElement.getAttribute('data-lang') === 'zh' ? zh : en)
// Both languages as <span lang> nodes, so a message follows the language switch. / 两种语言的 <span lang>，随语言切换。
const bi = (zh, en) => { const f = document.createDocumentFragment(); for (const [l, s] of [['zh', zh], ['en', en]]) { const sp = document.createElement('span'); sp.lang = l; sp.textContent = s; f.append(sp) } return f }
const nodes = (content) => [].concat(content)
const say = (el, content, cls = '') => { el.className = `status ${cls}`; el.replaceChildren(...nodes(content)) }
// A transaction hash as a BscScan link; anything that is not a hash stays plain text. / 交易哈希显示为 BscScan 链接；不是哈希的保持纯文本。
const txLink = (hash) => {
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(hash))) return document.createTextNode(String(hash))
  const a = document.createElement('a'); a.href = `https://bscscan.com/tx/${hash}`; a.target = '_blank'; a.rel = 'noopener'; a.className = 'mono'; a.textContent = hash; return a
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
  if ((await rpc('eth_chainId')) !== BSC) throw new Error(t('钱包已不在 BNB Chain', 'the wallet is no longer on BNB Chain'))
}
const hexToBig = (h) => BigInt(h)
const fmtBNB = (wei) => { const s = (Number(wei) / 1e18).toFixed(8).replace(/0+$/, '').replace(/\.$/, ''); return `${s} BNB` }
const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const notMined = (hash) => t(`6 分钟内没有上链，稍后用交易哈希 ${hash} 在 BscScan 查看`, `not mined within 6 minutes; look up ${hash} on BscScan later`)
const failed = (rc) => t(`交易失败（status ${rc.status}）`, `the transaction failed (status ${rc.status})`)

const svcState = () => store.get('svc') || {}
const saveSvc = (patch) => store.set('svc', { ...svcState(), ...patch })
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
    if (cid !== BSC) {
      try { await rpc('wallet_switchEthereumChain', [{ chainId: BSC }]); cid = await rpc('eth_chainId') } catch { /* the user refused */ }
    }
    if (cid !== BSC) { say($('wallet-status'), bi(`钱包当前不在 BNB Chain（chainId ${parseInt(cid, 16)}），请切换到 BNB Smart Chain 再连接。`, `The wallet is not on BNB Chain (chainId ${parseInt(cid, 16)}). Switch to BNB Smart Chain and connect again.`), 'bad'); return }
    account = accs[0]   // only once the chain is right, so steps 2-5 stay off on another chain / 链正确之后才记下账户
    const bal = await rpc('eth_getBalance', [account, 'latest'])
    say($('wallet-status'), bi(`已连接 ${account}（BNB Chain，余额 ${fmtBNB(hexToBig(bal))}）`, `Connected ${account} (BNB Chain, balance ${fmtBNB(hexToBig(bal))})`), 'ok')
    $('btn-estimate').disabled = !cfg; $('btn-verify').disabled = false
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
  $('btn-deploy').disabled = !account || !cfg || ((prev?.address || waiting) && !$('again').checked)
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

// ---------------------------------------------------------------- steps 2-5: publish a service ----
function showVars() {
  const s = svcState(), out = $('vars-out'); out.replaceChildren()
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

const enableSvc = () => {
  const s = svcState(), again = s.published || s.publishPending
  $('btn-circuit').disabled = !account; $('btn-deleg').disabled = !account || !s.container
  $('renew-box').hidden = !onChain?.ok
  $('btn-renew').disabled = !account || !s.container || !onChain?.ok || $('moved').checked
  $('btn-publish').disabled = !account || !s.sig || (again && !$('republish').checked)
  if (again) {
    $('republish-wrap').hidden = false; $('publish-prev').hidden = false
    $('publish-prev').replaceChildren(...(s.published
      ? [bi('这台设备上已发布过（', 'Already published from this device ('), txLink(s.published), bi('）。只有在第 4 步续期委托后才需要再发布。', '). Publish again only after renewing the delegation in step 4.')]
      : [bi('有一笔发布交易还在等待：', 'A publish transaction is still waiting: '), txLink(s.publishPending), bi('。先在 BscScan 查看，不要重复发送。', '. Check it on BscScan first; do not send it twice.')]))
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
    saveSvc({ circuits: c.circuits, tokenId: c.tokenId, container: c.container, holder: c.holder, sig: undefined, expires: undefined, published: undefined, publishPending: undefined })
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
    const s = svcState(), base = $('svc-url').value.trim().replace(/\/+$/, '')
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

$('btn-publish').onclick = async () => {
  const out = $('publish-out'); out.replaceChildren()
  $('btn-publish').disabled = true   // one tap, one transaction (review F5) / 一次点击一笔交易
  let sent = false
  try {
    const s = svcState(), base = s.endpoint.replace(/\/tapeapi\/v1$/, '')
    const served = await (await fetch(`${base}/.well-known/tapeapi.json`, { cache: 'no-store' })).text()
    const problems = C.manifestProblems(served, s)
    if (problems.length) { note(out, false, bi(`服务提供的清单与你签的不一致，暂不上链：${problems.join('；')}。通常是变量还没生效，等一两分钟再试。`, `The manifest the service serves does not match what you signed, so nothing is published: ${problems.join('; ')}. Usually the variables have not taken effect yet; retry in a minute or two.`)); return }
    // Publish the page's own bytes, built from what you read and signed; the service only has to agree (review F2).
    // 发布页面自己构造的字节（来自你读到和签过的内容）；服务只需与之一致（审查 F2）。
    const sm = JSON.parse(served)
    const text = C.manifestText({ ...s, name: sm.name, methods: sm.methods })
    const size = new TextEncoder().encode(text).length, names = sm.methods.map((x) => x.name)
    note(out, true, bi(`✓ 清单核对通过（${size} 字节）。服务名「${sm.name}」，${names.length} 个免费方法：${names.join('、')}。将写上链的完整内容：`, `✓ The manifest checks out (${size} bytes). Service name "${sm.name}", ${names.length} free methods: ${names.join(', ')}. The full content to be written on chain:`))
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
    const hash = await rpc('eth_sendTransaction', [{ from: account, chainId: BSC, to: tx.to, data: tx.data, value: tx.value }])
    sent = true; saveSvc({ publishPending: hash })
    note(out, null, [bi('已发出 ', 'Sent '), txLink(hash), bi('，等待上链…', ', waiting for it to be mined…')])
    let rc = null
    for (let i = 0; i < 120 && !rc; i++) { await sleep(3000); rc = await rpc('eth_getTransactionReceipt', [hash]) }
    if (!rc) throw new Error(notMined(hash))
    if (rc.status !== '0x1') throw new Error(failed(rc))
    saveSvc({ published: hash, sha, publishPending: undefined })
    note(out, true, [bi(`✓ 清单已写上链（容器 ${s.container}）。请保存交易备查：`, `✓ The manifest is on chain (container ${s.container}). Keep the transaction for your records: `), txLink(hash)])
    out.append(copyBtn(t('复制交易哈希', 'Copy transaction hash'), hash))
  } catch (e) { note(out, false, bi(`没有完成：${e.message}`, `Not completed: ${e.message}`)) } finally {
    // After a send, publishing again needs the explicit box (renewing the delegation is the reason to); a check that
    // failed before sending leaves the button on for a retry. / 发出后再发布需要勾选；发送前失败则按钮保持可用以便重试。
    if (sent) { $('republish-wrap').hidden = false; $('republish').checked = false }
    enableSvc()
  }
}
$('republish').onchange = enableSvc
showVars(); enableSvc()
