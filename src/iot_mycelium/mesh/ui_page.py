"""Strona lokalnego panelu węzła (Vista/Aero). Bez zewnętrznych zasobów; wszystkie dane przez textContent."""

LOGO = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"> <defs> <linearGradient id="h" x1="6" y1="6" x2="58" y2="58" gradientUnits="userSpaceOnUse"> <stop offset="0" stop-color="#5eead4"/><stop offset=".55" stop-color="#7dd3fc"/><stop offset="1" stop-color="#a78bfa"/> </linearGradient> <radialGradient id="c" cx="29" cy="33" r="9" gradientUnits="userSpaceOnUse"> <stop offset="0" stop-color="#f0fdfa"/><stop offset=".6" stop-color="#99f6e4"/><stop offset="1" stop-color="#5eead4"/> </radialGradient> </defs> <g fill="none" stroke="url(#h)" stroke-linecap="round"> <g stroke-width="4.2"> <path d="M29 33C22 31 18 22 12 13"/> <path d="M29 33C35 26 39 16 47 10"/> <path d="M29 33C38 35 47 33 55 39"/> <path d="M29 33C28 42 33 49 39 56"/> <path d="M29 33C22 37 16 42 8 44"/> </g> <g stroke-width="2.6" opacity=".8"> <path d="M17 21C13 22 9 24 6 28"/> <path d="M39 18C45 19 50 20 56 18"/> <path d="M46 35C49 40 49 45 47 50"/> <path d="M32 47C27 50 24 54 21 58"/> </g> </g> <circle cx="12" cy="13" r="5" fill="#5eead4"/> <circle cx="47" cy="10" r="4.2" fill="#67e8f9"/> <circle cx="55" cy="39" r="4.8" fill="#a78bfa"/> <circle cx="39" cy="56" r="4.2" fill="#a78bfa"/> <circle cx="8" cy="44" r="4" fill="#7dd3fc"/> <g fill="#99f6e4"><circle cx="6" cy="28" r="2.4"/><circle cx="56" cy="18" r="2.4"/></g> <g fill="#c4b5fd"><circle cx="47" cy="50" r="2.4"/><circle cx="21" cy="58" r="2.4"/></g> <circle cx="29" cy="33" r="8.5" fill="url(#c)"/> </svg>'  # znak Mycelium AI (web/public/logo-mark.svg)

