'use strict';
(function () {
  const $ = id => document.getElementById(id);
  let token = null, scanner = null, guestNo = null;
  try { token = sessionStorage.getItem('nomadAdmin'); } catch {}

  async function api(path, body) {
    const res = await fetch(path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-Admin': token || '' }, body: body ? JSON.stringify(body) : undefined });
    let data = {}; try { data = await res.json(); } catch {}
    if (res.status === 401 && path !== '/api/admin/login') { logout(); }
    if (!res.ok) throw new Error(data.error || 'Greška.');
    return data;
  }
  function logout() { token = null; try { sessionStorage.removeItem('nomadAdmin'); } catch {} stopCam(); $('aMain').classList.add('hidden'); $('obavijesti').classList.add('hidden'); $('aLogin').classList.remove('hidden'); }
  async function enter() {
    $('aLogin').classList.add('hidden'); $('aMain').classList.remove('hidden'); loadStats();
    try {
      const me = await api('/api/admin/me'); $('who').textContent = `Prijavljen/a: ${me.name}`;
      if (me.owner) { $('obavijesti').classList.remove('hidden'); loadObav(); if (location.hash === '#obavijesti') $('obavijesti').scrollIntoView(); }
    } catch {}
  }
  function hrDat(d) { const [y, m, dd] = String(d).slice(0, 10).split('-'); return `${+dd}.${+m}.${y}.`; }
  async function loadObav() {
    try {
      const r = await api('/api/admin/obavijesti'), el = $('obList'); el.textContent = '';
      if (!r.list.length) { el.innerHTML = '<div class="small">Još nema obavijesti.</div>'; return; }
      for (const o of r.list) {
        const istekla = o.vrijedi_do && o.vrijedi_do < r.danas;
        const d = document.createElement('div');
        d.style.cssText = 'background:#000;border:1px solid var(--line);border-radius:14px;padding:12px;display:flex;gap:10px;align-items:flex-start' + (istekla ? ';opacity:.5' : '');
        const t = document.createElement('div'); t.style.flex = '1';
        const p = document.createElement('div'); p.style.whiteSpace = 'pre-wrap'; p.textContent = o.tekst;
        const m = document.createElement('div'); m.className = 'small';
        m.textContent = 'Upisano ' + hrDat(o.created_at) + (o.vrijedi_do ? ' · vrijedi do ' + hrDat(o.vrijedi_do) : ' · bez isteka') + (istekla ? ' · ISTEKLA' : '');
        t.append(p, m);
        const b = document.createElement('button'); b.type = 'button'; b.className = 'btn ghost'; b.style.cssText = 'width:auto;height:40px;padding:0 12px;font-size:14px'; b.textContent = 'Obriši';
        b.onclick = async () => { b.disabled = true; try { await api('/api/admin/obavijesti/' + o.id + '/obrisi', {}); loadObav(); } catch (e) { $('obErr').textContent = e.message; b.disabled = false; } };
        d.append(t, b); el.appendChild(d);
      }
    } catch (e) { $('obErr').textContent = e.message; }
  }
  async function loadStats() {
    try {
      const s = await api('/api/admin/stats');
      $('sGuests').textContent = s.guests; $('sToday').textContent = s.scansToday; $('sTotal').textContent = s.scansTotal; $('sRedeemed').textContent = s.rewardsRedeemed;
    } catch {}
  }
  async function redeem(code) {
    $('redeemOk').textContent = ''; $('redeemErr').textContent = '';
    try {
      const r = await api('/api/admin/redeem', { code });
      $('redeemOk').textContent = `Potvrđeno: ${r.item} za ${r.guest} (kartica ${r.cardNo}). Poslužite nagradu.`;
      $('code').value = ''; if (navigator.vibrate) navigator.vibrate(120); loadStats();
    } catch (e) { $('redeemErr').textContent = e.message; }
  }
  function stopCam() { if (scanner) { const s = scanner; scanner = null; s.stop().then(() => s.clear()).catch(() => {}); } $('reader').classList.add('hidden'); $('btnCam').textContent = 'Skeniraj kod gosta kamerom'; }

  $('fAdmin').addEventListener('submit', async ev => {
    ev.preventDefault(); $('aErr').textContent = '';
    try { const r = await api('/api/admin/login', { pin: $('aPin').value }); token = r.token; try { sessionStorage.setItem('nomadAdmin', token); } catch {} $('aPin').value = ''; enter(); }
    catch (e) { $('aErr').textContent = e.message; }
  });
  $('fRedeem').addEventListener('submit', ev => { ev.preventDefault(); redeem($('code').value); });
  $('btnCam').onclick = async () => {
    if (scanner) return stopCam();
    $('reader').classList.remove('hidden'); $('btnCam').textContent = 'Zatvori kameru';
    try {
      const mk = () => new Html5Qrcode('reader', { formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE], useBarCodeDetectorIfSupported: true, verbose: false });
      let busy = false;
      const onOk = async text => { if (busy) return; busy = true; await redeem(text); stopCam(); };
      // veliki okvir za čitanje (QR s ekrana mobitela gosta) i viša razlučivost kamere
      const box = (w, h) => { const s = Math.floor(Math.min(w, h) * 0.85); return { width: s, height: s }; };
      scanner = mk();
      try {
        await scanner.start({ facingMode: 'environment' }, { fps: 15, qrbox: box, videoConstraints: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } } }, onOk, () => {});
      } catch {
        // rezerva: jednostavna postavka kamere (kao prije)
        try { scanner.clear(); } catch {}
        scanner = mk();
        await scanner.start({ facingMode: 'environment' }, { fps: 10, qrbox: box }, onOk, () => {});
      }
    } catch { $('redeemErr').textContent = 'Kamera nije dostupna.'; stopCam(); }
  };
  $('fFind').addEventListener('submit', async ev => {
    ev.preventDefault(); $('ptsOk').textContent = ''; $('ptsErr').textContent = ''; $('guest').classList.add('hidden');
    try {
      const g = await api('/api/admin/lookup?q=' + encodeURIComponent($('q').value));
      guestNo = g.cardNo; $('gName').textContent = g.name + ' · ' + g.phone; $('gPts').textContent = g.points; $('gNo').textContent = g.cardNo;
      $('guest').classList.remove('hidden');
    } catch (e) { $('ptsErr').textContent = e.message; }
  });
  $('btnPts').onclick = async () => {
    $('ptsOk').textContent = ''; $('ptsErr').textContent = '';
    try {
      const r = await api('/api/admin/points', { cardNo: guestNo, points: parseInt($('pts').value, 10), note: $('note').value });
      $('gPts').textContent = r.points; $('ptsOk').textContent = `Spremljeno. ${r.name} sada ima ${r.points} bodova.`; $('note').value = '';
    } catch (e) { $('ptsErr').textContent = e.message; }
  };
  $('fObav').addEventListener('submit', async ev => {
    ev.preventDefault(); $('obOk').textContent = ''; $('obErr').textContent = '';
    try { await api('/api/admin/obavijesti', { tekst: $('obTekst').value, vrijediDo: $('obDo').value }); $('obTekst').value = ''; $('obDo').value = ''; $('obOk').textContent = 'Objavljeno. Agent NOMAd to sada zna.'; loadObav(); }
    catch (e) { $('obErr').textContent = e.message; }
  });
  $('btnOut').onclick = logout;
  if (token) enter();
})();
