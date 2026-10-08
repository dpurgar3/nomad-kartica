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
    const res = await fetch(path, { method: opts.body ? 'POST' : 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
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

  // ---------- Skener ----------
  // Čitanje QR koda s fotografije: probaj cijelu sliku pa izreske (mali QR na velikoj fotografiji).
  async function decodeImageFile(file, readerId) {
    const bmp = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = URL.createObjectURL(file); });
    const W = bmp.naturalWidth, H = bmp.naturalHeight;
    const cands = [[0, 0, W, H, 1600], [0, 0, W, H, 1000]];
    for (const f of [0.6, 0.4]) {
      const w = Math.round(W * f), h = Math.round(H * f);
      for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) cands.push([Math.round((W - w) * i / 2), Math.round((H - h) * j / 2), w, h, 900]);
    }
    const detector = ('BarcodeDetector' in window) ? await (async () => { try { const f = await BarcodeDetector.getSupportedFormats(); return f.includes('qr_code') ? new BarcodeDetector({ formats: ['qr_code'] }) : null; } catch { return null; } })() : null;
    const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d', { willReadFrequently: true });
    for (const [x, y, w, h, max] of cands) {
      const s = Math.min(1, max / Math.max(w, h));
      canvas.width = Math.round(w * s); canvas.height = Math.round(h * s);
      ctx.drawImage(bmp, x, y, w, h, 0, 0, canvas.width, canvas.height);
      try {
        if (detector) { const r = await detector.detect(canvas); if (r.length) return r[0].rawValue; continue; }
        const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.92));
        const sc = new Html5Qrcode(readerId, { verbose: false });
        try { return await sc.scanFile(new File([blob], 'qr.jpg', { type: 'image/jpeg' }), false); } finally { try { sc.clear(); } catch {} }
      } catch {}
    }
    throw new Error('Na fotografiji nisam pronašao QR kod. Slikaj izbliza, da kod bude oštar i cijeli u kadru.');
  }
  async function startScanner() {
    $('sErr').textContent = '';
    if (!window.Html5Qrcode) { $('sErr').textContent = 'Skener se nije učitao. Osvježi stranicu.'; return; }
    try {
      scanner = new Html5Qrcode('reader', { formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE], verbose: false, experimentalFeatures: { useBarCodeDetectorIfSupported: true } });
      await scanner.start({ facingMode: 'environment' }, { fps: 15, qrbox: (w, h) => { const s = Math.floor(Math.min(w, h) * 0.8); return { width: s, height: s }; }, videoConstraints: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } } }, onScan, () => {});
    } catch (e) {
      $('sErr').textContent = 'Kamera nije dostupna. Dopusti pristup kameri u postavkama preglednika.';
      scanner = null;
    }
  }
  function stopScanner() {
    if (scanner) { const s = scanner; scanner = null; s.stop().then(() => s.clear()).catch(() => {}); }
  }
  async function onScan(text) {
    if (scanBusy) return; scanBusy = true;
    try {
      const r = await api('/api/scan', { body: { code: text } });
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

  if ($('photo')) $('photo').addEventListener('change', async e => {
    const f = e.target.files && e.target.files[0]; e.target.value = ''; if (!f) return;
    $('sErr').textContent = ''; if ($('sBusy')) $('sBusy').hidden = false;
    stopScanner();
    try { const text = await decodeImageFile(f, 'reader2'); scanBusy = false; await onScan(text); }
    catch (err) { $('sErr').textContent = err.message; }
    finally { if ($('sBusy')) $('sBusy').hidden = true; if (!$('vScan').classList.contains('hidden') && !scanner) startScanner(); }
  });

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