HTML = r"""<!doctype html><html lang="pl"><head><meta charset="utf-8"><title>Mycelium AI – węzeł</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" href="/logo.svg" type="image/svg+xml">
<style>
*{box-sizing:border-box}
html,body{margin:0;height:100%}
body{font:12.5px "Segoe UI",Tahoma,"Noto Sans",system-ui,sans-serif;color:#1e2b3a;
background:radial-gradient(ellipse at 20% 110%,#3fa7a0 0,transparent 55%),radial-gradient(ellipse at 85% -10%,#4a7fc9 0,transparent 55%),
linear-gradient(160deg,#0d2f57,#0a4a62 45%,#123b6b);padding:14px;overflow:auto}
.win{max-width:1180px;margin:0 auto;border-radius:9px;padding:0 7px 7px;
background:linear-gradient(180deg,rgba(180,215,245,.55),rgba(120,170,215,.38) 40px,rgba(110,160,210,.30));
border:1px solid rgba(20,40,70,.85);box-shadow:0 0 0 1px rgba(255,255,255,.45) inset,0 18px 50px rgba(0,0,0,.55);backdrop-filter:blur(14px)}
.title{height:34px;display:flex;align-items:center;gap:8px;padding:0 6px;color:#0b1a2b;text-shadow:0 0 10px #fff,0 0 4px #fff;position:relative}
.title:before{content:"";position:absolute;inset:2px 0 50% 0;border-radius:7px 7px 0 0;background:linear-gradient(rgba(255,255,255,.55),rgba(255,255,255,.08))}
.title img{width:20px;height:20px;position:relative;filter:drop-shadow(0 0 3px rgba(255,255,255,.8))}
.title b{font-weight:400;font-size:13px;position:relative}
.title .sp{flex:1}
.pill{position:relative;font-size:11.5px;padding:2px 9px;border-radius:10px;border:1px solid rgba(0,0,0,.35);text-shadow:none;color:#fff;background:linear-gradient(#7a8796,#4b5766)}
.pill.ok{background:linear-gradient(#6fd96f,#1d9a2c 55%,#12801f)}.pill.warn{background:linear-gradient(#ffd36b,#e09a12 55%,#c27c00)}.pill.bad{background:linear-gradient(#ff8a7a,#c8321f 55%,#a5200f)}
.frame{background:#fff;border:1px solid #6c8fb4;border-radius:3px;overflow:hidden}
.bar{display:flex;flex-wrap:wrap;gap:2px;padding:3px 6px;background:linear-gradient(#5a7fa8,#2e5785 48%,#22487a 52%,#2f5d93);border-bottom:1px solid #0e2a4c}
.bar button{font:inherit;color:#fff;background:transparent;border:1px solid transparent;border-radius:3px;padding:5px 13px;cursor:pointer;text-shadow:0 1px 1px rgba(0,0,0,.4)}
.bar button:hover{border-color:rgba(255,255,255,.45);background:linear-gradient(rgba(255,255,255,.35),rgba(255,255,255,.08) 50%,rgba(255,255,255,0) 51%,rgba(255,255,255,.18))}
.bar button.on{border-color:rgba(10,25,45,.8);background:linear-gradient(rgba(0,0,0,.25),rgba(0,0,0,.05));box-shadow:inset 0 1px 3px rgba(0,0,0,.5)}
.addr{display:flex;align-items:center;gap:8px;padding:4px 8px;background:linear-gradient(#f4f8fc,#dfe9f5);border-bottom:1px solid #a9bfd8;color:#3b4d63;font-size:11.5px}
.addr .crumb{background:#fff;border:1px solid #9fb6d0;border-radius:2px;padding:2px 8px;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.body{display:grid;grid-template-columns:1fr 232px;min-height:560px}
.main{padding:12px 14px;background:linear-gradient(#ffffff,#f3f7fb)}
.side{padding:10px 8px;background:linear-gradient(90deg,#1d2c3e,#0f1a27);border-left:1px solid #0a121c;display:flex;flex-direction:column;gap:10px}
.gad{border-radius:8px;padding:8px 9px 10px;color:#e8f1fb;background:linear-gradient(rgba(255,255,255,.18),rgba(255,255,255,.04) 45%,rgba(0,0,0,.25));
border:1px solid rgba(255,255,255,.22);box-shadow:0 3px 10px rgba(0,0,0,.6),inset 0 1px 0 rgba(255,255,255,.35)}
.gad h4{margin:0 0 6px;font-weight:400;font-size:11px;letter-spacing:.3px;color:#bcd3ea;text-transform:uppercase}
.gad .big{font-size:22px;font-weight:300}.gad .k{color:#9db4cc;font-size:11px}
.dials{display:flex;justify-content:space-around}
.grp{border:1px solid #c5d5e6;border-radius:4px;margin:0 0 12px;background:#fff;box-shadow:0 1px 2px rgba(30,60,100,.08)}
.grp>h3{margin:0;padding:5px 10px;font-size:12.5px;font-weight:600;color:#1e3b5f;background:linear-gradient(#f9fbfe,#e4edf7);border-bottom:1px solid #c5d5e6;border-radius:4px 4px 0 0}
.grp>.in{padding:10px}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px}
.c{border:1px solid #d3e0ee;border-radius:4px;padding:7px 9px;background:linear-gradient(#fff,#f0f5fb)}
.c .k{color:#5b6f86;font-size:11px}.c .v{font-size:17px;color:#11365e;margin-top:2px;word-break:break-all}
.graphs{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.tm{background:#000;border:1px solid #2c3e50;border-radius:2px;position:relative}
.tm canvas{display:block;width:100%;height:120px}
.tm .lab{position:absolute;left:6px;top:4px;color:#4dff4d;font:11px Consolas,monospace;text-shadow:0 0 4px #0f0}
.muted{color:#5b6f86}.err{color:#b3261e}.okc{color:#167a2a}
.row{display:flex;align-items:center;gap:10px;margin:7px 0;flex-wrap:wrap}
.row label{width:250px}.row output{width:70px;text-align:right;color:#11365e}
input[type=range]{flex:1;min-width:160px;accent-color:#2f7fd1}
input[type=text],select{font:inherit;padding:4px 6px;border:1px solid #8fa9c6;border-radius:2px;background:#fff}
.btn{font:inherit;padding:4px 16px;border-radius:3px;border:1px solid #707070;cursor:pointer;color:#111;
background:linear-gradient(#f2f2f2,#ebebeb 49%,#dddddd 50%,#cfcfcf)}
.btn:hover{border-color:#3c7fb1;background:linear-gradient(#eaf6fd,#d9f0fc 49%,#bee6fd 50%,#a7d9f5)}
.btn.pri{border-color:#2a6fb4}
table{border-collapse:collapse;width:100%;font-size:12px}
th{text-align:left;font-weight:400;color:#4c607a;background:linear-gradient(#fff,#eef3f9);border-bottom:1px solid #c5d5e6;padding:4px 6px;position:sticky;top:0}
td{padding:3px 6px;border-bottom:1px solid #eef2f7;vertical-align:top}
tr:hover td{background:#e8f2fd}
.scroll{max-height:440px;overflow:auto;border:1px solid #c5d5e6}
.tag{display:inline-block;padding:0 6px;border-radius:8px;font-size:10.5px;background:#dfeaf6;color:#1e3b5f}
.tag.job{background:#d8f3dc;color:#14532d}.tag.error{background:#fde2e1;color:#8a1c12}.tag.settings{background:#fff1c9;color:#6b4e00}.tag.account{background:#ece2fb;color:#4b2a85}.tag.net{background:#d9ecff;color:#0b3d75}.tag.witness{background:#d6f5f0;color:#0f5148}
pre.con{background:#000;color:#c0c0c0;font:12px Consolas,"DejaVu Sans Mono",monospace;padding:8px;margin:0;height:440px;overflow:auto;white-space:pre-wrap;border:1px solid #333}
.code{font:15px Consolas,monospace;background:#fffbe6;border:1px solid #e3c66b;padding:6px 10px;display:inline-block;user-select:all}
.hidden{display:none}
.status{padding:3px 8px;font-size:11px;color:#2d3e52;background:linear-gradient(#eef3f9,#d8e3ef);border-top:1px solid #a9bfd8;display:flex;gap:16px}
.bars{display:flex;align-items:flex-end;gap:3px;height:110px;border-bottom:1px solid #c5d5e6;padding-top:6px}
.bars div{flex:1;background:linear-gradient(90deg,#7fb8ec,#3a86d0);border:1px solid #2b6eb0;border-bottom:0;border-radius:2px 2px 0 0;min-height:1px;position:relative}
.bars div.acc{background:linear-gradient(90deg,#8fe08f,#2aa23a);border-color:#1b7f28}
.blab{display:flex;gap:3px;font-size:10px;color:#5b6f86}.blab span{flex:1;text-align:center;overflow:hidden}
@media(max-width:820px){.body{grid-template-columns:1fr}.side{flex-direction:row;flex-wrap:wrap}.gad{flex:1;min-width:200px}.graphs{grid-template-columns:1fr}.row label{width:100%}}
</style></head><body>
<div class="win">
 <div class="title"><img src="/logo.svg" alt=""><b>Mycelium AI – węzeł <span id="tname"></span></b><span class="sp"></span><span class="pill" id="pill">…</span></div>
 <div class="frame">
  <div class="bar" id="tabs">
   <button data-t="ov" class="on">Przegląd</button><button data-t="pw">Moc i przydział</button><button data-t="st">Statystyki</button>
   <button data-t="pa">Tryb pasywny</button><button data-t="hi">Historia</button><button data-t="ac">Konto</button><button data-t="co">Konsola</button>
  </div>
  <div class="addr"><span>Adres:</span><span class="crumb" id="crumb">Mycelium AI ▸ Ten komputer</span><span id="upd" class="muted"></span></div>
  <div class="body">
   <div class="main">
    <section id="t-ov">
     <div class="grp"><h3>Stan na żywo</h3><div class="in"><div class="cards" id="live"></div><p class="muted" id="lastjob"></p></div></div>
     <div class="grp"><h3>Użycie zasobów (ostatnie 15 min, pomiar co 2 s)</h3><div class="in graphs">
      <div class="tm"><span class="lab" id="lcpu">CPU</span><canvas id="gcpu" width="520" height="120"></canvas></div>
      <div class="tm"><span class="lab" id="lgpu">GPU</span><canvas id="ggpu" width="520" height="120"></canvas></div>
      <div class="tm"><span class="lab" id="lram">RAM</span><canvas id="gram" width="520" height="120"></canvas></div>
      <div class="tm"><span class="lab" id="lwork">Praca węzła (okno 10 min)</span><canvas id="gwork" width="520" height="120"></canvas></div>
     </div><p class="muted">Zielona linia CPU = cały komputer, żółta = proces węzła. Wszystko to prawdziwe odczyty tego komputera.</p></div>
    </section>
    <section id="t-pw" class="hidden">
     <div class="grp"><h3>Procesor i pamięć</h3><div class="in">
      <div class="row"><label>Wątki CPU dla modelu (zmiana od razu)</label><input type="range" id="threads" min="1" step="1"><output id="o-threads"></output></div>
      <div class="row"><label>Maks. czas pracy (średnio w oknie 10 min)</label><input type="range" id="cpu_pct" min="5" max="100" step="5"><output id="o-cpu_pct"></output></div>
      <div class="row"><label>Limit RAM w GB (0 = bez limitu; wymaga restartu)</label><input type="range" id="ram_gb" min="0" step="0.5"><output id="o-ram_gb"></output></div>
      <div class="row hidden" id="ramsug"><span class="tag settings">Propozycja</span><span id="ramsugt"></span><button class="btn" id="ramsugb">Ustaw 3 GB</button></div>
     </div></div>
     <div class="grp"><h3>Karta graficzna (GPU)</h3><div class="in">
      <div id="gpulist"></div>
      <p id="gpuinfo"></p>
      <div class="row"><button class="btn" id="gpubench">Sprawdź GPU (test ok. 1–2 min)</button><span id="benchmsg" class="muted"></span></div>
      <div id="benchres"></div>
      <div class="row"><label>Użyj GPU do treningu (DirectML)</label><input type="checkbox" id="gpu_on"><span id="gpunote" class="muted"></span></div>
      <input type="hidden" id="gpu_pct"><output id="o-gpu_pct" class="hidden"></output>
     </div></div>
     <div class="grp"><h3>Na co oddać moc (udział w czasie pracy)</h3><div class="in" id="shares"></div></div>
     <div class="row"><button class="btn pri" id="save">Zastosuj</button><button class="btn" id="restart">Uruchom węzeł ponownie</button><span id="savemsg" class="muted"></span></div>
    </section>
    <section id="t-st" class="hidden">
     <div class="grp"><h3>Ten węzeł od uruchomienia</h3><div class="in"><div class="cards" id="stcards"></div></div></div>
     <div class="grp"><h3>Czas pracy według rodzaju zadań (od uruchomienia)</h3><div class="in"><table id="kindt"></table></div></div>
     <div class="grp"><h3>Wkład w czasie – wyniki zapisane w bazie (14 dni)</h3><div class="in"><div class="bars" id="cbars"></div><div class="blab" id="clab"></div><p class="muted" id="csrc"></p></div></div>
     <div class="grp"><h3>Punkty konta</h3><div class="in"><div class="cards" id="pts"></div></div></div>
    </section>
    <section id="t-pa" class="hidden">
     <div class="grp"><h3>Tryb pasywny – pomoc bez oddawania mocy (tylko za Twoją zgodą)</h3><div class="in">
      <div class="row"><label><b>Włącz tryb pasywny</b></label><input type="checkbox" id="pa_on"><span class="muted">Domyślnie wyłączony.</span></div>
      <div class="row"><label>Oddawaj też moc obliczeniową (CPU)</label><input type="checkbox" id="compute_on"><span class="muted">Wyłącz, by węzeł nie trenował i nie odpowiadał w czacie.</span></div>
      <div class="row"><label>Sprawdzona pamięć danych (seeding)</label><input type="checkbox" id="pa_seed"><span class="muted">Trzyma kopie danych do nauki, każdy plik sprawdza sumą SHA-256 z manifestu projektu.</span></div>
      <div class="row"><label>Świadek (sprawdzanie wyników i wydań)</label><input type="checkbox" id="pa_witness"><span class="muted">Tanie sprawdzenia spójności wyników innych węzłów i sum wydań. Raport trafia do bazy.</span></div>
      <div class="row"><label>Limit miejsca na dysku</label><input type="range" id="pa_disk" min="0.5" max="50" step="0.5"><output id="o-pa_disk"></output></div>
      <div class="row"><label>Limit pobierania na dobę</label><input type="range" id="pa_daily" min="0.1" max="20" step="0.1"><output id="o-pa_daily"></output></div>
      <div class="row"><button class="btn pri" id="pa_save">Zastosuj</button><span id="pa_msg" class="muted"></span></div>
     </div></div>
     <div class="grp"><h3>Co dokładnie zużywa (prawdziwe liczniki)</h3><div class="in"><div class="cards" id="pacards"></div><p class="muted" id="paerr"></p>
      <p class="muted">Węzeł niczego nie udostępnia z Twojego komputera i nie otwiera portów – pobiera tylko z adresów projektu (strona demo, wydania GitHub, baza Supabase). Wysyła do bazy wyłącznie wynik sprawdzenia (zgodne / flaga + lista testów). Świadectwa są pomocnicze: nie zmieniają bramki ani punktów.</p></div></div>
    </section>
    <section id="t-hi" class="hidden">
     <div class="row"><input type="text" id="hq" placeholder="Szukaj w historii…" style="flex:1">
      <select id="hk"><option value="">wszystko</option><option value="job">zadania</option><option value="net">sieć</option><option value="settings">ustawienia</option><option value="account">konto</option><option value="witness">świadek</option><option value="error">błędy</option><option value="log">dziennik</option></select>
      <button class="btn" id="hgo">Filtruj</button></div>
     <div class="scroll"><table><thead><tr><th style="width:150px">Czas</th><th style="width:80px">Rodzaj</th><th>Opis</th></tr></thead><tbody id="hrows"></tbody></table></div>
     <p class="muted" id="hinfo"></p>
    </section>
    <section id="t-ac" class="hidden"><div id="acc"></div></section>
    <section id="t-co" class="hidden"><pre class="con" id="con"></pre></section>
   </div>
   <div class="side">
    <div class="gad"><h4>Miernik</h4><div class="dials"><svg id="d1" width="96" height="80"></svg><svg id="d2" width="96" height="80"></svg></div></div>
    <div class="gad"><h4>Grzybnia</h4><div class="big" id="gnodes">–</div><div class="k">węzłów online</div><div class="k" id="gconn"></div></div>
    <div class="gad"><h4>Model językowy</h4><div class="big" id="glm">–</div><div class="k" id="glm2"></div></div>
    <div class="gad"><h4>GPU</h4><div id="ggpu2" class="k"></div></div>
    <div class="gad"><h4>Konto</h4><div id="gacc" class="k"></div></div>
   </div>
  </div>
  <div class="status"><span id="s1"></span><span id="s2"></span><span id="s3"></span></div>
 </div>
</div>
<script>
'use strict';
let T=sessionStorage.getItem('mycT')||'';
const h=new URLSearchParams(location.hash.slice(1)).get('t');if(h){T=h;sessionStorage.setItem('mycT',h);history.replaceState(null,'',location.pathname)}
const $=id=>document.getElementById(id);
const el=(t,txt,cls)=>{const e=document.createElement(t);if(txt!=null)e.textContent=String(txt);if(cls)e.className=cls;return e};
const f=(x,d=0)=>x==null||Number.isNaN(+x)?'–':Number(x).toLocaleString('pl-PL',{maximumFractionDigits:d});
const dur=s=>{s=Math.max(0,s|0);const d=s/86400|0,hh=(s%86400)/3600|0,m=(s%3600)/60|0;return d?d+' d '+hh+' h':hh?hh+' h '+m+' min':m+' min'};
const gb=b=>b==null?'–':b<2**30?f(b/2**20,b<10*2**20?1:0)+' MB':f(b/2**30,1)+' GB';
const tm=t=>new Date(t*1000).toLocaleString('pl-PL');
async function api(p,body){const r=await fetch(p,{method:body?'POST':'GET',headers:{'X-Myc-Token':T,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
 if(r.status===401)throw new Error('auth');return r.json()}
let S=null,samples=[],tab='ov',dirty=false;
document.querySelectorAll('#tabs button').forEach(b=>b.onclick=()=>{tab=b.dataset.t;document.querySelectorAll('#tabs button').forEach(x=>x.classList.toggle('on',x===b));
 document.querySelectorAll('.main>section').forEach(s=>s.classList.toggle('hidden',s.id!=='t-'+tab));$('crumb').textContent='Mycelium AI ▸ Ten komputer ▸ '+b.textContent;
 if(tab==='hi')loadHist();if(tab==='st')loadContrib();render()});
function cards(id,items){$(id).replaceChildren(...items.map(([k,v])=>{const c=el('div',null,'c');c.append(el('div',k,'k'),el('div',v,'v'));return c}))}
function graph(id,series,colors,max=100){const c=$(id),x=c.getContext('2d'),W=c.width,H=c.height;x.fillStyle='#000';x.fillRect(0,0,W,H);
 x.strokeStyle='#0a4d1a';x.lineWidth=1;for(let i=0;i<=W;i+=W/12){x.beginPath();x.moveTo(i+.5,0);x.lineTo(i+.5,H);x.stroke()}for(let j=0;j<=H;j+=H/6){x.beginPath();x.moveTo(0,j+.5);x.lineTo(W,j+.5);x.stroke()}
 series.forEach((s,k)=>{const n=450;x.strokeStyle=colors[k];x.lineWidth=1.6;x.beginPath();let st=false;s.forEach((v,i)=>{if(v==null){st=false;return}const px=W-(s.length-1-i)*W/(n-1),py=H-2-Math.min(max,v)/max*(H-4);st?x.lineTo(px,py):x.moveTo(px,py);st=true});x.stroke()})}
function dial(id,v,label){const s=$(id),a=-120+240*Math.min(100,Math.max(0,v||0))/100,r=a*Math.PI/180;
 const ticks=[...Array(11)].map((_,i)=>{const t=(-120+24*i)*Math.PI/180;return `<line x1="${48+30*Math.sin(t)}" y1="${44-30*Math.cos(t)}" x2="${48+35*Math.sin(t)}" y2="${44-35*Math.cos(t)}" stroke="${i>7?'#ff6b5b':'#cfe3f7'}" stroke-width="1.5"/>`}).join('');
 s.innerHTML=`<defs><radialGradient id="g${id}" cx="50%" cy="35%" r="65%"><stop offset="0" stop-color="#5d6f84"/><stop offset="1" stop-color="#0c141e"/></radialGradient></defs>
 <circle cx="48" cy="44" r="38" fill="url(#g${id})" stroke="#9fb3c8" stroke-width="2"/>${ticks}
 <line x1="48" y1="44" x2="${48+29*Math.sin(r)}" y2="${44-29*Math.cos(r)}" stroke="#ff4d3d" stroke-width="2.4" stroke-linecap="round"/><circle cx="48" cy="44" r="4" fill="#ddd"/>
 <text x="48" y="64" fill="#e8f1fb" font-size="11" text-anchor="middle">${v==null?'–':Math.round(v)+'%'}</text><text x="48" y="78" fill="#9db4cc" font-size="9.5" text-anchor="middle">${label}</text>
 <ellipse cx="48" cy="26" rx="28" ry="13" fill="rgba(255,255,255,.16)"/>`}
function render(){if(!S)return;const st=S.status,a=S.alloc,acc=S.account;
 $('tname').textContent='('+S.name+' · '+S.host+')';
 const p=$('pill');p.className='pill '+(st.connected?'ok':S.phase==='działa'?'warn':'bad');p.textContent=st.connected?'● połączony z grzybnią':S.phase==='działa'?'● łączę…':'● '+S.phase;
 const last=samples[samples.length-1]||{};
 $('s1').textContent='Proces węzła: '+f(last.cpu_proc,0)+'% CPU, '+gb(last.ram_proc);$('s2').textContent='Działa od: '+dur(st.now-st.started);$('s3').textContent=S.os;
 dial('d1',last.cpu,'CPU');dial('d2',last.ram_total?last.ram_used/last.ram_total*100:null,'RAM');
 $('gnodes').textContent=f(st.nodes_online);$('gconn').textContent=(st.connected?'połączony':'bez połączenia')+' · rozłączeń: '+f(st.drops);
 $('glm').textContent=st.lm_version==null?'bazowy':'v'+st.lm_version;$('glm2').textContent='zadań treningu: '+f(st.lm_train)+' · ocen: '+f(st.lm_eval);
 $('ggpu2').textContent=S.gpus.length?S.gpus.map(g=>g.name+(g.util!=null?': '+f(g.util)+'%':'')+(g.mem_total?' · '+f(g.mem_used)+'/'+f(g.mem_total)+' MB':'')).join('\n')+(S.gpu&&S.gpu.backend==='directml'?' · trening na GPU':''):'System nie zgłosił karty graficznej.';
 $('gacc').textContent=acc.logged_in?(acc.me.handle+' · punkty: '+f((acc.me.points||{}).approved,1)+' zatwierdzone, '+f((acc.me.points||{}).pending,1)+' oczekujące'):'Nie zalogowano – zakładka Konto.';
 const busy=S.sched.busy_pct, lj=st.lm_last;
 const cur=(S.sched.active||[])[0];
 cards('live',[['Połączenie',st.connected?'połączony':'łączę…'],['Bieżąca praca',cur?(S.kinds[cur]||cur).split(' (')[0]:'czeka na zadanie'],['Węzły online',f(st.nodes_online)],
 ['Praca (10 min)',f(busy,0)+'%'],['Rozmowy obsłużone',f(st.chats)],['Prędkość czatu',st.tps?f(st.tps,1)+' tok/s':'–'],['Tokeny wytrenowane',f(st.lm_tokens)],
 ['Wkład obliczeń',st.lm_flops?f(st.lm_flops/1e12,1)+' TFLOP':'–'],['Wątki CPU',f(a.threads)],['ID węzła',(st.id||'–').slice(0,8)]]);
 $('lastjob').textContent=lj?('Ostatnie zadanie LM: '+lj.kind+(lj.kd?' (destylacja)':'')+' v'+lj.version+', '+f(lj.ms/1000)+' s, '+tm(lj.at)):'Jeszcze bez zadania modelu językowego od uruchomienia.';
 const cpu=samples.map(s=>s.cpu),pc=samples.map(s=>s.cpu_proc),gp=samples.map(s=>s.gpu??null),rm=samples.map(s=>s.ram_total?s.ram_used/s.ram_total*100:null),wk=samples.map(s=>s.busy??null);
 graph('gcpu',[cpu,pc],['#3dff3d','#ffd84d']);$('lcpu').textContent='CPU '+f(last.cpu)+'% · węzeł '+f(last.cpu_proc)+'%';
 graph('ggpu',[gp],['#3dff3d']);$('lgpu').textContent=S.gpus.length?(S.gpus[0].name+(last.gpu!=null?' '+f(last.gpu)+'%':' – brak odczytu użycia')):'GPU: system nie zgłosił karty';
 graph('gram',[rm],['#3dff3d']);$('lram').textContent='RAM '+gb(last.ram_used)+' / '+gb(last.ram_total);
 graph('gwork',[wk],['#5ec8ff']);$('lwork').textContent='Praca węzła '+f(busy)+'% (limit '+a.cpu_pct+'%)';
 if(tab==='pw'&&!dirty)fillPower();else if(tab==='pw')renderGpu(false);
 if(tab==='st')renderStats();
 if(tab==='co'){const c=$('con'),bot=c.scrollTop+c.clientHeight>=c.scrollHeight-5;c.textContent=S.lines.join('\n');if(bot)c.scrollTop=c.scrollHeight}
 if(tab==='ac')renderAcc();
 if(tab==='pa')renderPassive();
 $('upd').textContent='odświeżono '+new Date().toLocaleTimeString('pl-PL')}
function fillPower(){const a=S.alloc,c=S.caps;
 $('threads').max=c.cpu_threads;const tot=(samples[samples.length-1]||{}).ram_total;$('ram_gb').max=tot?Math.floor(tot/2**30):64;
 for(const k of['threads','cpu_pct','ram_gb','gpu_pct']){$(k).value=a[k];out(k)}
 renderGpu(true);
 const sh=$('shares');sh.replaceChildren();
 for(const[k,lab]of Object.entries(S.kinds)){const r=el('div',null,'row'),l=el('label',lab),i=el('input'),o=el('output');i.type='range';i.min=0;i.max=100;i.step=5;i.value=a.shares[k];i.dataset.k=k;o.id='o-s-'+k;
  o.textContent=i.value==0?'wyłączone':i.value+'%';i.oninput=()=>{dirty=true;o.textContent=i.value==0?'wyłączone':i.value+'%'};r.append(l,i,o);sh.append(r)}
 for(const[k,lab]of Object.entries(S.planned)){const r=el('div',null,'row'),l=el('label',lab,'muted'),i=el('input'),o=el('output','brak zadań','muted');i.type='range';i.disabled=true;i.value=0;r.append(l,i,o);sh.append(r)}
 sh.append(el('p','Udział = najwyżej tyle procent czasu pracy dla danego rodzaju (100% = bez osobnego limitu). Czat odpowiada ludziom zawsze. Zadanie, które już trwa, nie jest przerywane – limity działają średnio w oknie 10 minut.','muted'))}
function renderGpu(full){const a=S.alloc,c=S.caps,G=S.gpu||{},b=G.bench;
 const gl=$('gpulist');gl.replaceChildren();
 if(!S.gpus.length)gl.append(el('p','System nie zgłosił żadnej karty graficznej.','muted'));
 for(const g of S.gpus){gl.append(el('p','• '+g.name+(g.vram_mb?' · pamięć zarezerwowana '+f(g.vram_mb)+' MB':'')+(g.util!=null?' · użycie '+f(g.util)+'%':' · użycie: brak odczytu')+' (źródło: '+g.source+(g.util_source?', '+g.util_source:'')+')'))}
 $('gpuinfo').textContent=G.directml?('DirectML dostępne: '+(G.dml_name||'karta')+'. Węzeł policzy trening na GPU dopiero wtedy, gdy test pokaże, że jest szybsze od CPU i daje tę samą stratę.'):
  G.dml_installed?('Wariant DirectML, ale DirectML jest niedostępny: '+(G.dml_error||'brak zgodnej karty')+'. Węzeł liczy na CPU (PyTorch '+(c.torch||'')+'); zaktualizuj sterownik karty (DirectX 12).'):
  ('Ta wersja węzła liczy na CPU (PyTorch '+(c.torch||'')+'). Dla kart AMD/Intel na Windows jest osobny wariant MyceliumNode-DirectML.exe (większy plik). Test GPU pokaże dziś tylko pomiar CPU.');
 $('gpubench').disabled=!!G.bench_running;$('benchmsg').textContent=G.bench_running?'Trwa test – zadania wstrzymane na czas pomiaru…':(G.bench_error?'Błąd testu: '+G.bench_error:'');
 const br=$('benchres');br.replaceChildren();
 if(b){const t=el('table'),hr=el('tr');['Gdzie','Typ','Czas kroku','Strata (1. krok)','Różnica straty','Wynik'].forEach(x=>hr.append(el('th',x)));t.append(hr);
  const row=(...v)=>{const r=el('tr');v.forEach(x=>r.append(el('td',x)));t.append(r)};
  row('CPU',b.cpu.dtype,f(b.cpu.s_per_step,3)+' s',f(b.cpu.loss0,4),'–','odniesienie');
  for(const g of b.gpu||[])row('GPU '+(b.adapter||''),g.dtype,g.s_per_step!=null?f(g.s_per_step,3)+' s ('+f(g.speedup,2)+'×)':'–',g.loss0!=null?f(g.loss0,4):'–',g.loss_rel_diff!=null?f(g.loss_rel_diff*100,2)+'%':'–',g.error?('błąd: '+g.error):(g.sane?(g.faster?'zgodna i szybsza':'zgodna, wolniejsza'):'niezgodna'));
  br.append(t,el('p','Test z '+tm(b.at)+': '+b.layers+' z 24 warstw + warstwa wyjściowa, '+b.steps+' kroki treningu LoRA na prawdziwym odłamku danych ('+b.seq.join('×')+' tokenów). Wynik: '+(b.ok?'GPU można włączyć ('+b.dtype+').':(b.reason||'GPU niedostępne.')),b.ok?'okc':'muted'))}
 if(full){$('gpu_on').checked=a.gpu_on;$('gpu_on').disabled=!(b&&b.ok&&G.directml)}
 $('gpunote').textContent=G.note||(a.gpu_on?('Trening na: '+(G.backend==='directml'?'GPU (DirectML)':'CPU – GPU zacznie od następnego zadania')):'Obciążenie GPU ogranicza ten sam limit czasu pracy co CPU.');
 const sg=$('ramsug');sg.classList.toggle('hidden',!(G.ram_suggest_gb&&!a.ram_gb));if(G.ram_suggest_gb)$('ramsugt').textContent='Ten komputer ma ≤ 8 GB RAM – proponujemy limit 3 GB dla węzła (trening w mniejszych paczkach, komputer zostaje płynny).'}
function out(k){const v=$(k).value;$('o-'+k).textContent=k==='ram_gb'?(v==0?'bez limitu':v+' GB'):k==='threads'?v+' z '+S.caps.cpu_threads:v+'%'}
for(const k of['threads','cpu_pct','ram_gb','gpu_pct'])$(k).oninput=()=>{dirty=true;out(k)};$('gpu_on').onchange=()=>dirty=true;
$('gpubench').onclick=async()=>{S.gpu=await api('/api/gpu/bench',{});renderGpu(false)};
$('ramsugb').onclick=async()=>{const r=await api('/api/alloc',{ram_gb:3});$('savemsg').textContent=r.restart_needed?'Ustawiono 3 GB – zadziała po ponownym uruchomieniu.':'Ustawiono 3 GB.';dirty=false;await tick()};
$('save').onclick=async()=>{const shares={};document.querySelectorAll('#shares input[data-k]').forEach(i=>shares[i.dataset.k]=+i.value);
 const r=await api('/api/alloc',{threads:+$('threads').value,cpu_pct:+$('cpu_pct').value,ram_gb:+$('ram_gb').value,gpu_on:$('gpu_on').checked,gpu_pct:+$('gpu_pct').value,shares});
 dirty=false;$('savemsg').textContent=(r.gpu_msg?r.gpu_msg+' ':'')+(r.restart_needed?'Zapisano. Nowy limit RAM zadziała po ponownym uruchomieniu.':'Zapisano i zastosowano.');await tick()};
$('restart').onclick=async()=>{if(!confirm('Uruchomić węzeł ponownie? Bieżące zadanie wróci do kolejki.'))return;await api('/api/restart',{});$('savemsg').textContent='Uruchamiam ponownie…'};
function renderStats(){const st=S.status,t=S.sched.totals;
 cards('stcards',[['Działa od',dur(st.now-st.started)],['Zadania treningu LM',f(st.lm_train)],['Ponowne oceny LM',f(st.lm_eval)],['Zgłoszone wersje LM',f(st.lm_proposed)],['Rundy uśrednienia',f(st.lm_rounds)],
 ['Tokeny wytrenowane',f(st.lm_tokens)],['Wkład obliczeń',st.lm_flops?f(st.lm_flops/1e12,1)+' TFLOP':'–'],['Grupowania słów',f(st.taxo_built)],['Weryfikacje słów',f(st.taxo_verified)],['Rozmowy w czacie',f(st.chats)],['Wstrzymania (limit mocy)',f(S.sched.waits)]]);
 const tb=$('kindt');tb.replaceChildren();const hr=el('tr');['Rodzaj','Zadania','Czas pracy','Teraz (10 min)'].forEach(x=>hr.append(el('th',x)));tb.append(hr);
 const names={...S.kinds,lm_distill:'Trening z destylacją (Qwen 1.5B → 0.5B)'};
 for(const k of new Set([...Object.keys(S.kinds),...Object.keys(t)])){const r=el('tr');r.append(el('td',names[k]||k),el('td',f((t[k]||{}).n)),el('td',dur((t[k]||{}).s||0)),el('td',f(S.sched.by_kind_pct[k]||0)+'%'));tb.append(r)}
 const pts=(S.account.me||{}).points||{};cards('pts',S.account.logged_in?[['Zatwierdzone',f(pts.approved,1)],['Oczekujące',f(pts.pending,1)],['Odrzucone',f(pts.rejected,1)],['Polecenia',f(S.account.me.referrals)]]:[['Konto','nie zalogowano']])}
let C=null;async function loadContrib(){try{C=await api('/api/contrib')}catch(e){C={error:String(e)}}renderStats();drawContrib()}
function drawContrib(){const b=$('cbars'),l=$('clab');b.replaceChildren();l.replaceChildren();if(!C)return;const d=C.daily||[];
 if(!d.length){b.append(el('div',null));$('csrc').textContent=C.error?C.error+'. ':'Brak wyników tego węzła w bazie w ostatnich 14 dniach (prawdziwy pusty stan).';return}
 const mx=Math.max(...d.map(x=>x.results));for(const x of d){const c=el('div',null,x.accepted?'acc':'');c.style.height=(x.results/mx*100)+'%';c.title=x.day+': '+x.results+' wyników, przyjęte '+x.accepted+', odrzucone '+x.rejected+', oczekujące '+x.pending+', '+f(x.h,2)+' h';b.append(c);l.append(el('span',x.day.slice(5)))}
 const t=C.total;$('csrc').textContent='Źródło: '+(C.source||'')+(t?'. Razem: '+t.results+' wyników, przyjęte '+t.accepted+', odrzucone '+t.rejected+', '+t.hours+' h obliczeń.':'')+' Zielony słupek = dzień z wynikiem przyjętym do modelu.'}
async function loadHist(){const rows=await api('/api/history?limit=500&q='+encodeURIComponent($('hq').value)+'&kind='+encodeURIComponent($('hk').value));
 $('hrows').replaceChildren(...rows.map(r=>{const tr=el('tr');const k=el('span',r.kind,'tag '+r.kind);const td=el('td');td.append(k);
  let m=r.msg;if(r.kind==='job'&&r.ms)m+=' · '+f(r.ms/1000)+' s';tr.append(el('td',tm(r.t)),td,el('td',m));return tr}));
 $('hinfo').textContent=rows.length+' wpisów (najnowsze u góry). Plik dziennika leży tylko na tym komputerze.'}
$('hgo').onclick=loadHist;$('hq').onkeydown=e=>{if(e.key==='Enter')loadHist()};
let accBusy=false,shownCode='';
function renderAcc(){if(accBusy)return;const a=S.account,box=$('acc');box.replaceChildren();
 const g=(t)=>{const d=el('div',null,'grp');d.append(el('h3',t));const i=el('div',null,'in');d.append(i);box.append(d);return i};
 if(a.error)box.append(el('p',a.error,'err'));
 if(a.logged_in){const m=a.me,i=g('Zalogowano anonimowo');
  const c=el('div',null,'cards');[['Pseudonim',m.handle],['Kod polecający',m.ref_code],['Węzły na koncie',m.nodes],['Ten komputer',m.this_node_linked?'przypisany':'nieprzypisany'],['Urządzenia',m.devices],['Punkty zatwierdzone',f((m.points||{}).approved,1)],['Punkty oczekujące',f((m.points||{}).pending,1)]]
   .forEach(([k,v])=>{const e=el('div',null,'c');e.append(el('div',k,'k'),el('div',v,'v'));c.append(e)});i.append(c);
  const i2=g('Kod odzyskiwania');i2.append(el('p',m.has_recovery?'Masz kod odzyskiwania. Nowy kod unieważnia stary.':'Brak kodu odzyskiwania – utwórz go, inaczej po utracie tego komputera stracisz konto.',m.has_recovery?'muted':'err'));
  if(shownCode){i2.append(el('div',shownCode,'code'),el('p','Zapisz go teraz – pokazujemy go tylko raz i nigdzie nie zapisujemy.','muted'))}
  const b=el('button',m.has_recovery?'Utwórz nowy kod':'Utwórz kod odzyskiwania','btn');b.onclick=()=>act('recovery_new',{});i2.append(b);
  const i3=g('Wyloguj ten komputer');const lo=el('button','Wyloguj','btn');lo.onclick=()=>{if(!m.has_recovery&&m.devices<=1&&!confirm('Bez kodu odzyskiwania stracisz dostęp do konta. Wylogować mimo to?'))return;act('logout',{force:!m.has_recovery&&m.devices<=1})};i3.append(lo);
 }else{const i=g('Nowe konto anonimowe');i.append(el('p','Bez e-maila, imienia i hasła. Węzeł przypisze się do konta, a punkty za zweryfikowaną pracę będą się zbierać na nim.','muted'));
  const r=el('div',null,'row'),h=el('input');h.type='text';h.placeholder='pseudonim (3–24 znaki)';const rf=el('input');rf.type='text';rf.placeholder='kod polecający (opcjonalnie)';rf.size=14;
  const b=el('button','Załóż konto','btn pri');b.onclick=()=>act('create',{handle:h.value,ref:rf.value});r.append(h,rf,b);i.append(r);
  const j=g('Mam już konto (kod odzyskiwania)');const r2=el('div',null,'row'),c=el('input');c.type='text';c.placeholder='MYC-XXXXXX-XXXXXX-XXXXXX-XXXXXX';c.style.flex='1';c.autocomplete='off';
  const b2=el('button','Zaloguj','btn pri');b2.onclick=()=>act('recover',{code:c.value});r2.append(c,b2);j.append(r2)}
 box.append(el('p','Sesja konta: '+a.where+'. Panel nie widzi tokenów – zna tylko pseudonim i liczby.','muted'))}
async function act(op,body){accBusy=true;try{const r=await api('/api/account/'+op,body);if(r.code)shownCode=r.code;if(op==='logout')shownCode='';S.account=r}finally{accBusy=false;renderAcc()}}
let paDirty=false;
function renderPassive(){const a=S.alloc,p=a.passive||{},v=S.passive||{};
 if(!paDirty){$('pa_on').checked=!!p.on;$('compute_on').checked=a.compute_on!==false;$('pa_seed').checked=p.seed!==false;$('pa_witness').checked=p.witness!==false;$('pa_disk').value=p.disk_gb;$('pa_daily').value=p.daily_gb;paOut()}
 const lim=(p.daily_gb||0)*2**30;
 cards('pacards',[['Stan',p.on?'włączony':'wyłączony'],['Moc obliczeniowa',a.compute_on!==false?'oddawana':'nie oddawana'],['Pobrane dziś',gb(v.down_today)+' z '+f(p.daily_gb,1)+' GB'],['Pobrane razem',gb(v.down_total)],
  ['Na dysku (dane)',gb(v.disk_bytes)+' z '+f(p.disk_gb,1)+' GB'],['Pliki sprawdzone SHA-256',f(v.cache_files)],['Świadectwa zgodne',f(v.witness_ok)],['Flagi',f(v.witness_flag)],
  ['Sprawdzenia razem',f(v.checks_total)],['Ostatnia runda',v.last?tm(v.last):'jeszcze nie']]);
 $('paerr').textContent=v.error?'Ostatni błąd: '+v.error:''}
function paOut(){$('o-pa_disk').textContent=$('pa_disk').value+' GB';$('o-pa_daily').textContent=$('pa_daily').value+' GB'}
['pa_on','compute_on','pa_seed','pa_witness','pa_disk','pa_daily'].forEach(k=>$(k).addEventListener('input',()=>{paDirty=true;paOut()}));
$('pa_save').onclick=async()=>{if(!$('compute_on').checked&&!confirm('Wyłączyć oddawanie mocy? Węzeł przestanie trenować i odpowiadać w czacie.'))return;
 await api('/api/alloc',{compute_on:$('compute_on').checked,passive:{on:$('pa_on').checked,seed:$('pa_seed').checked,witness:$('pa_witness').checked,disk_gb:+$('pa_disk').value,daily_gb:+$('pa_daily').value}});
 paDirty=false;$('pa_msg').textContent='Zapisano.';await tick()};
async function tick(){try{const since=samples.length?samples[samples.length-1].t:0;S=await api('/api/state?since='+since);samples=samples.concat(S.samples).slice(-450);render()}
 catch(e){const p=$('pill');p.className='pill bad';p.textContent=e.message==='auth'?'● brak klucza – otwórz panel z programu węzła':'● węzeł nie odpowiada'}}
tick();setInterval(tick,2000);setInterval(()=>{if(tab==='hi')loadHist();if(tab==='st')loadContrib()},30000);
if(!T){$('pill').textContent='● brak klucza'}
</script></body></html>"""
