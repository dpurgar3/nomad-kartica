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
  function logout() { token = null; try { sessionStorage.removeItem('nomadAdmin'); } catch {} stopCam(); $('aMain').classList.add('hidden'); $('aLogin').classList.remove('hidden'); }
  async function enter() {
    $('aLogin').classList.add('hidden'); $('aMain').classList.remove('hidden'); loadStats();
    try { const me = await api('/api/admin/me'); $('who').textContent = `Prijavljen/a: ${me.name}`; } catch {}
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
      scanner = new Html5Qrcode('reader', { formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE], verbose: false });
      let busy = false;
      await scanner.start({ facingMode: 'environment' }, { fps: 10, qrbox: 220 }, async text => {
        if (busy) return; busy = true; await redeem(text); stopCam();
      }, () => {});
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
  $('btnOut').onclick = logout;
  if (token) enter();
})();
