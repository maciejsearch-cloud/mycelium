"""Lokalna strona stanu węzła (tylko 127.0.0.1): prawdziwe liczniki z działającego procesu, odświeżanie co 5 s."""

from __future__ import annotations

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PAGE = """<!doctype html><html lang="pl"><meta charset="utf-8"><title>Węzeł Mycelium AI</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font:15px system-ui,sans-serif;background:#0b1020;color:#e2e8f0;max-width:760px;margin:24px auto;padding:0 16px}
h1{font-size:20px}.g{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:10px}
.c{background:#131a33;border:1px solid #23305a;border-radius:12px;padding:10px}.k{color:#94a3b8;font-size:12px}
.v{font-size:20px;font-weight:600;margin-top:2px}.ok{color:#4ade80}.bad{color:#f87171}a{color:#7dd3fc}pre{white-space:pre-wrap;font-size:12px;color:#94a3b8}</style>
<h1>🍄 Węzeł Mycelium AI <span id="st"></span></h1><div class="g" id="g"></div><pre id="last"></pre>
<p class="k">Dane z tego procesu (bez szacunków). Sieć: <a href="https://maciejsearch-cloud.github.io/demo/mycelium/">Mycelium AI</a>.</p>
<script>
const f=(x,d=0)=>x==null?'–':Number(x).toLocaleString('pl-PL',{maximumFractionDigits:d});
const dur=s=>{s=Math.max(0,s|0);const h=s/3600|0,m=(s%3600)/60|0;return h?h+' h '+m+' min':m+' min'};
async function tick(){try{const s=await (await fetch('status.json')).json();
document.getElementById('st').innerHTML=s.connected?'<span class="ok">● połączony</span>':'<span class="bad">● łączę…</span>';
const items=[['Działa od',dur(s.now-s.started)],['Węzły online',f(s.nodes_online)],['Rozmowy obsłużone',f(s.chats)],['Tokeny wysłane w czacie',f(s.tokens)],
['Ostatnia prędkość',s.tps?f(s.tps,1)+' tok/s':'–'],['Zadania treningu LM',f(s.lm_train)],['Ponowne oceny LM',f(s.lm_eval)],['Tokeny wytrenowane',f(s.lm_tokens)],
['Wkład obliczeń',s.lm_flops?f(s.lm_flops/1e12,1)+' TFLOP':'–'],['Model językowy w czacie',s.lm_version==null?'bazowy':'v'+s.lm_version],['Rozłączenia',f(s.drops)],['Backend',s.backend||'–'],['ID węzła (do połączenia z kontem)',s.id||'–']];
const g=document.getElementById('g');g.replaceChildren(...items.map(([k,v])=>{const c=document.createElement('div');c.className='c';const a=document.createElement('div');a.className='k';a.textContent=k;const b=document.createElement('div');b.className='v';b.textContent=String(v);c.append(a,b);return c}));
document.getElementById('last').textContent=s.lm_last?('Ostatnie zadanie: '+JSON.stringify(s.lm_last)):'';
}catch(e){document.getElementById('st').innerHTML='<span class="bad">● węzeł nie odpowiada</span>'}}
tick();setInterval(tick,5000);
</script></html>"""


CSP = (
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; "
    "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
)


def serve_status(get_status, port: int, api=None) -> int | None:
    """Uruchamia serwer w wątku; gdy port zajęty (np. drugi węzeł), próbuje kolejnych 9 portów.

    api (dashboard.Api): panel /ui i /api/* – tylko z kluczem (X-Myc-Token) i poprawnym nagłówkiem Host.
    """
    from urllib.parse import parse_qs, urlsplit

    class H(BaseHTTPRequestHandler):
        def _send(self, code: int, body: bytes, ctype: str):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-Frame-Options", "DENY")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Content-Security-Policy", CSP)
            self.end_headers()
            self.wfile.write(body)

        def _json(self, code: int, obj):
            self._send(code, json.dumps(obj, default=str, ensure_ascii=False).encode(), "application/json")

        def _api_guard(self) -> bool:
            if api is None or not api.host_ok(self.headers.get("Host")):
                self._json(403, {"error": "host"})
                return False
            if not api.auth_ok(self.headers.get("X-Myc-Token")):
                self._json(401, {"error": "token"})
                return False
            return True

        def do_GET(self):  # noqa: N802
            u = urlsplit(self.path)
            if u.path.startswith("/status.json"):
                return self._json(200, {**get_status(), "now": time.time()})
            if api is not None and u.path == "/logo.svg":
                from .dashboard import logo

                return self._send(200, logo().encode(), "image/svg+xml")
            if api is not None and u.path == "/ui":
                if not api.host_ok(self.headers.get("Host")):
                    return self._json(403, {"error": "host"})
                from .dashboard import page

                return self._send(200, page().encode(), "text/html; charset=utf-8")
            if u.path.startswith("/api/"):
                if not self._api_guard():
                    return None
                try:
                    code, obj = api.get(u.path, parse_qs(u.query))
                except Exception as e:  # noqa: BLE001 – błąd panelu nie może zatrzymać węzła
                    code, obj = 500, {"error": type(e).__name__}
                return self._json(code, obj)
            return self._send(200, PAGE.encode(), "text/html; charset=utf-8")

        def do_POST(self):  # noqa: N802
            u = urlsplit(self.path)
            if not u.path.startswith("/api/") or not self._api_guard():
                if not u.path.startswith("/api/"):
                    self._json(404, {"error": "not found"})
                return
            if not api.origin_ok(self.headers.get("Origin")) or "application/json" not in (
                self.headers.get("Content-Type") or ""
            ):
                return self._json(403, {"error": "origin"})
            n = int(self.headers.get("Content-Length") or 0)
            if n > 65536:
                return self._json(413, {"error": "too large"})
            try:
                body = json.loads(self.rfile.read(n) or b"{}")
                if not isinstance(body, dict):
                    raise ValueError
            except ValueError:
                return self._json(400, {"error": "json"})
            try:
                code, obj = api.post(u.path, body)
            except Exception as e:  # noqa: BLE001
                code, obj = 500, {"error": type(e).__name__}
            return self._json(code, obj)

        def log_message(self, *a):
            pass

    for p in range(port, port + 10):
        try:
            srv = ThreadingHTTPServer(("127.0.0.1", p), H)
        except OSError:
            continue
        if api is not None:
            api.port = p
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        return p
    return None
