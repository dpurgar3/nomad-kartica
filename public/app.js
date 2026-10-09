'use strict';
(function () {
  const $ = id => document.getElementById(id);
  const VIEWS = ['vRegister', 'vLogin', 'vCard', 'vScan', 'vDone', 'vReward', 'vProfile'];
  let cfg = { pointsPerReceipt: 10, rewardPoints: 50, rewardName: 'Velika kava s mlijekom + kroasan', wifiSsid: 'ASUS - NOMAd', wifiPassword: '', maxReceiptsPerDay: 1 };
  let me = null;
  let scanner = null, scanBusy = false;

  const store = {
    get() { try { return localStorage.getItem('nomadToken'); } catch { return null; } },
    set(t) { try { localStorage.setItem('nomadToken', t); } catch {} },
    clear() { try { localStorage.removeItem('nomadToken'); } catch {} },
  };

  async function api(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json' };
    const t = store.get(); if (t) headers['X-Token'] = t;
    const ctrl = new AbortController(); const tm = setTimeout(() => ctrl.abort(), opts.timeout || 30000);
    let res;
    try { res = await fetch(path, { method: opts.body ? 'POST' : 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined, signal: ctrl.signal }); }
    catch (e) { throw new Error(e.name === 'AbortError' ? 'Provjera traje predugo. Pokušaj ponovno za minutu.' : 'Nema veze sa serverom. Provjeri internet i pokušaj ponovno.'); }
    finally { clearTimeout(tm); }
    let data = {}; try { data = await res.json(); } catch {}
    if (!res.ok) { const e = new Error(data.error || 'Nešto nije u redu. Pokušaj ponovno.'); e.status = res.status; throw e; }
    return data;
  }

  function toast(msg) {
    const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; t.setAttribute('role', 'status');
    document.body.appendChild(t); setTimeout(() => t.remove(), 2600);
  }

  function show(view) {
    if (view !== 'vScan') stopScanner();
    VIEWS.forEach(v => $(v).classList.toggle('hidden', v !== view));
    const loggedIn = !!me;
    $('tabs').classList.toggle('hidden', !loggedIn || view === 'vDone');
    $('btnProfile').classList.toggle('hidden', !loggedIn);
    document.querySelectorAll('nav.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === view));
    window.scrollTo(0, 0);
    if (view === 'vScan') startScanner();
    if (view === 'vReward') renderReward();
  }

  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
    return d.toLocaleString('hr-HR', { timeZone: 'Europe/Zagreb', day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function fmtDay(iso) {
    const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
    return d.toLocaleDateString('hr-HR', { timeZone: 'Europe/Zagreb', day: 'numeric', month: 'numeric', year: 'numeric' });
  }
  function euro(c) { return c == null ? '' : (c / 100).toFixed(2).replace('.', ',') + ' €'; }

  function bar(el, pts) {
    const per = cfg.rewardPoints / 5;
    el.innerHTML = '';
    for (let i = 0; i < 5; i++) { const s = document.createElement('i'); if (pts >= per * (i + 1)) s.className = 'on'; el.appendChild(s); }
  }
  function progressMsg(pts) {
    if (pts >= cfg.rewardPoints) return 'Imaš dovoljno bodova za <b>nagradu</b>! Preuzmi je i pokaži konobaru.';
    const left = Math.ceil((cfg.rewardPoints - pts) / cfg.pointsPerReceipt);
    const word = left === 1 ? 'račun' : (left >= 2 && left <= 4 ? 'računa' : 'računa');
    return `Još <b>${left} ${word}</b> do nagrade: <b>kava + kroasan</b> gratis`;
  }

  function renderCard() {
    if (!me) return;
    $('cName').textContent = me.name;
    $('cNo').textContent = me.cardNo;
    $('cPts').textContent = me.points;
    bar($('cBar'), me.points);
    $('cMsg').innerHTML = progressMsg(me.points);
    $('btnClaim').classList.toggle('hidden', me.points < cfg.rewardPoints && !me.rewards.length);
    $('btnClaim').lastChild.textContent = me.rewards.length ? 'Pokaži nagradu' : 'Preuzmi nagradu';
    const list = $('cList'); list.innerHTML = '';
    if (!me.recent.length) { list.innerHTML = '<div class="empty">Još nema skeniranih računa.</div>'; }
    me.recent.forEach(r => {
      const row = document.createElement('div'); row.className = 'item';
      const a = document.createElement('div');
      const t1 = document.createElement('div'); t1.className = 'a'; t1.textContent = r.kind === 'račun' ? ('Račun' + (r.amount_cents != null ? ' · ' + euro(r.amount_cents) : '')) : 'Bodovi od osoblja';
      const t2 = document.createElement('div'); t2.className = 'b'; t2.textContent = fmtDate(r.at);
      a.append(t1, t2);
      const p = document.createElement('div'); p.className = 'p'; p.textContent = (r.points > 0 ? '+' : '') + r.points;
      row.append(a, p); list.appendChild(row);
    });
    $('pName').textContent = me.name; $('pNo').textContent = me.cardNo;
  }

  function renderReward() {
    if (!me) return;
    const rw = me.rewards[0];
    $('rwNone').classList.toggle('hidden', !!rw);
    $('rwHave').classList.toggle('hidden', !rw);
    $('rwPts').textContent = me.points;
    $('btnClaim2').classList.toggle('hidden', !!rw || me.points < cfg.rewardPoints);
    if (rw) {
      $('rwCode').textContent = rw.code;
      $('rwQr').src = '/api/reward/' + encodeURIComponent(rw.code) + '/qr.svg';
      $('rwExp').textContent = fmtDay(rw.expires_at);
    }
  }

  function applyCfg() {
    document.querySelectorAll('.goal').forEach(e => e.textContent = cfg.rewardPoints);
    document.querySelectorAll('.ppr').forEach(e => e.textContent = cfg.pointsPerReceipt);
    document.querySelectorAll('.ssid').forEach(e => e.textContent = cfg.wifiSsid);
    document.querySelectorAll('.rname').forEach(e => e.textContent = cfg.rewardName);
    $('maxDay').textContent = cfg.maxReceiptsPerDay;
    if (cfg.address) $('addr').textContent = cfg.address;
    $('wifiPw').textContent = cfg.wifiPassword || 'Pitaj konobara';
    $('wifiCopy').classList.toggle('hidden', !cfg.wifiPassword);
  }

  // ---------- Fotografija računa ----------
  // Mobitel sam pročita QR kod s fotografije (brzo), a serveru šalje kod + smanjenu fotografiju,
  // na kojoj server provjeri OIB lokala otisnut na vrhu računa.
  function startScanner() { $('sErr').textContent = ''; }
  function stopScanner() {}
  const pause = () => new Promise(r => setTimeout(r, 0));
  function loadImage(file) {
    const url = URL.createObjectURL(file);
    return new Promise((res, rej) => { const i = new Image(); i.onload = () => res({ img: i, url }); i.onerror = () => { URL.revokeObjectURL(url); rej(new Error('img')); }; i.src = url; });
  }
  function drawCrop(img, x, y, w, h, scale, contrast) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * scale)); c.height = Math.max(1, Math.round(h * scale));
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (contrast) ctx.filter = 'grayscale(1) contrast(1.6)';
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, x, y, w, h, 0, 0, c.width, c.height);
    return c;
  }
  async function findQr(img) {
    const W = img.naturalWidth, H = img.naturalHeight;
    let det = null;
    if ('BarcodeDetector' in window) { try { const f = await BarcodeDetector.getSupportedFormats(); if (f.includes('qr_code')) det = new BarcodeDetector({ formats: ['qr_code'] }); } catch {} }
    const read = async c => {
      if (det) { try { const r = await det.detect(c); if (r.length) return r[0].rawValue; } catch {} }
      if (window.jsQR) { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height); const r = jsQR(d.data, c.width, c.height, { inversionAttempts: 'attemptBoth' }); if (r) return r.data; }
      return null;
    };
    const tries = [];
    for (const max of [1600, 1000]) tries.push([0, 0, W, H, max, false]);
    tries.push([0, H * 0.45, W, H * 0.55, 1400, false], [0, H * 0.6, W, H * 0.4, 1200, false]);
    // dugi računi: QR je malen – uvećaj preklapajuće pločice donjeg dijela računa
    const tile = Math.max(150, Math.min(W, H * 0.35)), step = tile / 2;
    for (let y = H - tile; y >= H * 0.3; y -= step) for (let x = 0; x <= Math.max(0, W - tile); x += step) {
      for (const ct of [false, true]) tries.push([x, y, Math.min(tile, W - x), Math.min(tile, H - y), 1300, ct, true]);
      if (x + tile >= W) break;
    }
    for (const [x, y, w, h, max, ct, up] of tries) {
      const s = up ? Math.min(3, max / Math.max(w, h)) : Math.min(1, max / Math.max(w, h));
      const t = await read(drawCrop(img, x, y, w, h, s, ct));
      if (t) return t;
      await pause();
    }
    return null;
  }
  $('sPhoto').addEventListener('change', async ev => {
    const f = ev.target.files && ev.target.files[0]; ev.target.value = '';
    if (!f || scanBusy) return;
    $('sErr').textContent = ''; $('sBusy').classList.remove('hidden'); $('sPhotoBtn').classList.add('hidden');
    let url;
    try {
      let img;
      try { ({ img, url } = await loadImage(f)); } catch { throw new Error('Fotografija se ne može otvoriti. Pokušaj ponovno.'); }
      $('sBusy').textContent = 'Čitam QR kod…';
      const qr = await findQr(img);
      if (!qr) throw new Error('Na fotografiji nisam pronašao QR kod. Slikaj račun izbliza, da QR kod bude oštar. Ako je račun dugačak, presavij srednji dio tako da se vide vrh i QR kod.');
      $('sBusy').textContent = 'Provjeravam račun… (do 15 sekundi)';
      const s = Math.min(1, 2000 / Math.max(img.naturalWidth, img.naturalHeight));
      const image = drawCrop(img, 0, 0, img.naturalWidth, img.naturalHeight, s, false).toDataURL('image/jpeg', 0.85);
      await onScan(qr, image);
    } catch (e) { $('sErr').textContent = e.message; }
    finally { if (url) URL.revokeObjectURL(url); $('sBusy').classList.add('hidden'); $('sPhotoBtn').classList.remove('hidden'); }
  });
  async function onScan(qr, image) {
    if (scanBusy) return; scanBusy = true;
    try {
      const r = await api('/api/scan', { body: { qr, image }, timeout: 45000 });
      me = r.me; renderCard();
      $('dAdded').textContent = r.added;
      $('dInfo').textContent = r.amountCents != null ? 'Račun ' + euro(r.amountCents) + ' · ' + new Date().toLocaleDateString('hr-HR') : '';
      $('dPts').textContent = me.points; bar($('dBar'), me.points); $('dMsg').innerHTML = progressMsg(me.points);
      if (navigator.vibrate) navigator.vibrate(80);
      show('vDone');
    } catch (e) {
      if (e.status === 401) return logout();
      $('sErr').textContent = e.message;
      setTimeout(() => { scanBusy = false; }, 2500); return;
    }
    scanBusy = false;
  }

  // ---------- Akcije ----------
  async function refresh() {
    try { me = await api('/api/me'); renderCard(); return true; }
    catch (e) { if (e.status === 401) { store.clear(); me = null; } return false; }
  }
  function logout() { store.clear(); me = null; show('vRegister'); }

  $('fRegister').addEventListener('submit', async ev => {
    ev.preventDefault(); $('rErr').textContent = '';
    try {
      const r = await api('/api/register', { body: { name: $('rName').value, phone: $('rPhone').value, pin: $('rPin').value, consent: $('rConsent').checked } });
      store.set(r.token); me = r.me; renderCard(); show('vCard'); toast('Kartica je spremna!');
    } catch (e) { $('rErr').textContent = e.message; }
  });
  $('fLogin').addEventListener('submit', async ev => {
    ev.preventDefault(); $('lErr').textContent = '';
    try {
      const r = await api('/api/login', { body: { phone: $('lPhone').value, pin: $('lPin').value } });
      store.set(r.token); me = r.me; renderCard(); show('vCard');
    } catch (e) { $('lErr').textContent = e.message; }
  });
  $('toLogin').onclick = () => show('vLogin');
  $('toRegister').onclick = () => show('vRegister');
  $('btnScan').onclick = () => show('vScan');
  $('scanBack').onclick = () => show('vCard');
  $('doneBack').onclick = () => show('vCard');
  $('btnProfile').onclick = () => show('vProfile');
  $('btnLogout').onclick = logout;
  document.querySelectorAll('nav.tabs button').forEach(b => b.onclick = async () => { if (b.dataset.tab !== 'vScan') await refresh(); show(b.dataset.tab); });
  $('btnClaim').onclick = async () => {
    if (!me.rewards.length) {
      try { const r = await api('/api/reward', { body: {} }); me = r.me; renderCard(); }
      catch (e) { toast(e.message); return; }
    }
    show('vReward');
  };
  $('btnClaim2').onclick = () => $('btnClaim').onclick();
  $('btnWifi').onclick = () => $('wifiSheet').classList.remove('hidden');
  $('wifiClose').onclick = () => $('wifiSheet').classList.add('hidden');
  $('wifiSheet').onclick = e => { if (e.target === $('wifiSheet')) $('wifiSheet').classList.add('hidden'); };
  $('wifiCopy').onclick = async () => {
    try { await navigator.clipboard.writeText(cfg.wifiPassword); toast('Lozinka je kopirana'); }
    catch { toast('Označi lozinku i kopiraj je ručno'); }
  };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && me) refresh(); });

  // ---------- Start ----------
  (async function init() {
    try { cfg = Object.assign(cfg, await api('/api/config')); } catch {}
    applyCfg();
    if (store.get() && await refresh()) show('vCard'); else show('vRegister');
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  })();
})();
