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

  // ---------- Fotografija računa ----------
  // Server s fotografije čita QR kod i OIB lokala, pa šaljemo cijelu sliku (smanjenu na najviše 2000 px).
  function startScanner() { $('sErr').textContent = ''; }
  function stopScanner() {}
  async function photoToDataUrl(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
      const s = Math.min(1, 2800 / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', 0.88);
    } finally { URL.revokeObjectURL(url); }
  }
  $('sPhoto').addEventListener('change', async ev => {
    const f = ev.target.files && ev.target.files[0]; ev.target.value = '';
    if (!f || scanBusy) return;
    $('sErr').textContent = ''; $('sBusy').classList.remove('hidden'); $('sPhotoBtn').classList.add('hidden');
    try {
      let image;
      try { image = await photoToDataUrl(f); } catch { throw new Error('Fotografija se ne može otvoriti. Pokušaj ponovno.'); }
      await onScan(image);
    } catch (e) { $('sErr').textContent = e.message; }
    finally { $('sBusy').classList.add('hidden'); $('sPhotoBtn').classList.remove('hidden'); }
  });
  async function onScan(image) {
    if (scanBusy) return; scanBusy = true;
    try {
      const r = await api('/api/scan', { body: { image } });
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
