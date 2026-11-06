// examples/app-interop/wallet-render: the page's logic. Plain browser script, no imports, no network.
// It calls exactly three methods of window.ethereum: eth_requestAccounts (the address), eth_chainId (read only) and
// eth_signTypedData_v4 (one signature over the payload shown on the page). Nothing else: no transaction, no balance,
// no network switch, no fetch. Experimental prototype; not a TAP.
// 页面逻辑：普通浏览器脚本，无导入、无网络。只调用 window.ethereum 的三个方法；不发交易、不查余额、不切网络、不 fetch。
'use strict'
;(function () {
  var PAGE_VERSION = 'wallet-render/1'
  var data = window.WALLET_RENDER
  var eth = window.ethereum
  var state = { account: null, chainId: null, variant: null, text: null, record: null }
  var $ = function (id) { return document.getElementById(id) }
  var put = function (el, text) { el.textContent = text }

  // the wallet's own flags, as it announces itself (several wallets in one browser fight over window.ethereum)
  // 钱包自报的标识（同一浏览器装多个钱包时它们会抢 window.ethereum）
  var FLAGS = ['isMetaMask', 'isOkxWallet', 'isOKExWallet', 'isRabby', 'isCoinbaseWallet', 'isTrust', 'isBraveWallet']
  function flags() {
    var out = {}
    if (!eth) return out
    FLAGS.forEach(function (k) { if (eth[k] === true) out[k] = true })
    if (Array.isArray(eth.providers)) out.providers = eth.providers.length
    return out
  }
  function kv(el, pairs) {
    el.textContent = ''
    pairs.forEach(function (p) {
      var a = document.createElement('span'); a.textContent = p[0]
      var b = document.createElement('span'); b.textContent = p[1]
      el.appendChild(a); el.appendChild(b)
    })
  }

  function renderWallet() {
    var f = flags()
    kv($('wallet-facts'), [
      ['window.ethereum', eth ? '有 / present' : '没有：请在装了钱包扩展的浏览器里打开 / absent: open this in a browser with a wallet extension'],
      ['flags', Object.keys(f).length ? JSON.stringify(f) : '—'],
    ])
    $('connect').disabled = !eth
  }

  function renderVariants() {
    var box = $('variants')
    data.payloads.forEach(function (p, i) {
      var label = document.createElement('label'); label.className = 'variant'
      var r = document.createElement('input'); r.type = 'radio'; r.name = 'variant'; r.value = p.id
      if (i === 0) { r.checked = true; state.variant = p }
      r.addEventListener('change', function () { state.variant = p; renderJson() })
      label.appendChild(r)
      label.appendChild(document.createTextNode(' ' + p.id + ' — ' + p.titleZh + ' / ' + p.title))
      box.appendChild(label)
    })
  }

  // The typed data with message.user set to the connected account, as the exact string the wallet will get.
  // user 换成连接的账户后的类型数据，即钱包将收到的原样字符串。
  function payloadText() {
    var td = JSON.parse(JSON.stringify(state.variant.typedData))
    td.message.user = state.account
    return JSON.stringify(td, null, 2)
  }

  function renderJson() {
    var p = state.variant
    var rows = [['id', p.id]]
    if (p.typedData.message.statement !== undefined) {
      var st = p.typedData.message.statement
      rows.push(['statement', st], ['statement length', st.length + ' chars (UTF-16 units)'])
      rows.push(['methods', p.typedData.message.methods.length + ' item(s)'])
    }
    if (p.display) rows.push(['valid (UTC)', p.display.notBefore + ' → ' + p.display.expires])
    rows.push(['domain', p.typedData.domain.name + ' / v' + p.typedData.domain.version + ' / chainId ' + p.typedData.domain.chainId + ' / ' + p.typedData.domain.verifyingContract])
    kv($('summary'), rows)
    if (!state.account) { put($('json'), '先连接钱包（只取地址）。/ Connect the wallet first (address only).'); $('sign').disabled = true; return }
    state.text = payloadText()
    put($('json'), state.text)
    $('sign').disabled = false
  }

  function setRecord(rec, ok) {
    state.record = JSON.stringify(rec, null, 2)
    $('result').value = state.record
    $('copy').disabled = false
    $('status').className = ok ? 'ok' : 'bad'
    put($('status'), ok ? '已签名。请截图钱包画面后复制结果。/ Signed. Take the screenshots, then copy the result.' : '没有签名：' + (rec.error && rec.error.message) + ' / Not signed.')
  }

  function base() {
    return { page: PAGE_VERSION, variant: state.variant.id, wallet: flags(), chainId: state.chainId, account: state.account, origin: location.origin, userAgent: navigator.userAgent, at: new Date().toISOString() }
  }

  $('connect').addEventListener('click', function () {
    eth.request({ method: 'eth_requestAccounts' }).then(function (accounts) {
      state.account = accounts && accounts[0] ? String(accounts[0]) : null
      put($('account'), state.account || '—')
      return eth.request({ method: 'eth_chainId' })
    }).then(function (id) {
      state.chainId = String(id)
      put($('chain'), state.chainId + (state.chainId.toLowerCase() === '0x38' ? '（BNB Smart Chain, 56）' : ''))
      put($('chain-hint'), state.chainId.toLowerCase() === '0x38' ? '' : '钱包当前不在 BNB Smart Chain（链 ID 56 = 0x38）。请在钱包里手动切换到 BNB Smart Chain 后刷新本页；本页不会替你切换。/ The wallet is not on BNB Smart Chain (56 = 0x38): switch in the wallet by hand and reload; this page never switches it.')
      renderJson()
    }).catch(function (e) {
      put($('chain-hint'), '连接失败 / connect failed: ' + (e && e.message))
    })
  })

  $('sign').addEventListener('click', function () {
    var text = state.text
    var rec = base()
    rec.typedData = text
    eth.request({ method: 'eth_signTypedData_v4', params: [state.account, text] }).then(function (sigHex) {
      rec.signature = String(sigHex)
      setRecord(rec, true)
    }).catch(function (e) {
      rec.error = { code: e && e.code !== undefined ? e.code : null, message: String(e && e.message ? e.message : e) }
      setRecord(rec, false)
    })
  })

  $('copy').addEventListener('click', function () {
    var done = function () { put($('copied'), '已复制 / copied') }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(state.record).then(done, function () { $('result').select(); document.execCommand('copy'); done() })
    } else { $('result').select(); document.execCommand('copy'); done() }
  })

  if (eth && typeof eth.on === 'function') {
    eth.on('chainChanged', function (id) { state.chainId = String(id); put($('chain'), state.chainId); put($('chain-hint'), '链已变化，请刷新本页。/ The chain changed: reload the page.') })
    eth.on('accountsChanged', function (a) { state.account = a && a[0] ? String(a[0]) : null; put($('account'), state.account || '—'); renderJson() })
  }
  renderWallet()
  renderVariants()
  renderJson()
})()
