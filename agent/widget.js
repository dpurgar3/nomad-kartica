/* Agent NOMAd – chat widget za nomadinfo.space
   Ugradnja: <script src="https://nomad-kartica.onrender.com/agent-nomad.js" defer></script> */
(function () {
  'use strict';
  if (window.__agentNomad) return; window.__agentNomad = true;
  var me = document.currentScript;
  var API = (me && me.src ? new URL(me.src).origin : 'https://nomad-kartica.onrender.com') + '/agent/chat';
  var DELAY = 5000;
  var CHIPS = ['Radno vrijeme', 'Što nudite?', 'Cijene kave', 'Što je novo?', 'Prognoza za danas', 'Kartica vjernosti'];
  var POZDRAV = 'Jiha, dobrodošli u NOMAd! 🤠 Ja sam Agent NOMAd. Pitajte me za ponudu, cijene, radno vrijeme, akcije ili današnju prognozu.';

  function ss(k, v) { try { if (v === undefined) return sessionStorage.getItem(k); sessionStorage.setItem(k, v); } catch (e) { return null; } }

  /* ---------- Kauboj (cijela figura s bičem) ---------- */
  var KAUBOJ =
    '<svg class="kb" viewBox="0 0 150 190" aria-hidden="true">' +
    '<ellipse cx="62" cy="184" rx="38" ry="5" fill="#000" opacity=".18"/>' +
    // noge i čizme
    '<path d="M44 120 L40 168 L54 168 L58 124Z" fill="#2f4d7a"/><path d="M64 124 L68 168 L82 168 L80 120Z" fill="#2f4d7a"/>' +
    '<path d="M36 166 h20 v10 h-24 q-4 0 -2-5Z" fill="#6b3e1c"/><path d="M66 166 h20 q6 0 6 6 v4 h-26Z" fill="#6b3e1c"/>' +
    // remen
    '<rect x="40" y="114" width="44" height="9" rx="2" fill="#4a2a12"/><rect x="57" y="114" width="10" height="9" rx="1.5" fill="#e0b84a"/>' +
    // tijelo: košulja + prsluk
    '<path d="M40 78 q22 -10 44 0 l2 38 h-48Z" fill="#c0392b"/>' +
    '<path d="M40 78 q8 -4 14 -4 l2 42 h-18Z" fill="#8a5a2b"/><path d="M84 78 q-8 -4 -14 -4 l-2 42 h18Z" fill="#8a5a2b"/>' +
    '<circle cx="54" cy="96" r="1.6" fill="#e0b84a"/><polygon points="72,90 74,95 79,95 75,98 77,103 72,100 67,103 69,98 65,95 70,95" fill="#e0b84a"/>' +
    // lijeva ruka (na boku)
    '<path d="M40 82 q-12 8 -10 26 q2 6 8 6 l4 -4 q-6 -2 -4 -10 q0 -8 6 -12Z" fill="#c0392b"/><circle cx="40" cy="112" r="5" fill="#f1c9a0"/>' +
    // desna ruka s bičem (animira se)
    '<g class="ruka"><path d="M82 82 q12 0 18 -10 l6 4 q-8 16 -22 16Z" fill="#c0392b"/><circle cx="104" cy="72" r="5" fill="#f1c9a0"/>' +
    '<path d="M104 72 l4 -10" stroke="#4a2a12" stroke-width="4" stroke-linecap="round"/>' +
    '<path class="bic" d="M108 62 C 126 30, 150 40, 140 64 S 120 92, 146 104" fill="none" stroke="#6b3e1c" stroke-width="2.4" stroke-linecap="round"/>' +
    '<g class="prasak"><path d="M146 104 l8 -4 M146 104 l6 6 M146 104 l-2 9 M146 104 l9 2" stroke="#ffcf3f" stroke-width="2.4" stroke-linecap="round"/></g></g>' +
    // vrat, marama, glava
    '<rect x="57" y="64" width="10" height="10" fill="#f1c9a0"/><path d="M52 72 l10 10 l10 -10Z" fill="#e2b13c"/>' +
    '<circle cx="62" cy="52" r="15" fill="#f1c9a0"/>' +
    '<circle cx="56.5" cy="51" r="1.8" fill="#1f3d2b"/><circle cx="67.5" cy="51" r="1.8" fill="#1f3d2b"/>' +
    '<path d="M54 58 q4 -3 8 0 q4 -3 8 0" fill="none" stroke="#6b3e1c" stroke-width="2.6" stroke-linecap="round"/>' +
    '<path d="M57 61 q5 4 10 0" fill="none" stroke="#1f3d2b" stroke-width="1.6" stroke-linecap="round"/>' +
    // šešir
    '<path d="M47 41 c0 -12 4 -20 8 -20 c3 0 4 3 7 3 s4 -3 7 -3 c4 0 8 8 8 20Z" fill="#c9a24a"/>' +
    '<rect x="47" y="37" width="30" height="4" fill="#6b3e1c"/>' +
    '<path d="M32 42 c3 6 14 8 30 8 s27 -2 30 -8 c-5 2 -14 3 -30 3 s-25 -1 -30 -3Z" fill="#b08a3a"/>' +
    '</svg>';

  var CSS =
    ':host{all:initial}' +
    '*{box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}' +
    '.wrap{position:fixed;right:16px;bottom:calc(14px + env(safe-area-inset-bottom,0px));z-index:2147483000;display:flex;flex-direction:column;align-items:flex-end;gap:8px}' +
    '.kauboj{width:120px;height:152px;border:0;background:none;padding:0;cursor:pointer;opacity:0;transform:translateX(160px);transition:transform .6s cubic-bezier(.2,1.4,.4,1),opacity .3s}' +
    '.kauboj.in{opacity:1;transform:none}.kauboj:focus-visible{outline:3px solid #e0b84a;border-radius:12px}' +
    '.kb{width:100%;height:100%;overflow:visible;filter:drop-shadow(0 4px 6px rgba(0,0,0,.18))}' +
    '.ruka{transform-origin:84px 82px}.bic{stroke-dasharray:120;stroke-dashoffset:0}.prasak{opacity:0;transform-origin:146px 104px}' +
    '.kauboj.pucaj .ruka{animation:mah .9s ease-in-out}.kauboj.pucaj .bic{animation:bic .9s ease-in-out}.kauboj.pucaj .prasak{animation:prasak .9s ease-out}' +
    '@keyframes mah{0%{transform:rotate(0)}35%{transform:rotate(-55deg)}55%{transform:rotate(18deg)}70%{transform:rotate(8deg)}100%{transform:rotate(0)}}' +
    '@keyframes bic{0%{stroke-dashoffset:0}35%{stroke-dashoffset:90}58%{stroke-dashoffset:0}100%{stroke-dashoffset:0}}' +
    '@keyframes prasak{0%,52%{opacity:0;transform:scale(.3)}58%{opacity:1;transform:scale(1.5)}80%{opacity:0;transform:scale(2)}100%{opacity:0}}' +
    '.kauboj:hover .kb{transform:translateY(-3px);transition:transform .2s}' +
    '.mjehur{max-width:240px;background:#fffaf0;color:#2b1d0e;border:2px solid #6b3e1c;border-radius:14px 14px 4px 14px;padding:10px 30px 10px 12px;font-size:14px;line-height:1.35;box-shadow:0 6px 18px rgba(0,0,0,.15);position:relative;cursor:pointer;opacity:0;transform:translateY(8px);transition:.3s}' +
    '.mjehur.in{opacity:1;transform:none}.mjehur b{display:block;color:#8a5a2b;margin-bottom:2px}' +
    '.x{position:absolute;top:4px;right:6px;border:0;background:none;font-size:18px;line-height:1;color:#8a5a2b;cursor:pointer;padding:2px 4px}' +
    '.panel{position:fixed;right:16px;bottom:calc(16px + env(safe-area-inset-bottom,0px));width:370px;max-width:calc(100vw - 32px);height:540px;max-height:calc(100vh - 32px);background:#fffaf0;border:2px solid #6b3e1c;border-radius:18px;box-shadow:0 18px 50px rgba(0,0,0,.28);display:flex;flex-direction:column;overflow:hidden;z-index:2147483001}' +
    '.panel[hidden]{display:none}' +
    '.glava{display:flex;align-items:center;gap:10px;padding:10px 12px;background:#6b3e1c;color:#fffaf0}' +
    '.av{width:42px;height:42px;border-radius:50%;background:#f5efe1;overflow:hidden;flex:none}.av svg{width:84px;height:106px;margin:-6px 0 0 -21px}' +
    '.glava b{font-size:16px;display:block}.glava small{opacity:.85;font-size:12px}.glava .zatvori{margin-left:auto;background:none;border:0;color:#fffaf0;font-size:24px;cursor:pointer;padding:4px 8px}' +
    '.poruke{flex:1;overflow-y:auto;padding:14px 12px;display:flex;flex-direction:column;gap:10px;background:#fbf3e2}' +
    '.p{max-width:86%;padding:9px 12px;border-radius:14px;font-size:14.5px;line-height:1.45;white-space:pre-wrap;overflow-wrap:anywhere;color:#2b1d0e}' +
    '.p.ai{background:#fff;border:1px solid #e6d5b5;border-radius:14px 14px 14px 4px;align-self:flex-start}' +
    '.p.ja{background:#c9a24a;color:#2b1d0e;border-radius:14px 14px 4px 14px;align-self:flex-end}' +
    '.p a{color:#8a5a2b}.p.err{background:#fde8e4;border-color:#f3b8ad}' +
    '.tipka{display:flex;gap:4px;padding:4px 2px}.tipka i{width:7px;height:7px;border-radius:50%;background:#8a5a2b;animation:t 1s infinite}.tipka i:nth-child(2){animation-delay:.15s}.tipka i:nth-child(3){animation-delay:.3s}' +
    '@keyframes t{0%,100%{opacity:.25}50%{opacity:1}}' +
    '.chips{display:flex;flex-wrap:wrap;gap:6px;padding:8px 12px 0;background:#fbf3e2}' +
    '.chip{border:1px solid #c9a24a;background:#fffaf0;color:#6b3e1c;border-radius:999px;padding:5px 10px;font-size:13px;cursor:pointer}.chip:hover{background:#f3e3bd}' +
    'form{display:flex;gap:8px;padding:10px 12px;background:#fbf3e2;border-top:1px solid #e6d5b5}' +
    'input{flex:1;min-width:0;border:1px solid #d9c49a;border-radius:12px;padding:10px 12px;font-size:16px;background:#fff;color:#2b1d0e;outline:none}input:focus{border-color:#8a5a2b}' +
    'form button{border:0;background:#6b3e1c;color:#fffaf0;border-radius:12px;padding:0 16px;font-weight:600;font-size:15px;cursor:pointer}form button:disabled{opacity:.5}' +
    '.dno{font-size:11px;color:#8a7a5c;text-align:center;padding:0 12px 8px;background:#fbf3e2}' +
    '@media (max-width:480px){.panel{right:0;left:0;bottom:0;width:100%;max-width:100%;height:85vh;max-height:85vh;border-radius:18px 18px 0 0;border-width:2px 0 0}.kauboj{width:96px;height:122px}}' +
    '@media (prefers-reduced-motion:reduce){.kauboj{transition:opacity .3s}.kauboj.pucaj .ruka,.kauboj.pucaj .bic,.kauboj.pucaj .prasak{animation:none}}';

  /* ---------- Zvuk biča (Web Audio, bez datoteke) ---------- */
  var actx = null;
  function primeAudio() {
    try { if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === 'suspended') actx.resume(); } catch (e) {}
  }
  ['pointerdown', 'keydown', 'touchstart'].forEach(function (ev) { window.addEventListener(ev, primeAudio, { once: true, passive: true, capture: true }); });
  function pucanj() {
    if (!actx || actx.state !== 'running') return;
    try {
      var t = actx.currentTime, n = Math.floor(actx.sampleRate * 0.22), buf = actx.createBuffer(1, n, actx.sampleRate), d = buf.getChannelData(0);
      for (var i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 4);
      var src = actx.createBufferSource(); src.buffer = buf;
      var hp = actx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1200;
      var g = actx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.9, t + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
      src.connect(hp); hp.connect(g); g.connect(actx.destination); src.start(t); src.stop(t + 0.23);
      var o = actx.createOscillator(), og = actx.createGain(); o.type = 'square'; o.frequency.setValueAtTime(2600, t); o.frequency.exponentialRampToValueAtTime(600, t + 0.03);
      og.gain.setValueAtTime(0.25, t); og.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
      o.connect(og); og.connect(actx.destination); o.start(t); o.stop(t + 0.05);
    } catch (e) {}
  }

  /* ---------- Tekst ---------- */
  function esc(s) { return s.replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function fmt(s) {
    return esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      // točka, zarez, upitnik… na kraju rečenice NIJE dio linka (inače "Not Found")
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]*[^\s<).,;:!?'"&])/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  }

  /* ---------- Sučelje ---------- */
  var host, root, wrap, btn, bubble, panel, list, input, sendBtn, chipsEl, busy = false;
  var hist = []; try { hist = JSON.parse(ss('agent-nomad-hist') || '[]'); } catch (e) { hist = []; }

  function build() {
    host = document.createElement('div'); host.id = 'agent-nomad';
    root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    root.innerHTML = '<style>' + CSS + '</style>' +
      '<div class="wrap"><div class="mjehur" role="button" tabindex="0"><button class="x" aria-label="Zatvori">×</button><b>Agent NOMAd 🤠</b>Cijene, radno vrijeme, akcije ili prognoza? Pitaj me!</div>' +
      '<button class="kauboj" aria-label="Otvori Agent NOMAd chat">' + KAUBOJ + '</button></div>' +
      '<div class="panel" hidden role="dialog" aria-label="Agent NOMAd"><div class="glava"><div class="av">' + KAUBOJ + '</div><div><b>Agent NOMAd</b><small>NOMAd Caffe Bar · Novi Marof</small></div><button class="zatvori" aria-label="Zatvori chat">×</button></div>' +
      '<div class="poruke" aria-live="polite"></div><div class="chips"></div>' +
      '<form><input type="text" placeholder="Napiši pitanje…" aria-label="Pitanje" maxlength="500" autocomplete="off"><button type="submit">Pošalji</button></form>' +
      '<div class="dno">AI asistent može pogriješiti · narudžbe i rezervacije: +385 91 934 5741</div></div>';
    document.body.appendChild(host);
    wrap = root.querySelector('.wrap'); btn = root.querySelector('.kauboj'); bubble = root.querySelector('.mjehur');
    panel = root.querySelector('.panel'); list = root.querySelector('.poruke'); input = root.querySelector('input');
    sendBtn = root.querySelector('form button'); chipsEl = root.querySelector('.chips');
    btn.onclick = otvori;
    bubble.onclick = function (e) { if (e.target.classList.contains('x')) { e.stopPropagation(); bubble.classList.remove('in'); ss('agent-nomad-bubble', '0'); return; } otvori(); };
    bubble.onkeydown = function (e) { if (e.key === 'Enter') otvori(); };
    root.querySelector('.zatvori').onclick = zatvori;
    root.querySelector('form').onsubmit = function (e) { e.preventDefault(); posalji(input.value); };
    CHIPS.forEach(function (c) { var b = document.createElement('button'); b.type = 'button'; b.className = 'chip'; b.textContent = c; b.onclick = function () { posalji(c); }; chipsEl.appendChild(b); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !panel.hidden) zatvori(); });
  }

  function dodaj(role, text, cls) {
    var d = document.createElement('div'); d.className = 'p ' + (role === 'user' ? 'ja' : 'ai') + (cls ? ' ' + cls : '');
    d.innerHTML = fmt(text); list.appendChild(d); list.scrollTop = list.scrollHeight; return d;
  }
  function otvori() {
    primeAudio();
    panel.hidden = false; wrap.style.display = 'none';
    if (!list.childElementCount) { dodaj('assistant', POZDRAV); hist.forEach(function (m) { dodaj(m.role, m.content); }); }
    chipsEl.style.display = hist.length ? 'none' : 'flex';
    setTimeout(function () { input.focus(); }, 50);
  }
  function zatvori() { panel.hidden = true; wrap.style.display = 'flex'; bubble.classList.remove('in'); }

  function posalji(text) {
    text = (text || '').trim(); if (!text || busy) return;
    busy = true; sendBtn.disabled = true; input.value = ''; chipsEl.style.display = 'none';
    dodaj('user', text); hist.push({ role: 'user', content: text });
    var t = document.createElement('div'); t.className = 'p ai'; t.innerHTML = '<span class="tipka"><i></i><i></i><i></i></span>'; list.appendChild(t); list.scrollTop = list.scrollHeight;
    fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: hist.slice(-12) }) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (x) {
        t.remove();
        if (x.ok && x.j.reply) { dodaj('assistant', x.j.reply); hist.push({ role: 'assistant', content: x.j.reply }); }
        else { hist.pop(); dodaj('assistant', (x.j && x.j.error) || 'Nešto je zapelo. Pokušaj ponovno.', 'err'); }
      })
      .catch(function () { t.remove(); hist.pop(); dodaj('assistant', 'Nema veze sa serverom. Probaj za tren ili nas nazovi: +385 91 934 5741', 'err'); })
      .then(function () { busy = false; sendBtn.disabled = false; ss('agent-nomad-hist', JSON.stringify(hist.slice(-20))); input.focus(); });
  }

  function pojavi() {
    btn.classList.add('in');
    var prvi = ss('agent-nomad-seen') !== '1';
    setTimeout(function () {
      if (prvi) { btn.classList.add('pucaj'); setTimeout(pucanj, 500); setTimeout(function () { btn.classList.remove('pucaj'); }, 1000); ss('agent-nomad-seen', '1'); }
      if (ss('agent-nomad-bubble') !== '0') setTimeout(function () { bubble.classList.add('in'); }, prvi ? 900 : 200);
    }, 550);
  }

  /* ---------- Pokretanje: 5 s stvarnog gledanja stranice ---------- */
  function start() {
    build();
    var gledano = 0, zadnje = Date.now(), gotovo = false;
    var iv = setInterval(function () {
      var now = Date.now();
      if (document.visibilityState === 'visible') gledano += now - zadnje;
      zadnje = now;
      if (!gotovo && gledano >= DELAY) { gotovo = true; clearInterval(iv); pojavi(); }
    }, 250);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
