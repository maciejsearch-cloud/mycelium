/* Mycelium AI – widżet „Zostań węzłem” (opt-in).
 * <script src="https://maciejsearch-cloud.github.io/demo/mycelium/widget.js" data-ref="KOD" async></script>
 * Do czasu kliknięcia nic się nie ładuje ani nie liczy. Po zgodzie: mała ramka z sesją grzybni (CPU/GPU),
 * którą odwiedzający może w każdej chwili zatrzymać lub zamknąć. Bez ciasteczek i danych osobowych. */
(function () {
  var s = document.currentScript
  if (!s) return
  var base = new URL('./', s.src).href
  var ref = /^[0-9a-f]{8}$/.test(s.getAttribute('data-ref') || '') ? s.getAttribute('data-ref') : ''
  var lang = (s.getAttribute('data-lang') || document.documentElement.lang || navigator.language || 'pl').slice(0, 2) === 'pl' ? 'pl' : 'en'
  var T = lang === 'pl'
    ? { title: 'Pom\u00f3\u017c uczy\u0107 wsp\u00f3ln\u0105 AI', body: 'Za Twoj\u0105 zgod\u0105 ta karta u\u017cyje wolnej mocy CPU/GPU do trenowania otwartych modeli Mycelium AI. Bez danych osobowych; mo\u017cesz przerwa\u0107 w ka\u017cdej chwili.', yes: 'Zosta\u0144 w\u0119z\u0142em', no: 'Nie, dzi\u0119kuj\u0119', close: 'Zamknij' }
    : { title: 'Help train a shared AI', body: 'With your consent this tab uses spare CPU/GPU to train the open Mycelium AI models. No personal data; stop any time.', yes: 'Become a node', no: 'No, thanks', close: 'Close' }
  var box = document.createElement('div')
  box.setAttribute('data-mycelium-widget', '')
  box.style.cssText = 'font:14px/1.4 system-ui,sans-serif;max-width:340px;border:1px solid #1f3a33;border-radius:14px;background:#06110d;color:#e2e8f0;padding:12px;box-shadow:0 4px 18px rgba(0,0,0,.25)'
  var h = document.createElement('div')
  h.textContent = T.title
  h.style.cssText = 'font-weight:600;color:#5eead4;margin-bottom:4px'
  var p = document.createElement('div')
  p.textContent = T.body
  p.style.cssText = 'font-size:12px;color:#94a3b8'
  var row = document.createElement('div')
  row.style.cssText = 'display:flex;gap:8px;margin-top:10px'
  var yes = document.createElement('button')
  yes.textContent = T.yes
  yes.style.cssText = 'background:#5eead4;color:#06110d;border:0;border-radius:10px;padding:6px 12px;font-weight:600;cursor:pointer'
  var no = document.createElement('button')
  no.textContent = T.no
  no.style.cssText = 'background:transparent;color:#94a3b8;border:1px solid #1f3a33;border-radius:10px;padding:6px 12px;cursor:pointer'
  row.appendChild(yes)
  row.appendChild(no)
  box.appendChild(h)
  box.appendChild(p)
  box.appendChild(row)
  no.onclick = function () {
    box.remove()
  }
  yes.onclick = function () {
    var f = document.createElement('iframe')
    f.src = base + '?embed=1&autostart=1&join=1' + (ref ? '&ref=' + ref : '') + '#/node'
    f.title = 'Mycelium AI'
    f.allow = 'screen-wake-lock'
    f.style.cssText = 'width:100%;height:150px;border:0;border-radius:10px;background:#06110d'
    var c = document.createElement('button')
    c.textContent = T.close
    c.style.cssText = no.style.cssText + ';margin-top:6px'
    c.onclick = function () {
      box.remove()
    }
    box.replaceChildren(f, c)
  }
  s.parentNode.insertBefore(box, s.nextSibling)
})()
