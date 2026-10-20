'use strict';
(function () {
  const $ = id => document.getElementById(id);
  const TZ = 'Europe/Zagreb';
  let token = null, D = null, range = { d: '30' }, gFilter = 'all', rFilter = 'all', gSort = { k: 'receipts', dir: -1 };
  try { token = sessionStorage.getItem('nomadAdmin'); } catch {}

  // ---------- pomoćne ----------
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = n => Number(n || 0).toLocaleString('hr-HR');
  const eur = c => c == null ? '–' : (c / 100).toLocaleString('hr-HR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
  const pct = x => Math.round((x || 0) * 100) + ' %';
  const toDate = s => { if (!s) return null; const t = String(s); return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(t) ? t : t.replace(' ', 'T') + 'Z'); };
  const dt = s => { const d = toDate(s); return d ? d.toLocaleString('hr-HR', { timeZone: TZ, day: 'numeric', month: 'numeric', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '–'; };
  const dd = s => { const d = toDate(s); return d ? d.toLocaleDateString('hr-HR', { timeZone: TZ, day: 'numeric', month: 'numeric', year: 'numeric' }) : '–'; };
  const shortDay = k => { const [, m, d] = k.split('-'); return `${+d}.${+m}.`; };
  const ago = s => { const d = toDate(s); if (!d) return 'nikad'; const n = Math.floor((Date.now() - d) / 86400e3); return n <= 0 ? 'danas' : n === 1 ? 'jučer' : `prije ${n} d`; };

  async function api(path, body) {
    const res = await fetch(path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-Admin': token || '' }, body: body ? JSON.stringify(body) : undefined });
    let data = {}; try { data = await res.json(); } catch {}
    if (res.status === 401 && path !== '/api/admin/login') logout();
    if (!res.ok) throw Object.assign(new Error(data.error || 'Greška.'), { status: res.status });
    return data;
  }
  function logout() {
    token = null; try { sessionStorage.removeItem('nomadAdmin'); } catch {}
    $('aMain').classList.add('hidden'); $('btnOut').classList.add('hidden'); $('aLogin').classList.remove('hidden');
  }
  function query() {
    if (range.d === 'custom') return `od=${range.od}&do=${range.do}`;
    if (range.d === 'all') return 'od=sve';
    const to = new Date(), from = new Date(Date.now() - (parseInt(range.d, 10) - 1) * 86400e3);
    const f = d => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
    return `od=${f(from)}&do=${f(to)}`;
  }
  async function load() {
    $('mErr').textContent = '';
    try {
      D = await api('/api/admin/dashboard?' + query());
      $('pOd').value = D.from; $('pDo').value = D.to;
      $('gen').textContent = 'osvježeno ' + new Date(D.generated).toLocaleTimeString('hr-HR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
      render();
    } catch (e) {
      $('mErr').textContent = e.status === 403 ? 'Admin panel je samo za vlasnika – prijavi se vlasničkim PIN-om.' : e.message;
      if (e.status === 403) logout();
    }
  }
  async function enter() { $('aLogin').classList.add('hidden'); $('aMain').classList.remove('hidden'); $('btnOut').classList.remove('hidden'); load(); }

  // ---------- grafovi (SVG) ----------
  function bars(series, labels, { h = 180, colors, labelEvery, tip } = {}) {
    const W = 640, padL = 34, padB = 26, padT = 8, n = labels.length, groups = series.length;
    const max = Math.max(1, ...series.flat());
    const step = Math.ceil(max / 4) || 1, top = step * 4;
    const cw = (W - padL) / n, bw = Math.max(1.5, (cw * 0.78) / groups);
    let s = `<svg viewBox="0 0 ${W} ${h}" role="img">`;
    for (let i = 0; i <= 4; i++) {
      const y = padT + (h - padT - padB) * (1 - i / 4);
      s += `<line x1="${padL}" x2="${W}" y1="${y}" y2="${y}" stroke="#2E2A20" stroke-width="1"/><text x="${padL - 6}" y="${y + 4}" text-anchor="end" font-size="15" fill="#A89F8A">${i * step}</text>`;
    }
    const every = labelEvery || Math.max(1, Math.ceil(n / 7));
    labels.forEach((lab, i) => {
      const x0 = padL + i * cw + cw * 0.11;
      series.forEach((arr, g) => {
        const v = arr[i] || 0, bh = (h - padT - padB) * v / top;
        s += `<rect x="${x0 + g * bw}" y="${h - padB - bh}" width="${bw - 1}" height="${Math.max(v ? 1.5 : 0, bh)}" rx="2" fill="${colors[g]}"><title>${esc(tip ? tip(i) : lab)}: ${v}</title></rect>`;
      });
      if (i % every === 0) s += `<text x="${padL + i * cw + cw / 2}" y="${h - 6}" text-anchor="middle" font-size="15" fill="#A89F8A">${esc(lab)}</text>`;
    });
    return s + '</svg>';
  }
  const GOLD = '#D4AF5A', BLUE = '#6FA8DC', HI = '#F0D78C', OK = '#9EE0A8';

  // ---------- prikaz ----------
  const kpi = (v, label, sub) => `<div class="kpi"><b>${v}</b><span>${esc(label)}</span>${sub ? `<em>${esc(sub)}</em>` : ''}</div>`;
  function render() {
    const p = D.period, t = D.totals, rs = t.rewardStates;
    // upozorenja
    $('alerts').innerHTML = D.alerts.slice(0, 5).map(a => `<div class="alert">⚠ ${esc(a.text)}${a.at ? ` <span class="small">· ${dt(a.at)}</span>` : ''}</div>`).join('');
    $('kPeriod').innerHTML = [
      kpi(num(p.scans), 'skeniranih računa', `${p.scansPerActiveGuest.toFixed(1).replace('.', ',')} po aktivnom gostu`),
      kpi(num(p.activeGuests), 'aktivnih gostiju', `${num(p.returningGuests)} povratnih`),
      kpi(num(p.newGuests), 'novih kartica'),
      kpi(num(p.rewardsRedeemed), 'posluženih nagrada', `${num(p.rewardsClaimed)} uzeto u aplikaciji`),
      kpi(eur(p.amountCents), 'iznos skeniranih računa'),
      kpi(eur(p.avgReceiptCents), 'prosječni račun'),
      kpi(num(p.pointsFromReceipts), 'bodova s računa'),
      kpi(`+${num(p.manualAdded)} / −${num(p.manualRemoved)}`, 'ručni bodovi', `${num(p.manualCount)} promjena`),
    ].join('');
    $('kTotal').innerHTML = [
      kpi(num(t.guests), 'gostiju s karticom', t.guestsStaff ? `od toga ${t.guestsStaff} osoblje` : ''),
      kpi(num(t.scans), 'računa ukupno', eur(t.amountCents)),
      kpi(num(rs['iskorištena']), 'nagrada posluženo', `${pct(t.redemptionRate)} od ${num(t.rewards)} uzetih`),
      kpi(num(rs.aktivna), 'aktivnih kodova', 'čekaju posluživanje'),
      kpi(num(rs.istekla), 'isteklih nagrada'),
      kpi(num(t.pointsOutstanding), 'bodova kod gostiju', `≈ ${(t.pointsOutstanding / D.rules.rewardPoints).toFixed(1).replace('.', ',')} nagrada`),
      kpi(num(t.canClaim), 'mogu odmah uzeti nagradu'),
      kpi(num(t.inactive30), 'neaktivnih 30+ dana', `${num(t.neverScanned)} nikad skeniralo`),
    ].join('');
    const S = D.series, lab = S.days.map(shortDay);
    $('cDaily').innerHTML = bars([S.scans, S.newGuests], lab, { colors: [GOLD, BLUE], tip: i => dd(S.days[i] + 'T12:00:00Z') });
    $('cRewards').innerHTML = bars([S.rewardsClaimed, S.rewardsRedeemed], lab, { h: 150, colors: [HI, OK], tip: i => dd(S.days[i] + 'T12:00:00Z') });
    $('cWeek').innerHTML = bars([D.byWeekday], ['pon', 'uto', 'sri', 'čet', 'pet', 'sub', 'ned'], { h: 160, colors: [GOLD], labelEvery: 1 });
    const hrs = [...Array(24).keys()], first = Math.min(...hrs.filter(h => D.byHour[h]), 7), last = Math.max(...hrs.filter(h => D.byHour[h]), 22);
    const H = hrs.slice(first, last + 1);
    $('cHour').innerHTML = bars([H.map(h => D.byHour[h])], H.map(h => h + 'h'), { h: 160, colors: [GOLD], labelEvery: 2 });
    // lijevak
    const gs = D.guests, rp = D.rules.rewardPoints;
    const f = [
      ['registrirano', gs.length], ['skeniralo barem 1×', gs.filter(g => g.receipts >= 1).length],
      ['vratilo se (2+ računa)', gs.filter(g => g.receipts >= 2).length], [`skupilo ${rp} bodova`, gs.filter(g => g.earned >= rp).length],
      ['uzelo nagradu', gs.filter(g => g.rewards > 0).length], ['iskoristilo nagradu', gs.filter(g => g.redeemed > 0).length],
    ];
    const fmax = Math.max(1, f[0][1]);
    $('funnel').innerHTML = f.map(([l, v]) => `<div class="row"><span>${esc(l)}</span><div style="width:${Math.round(v / fmax * 60)}%"></div><b>${num(v)}</b><span class="small" style="width:auto">${pct(v / fmax)}</span></div>`).join('');
    const r = D.rules;
    $('rules').innerHTML = [
      ['Bodova po računu', r.pointsPerReceipt], ['Bodova za nagradu', r.rewardPoints], ['Nagrada', r.rewardName],
      ['Vrijedi', r.rewardValidDays + ' dana'], ['Računa dnevno po gostu', r.maxReceiptsPerDay], ['Najstariji račun', r.receiptMaxAgeHours + ' h'],
    ].map(([a, b]) => `<div class="item"><div class="a">${esc(a)}</div><div class="p">${esc(b)}</div></div>`).join('');
    renderGuests(); renderRewards(); renderStaff(); renderFeed();
  }

  function renderGuests() {
    const q = $('gSearch').value.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const rp = D.rules.rewardPoints, pp = D.rules.pointsPerReceipt;
    let list = D.guests.filter(g => {
      if (gFilter === 'claim' && g.points < rp) return false;
      if (gFilter === 'near' && !(g.points >= rp - pp * 2 && g.points < rp)) return false;
      if (gFilter === 'inactive' && !(g.receipts && (Date.now() - toDate(g.lastVisit)) > 30 * 86400e3)) return false;
      if (gFilter === 'never' && g.receipts) return false;
      if (gFilter === 'staff' && !g.staff) return false;
      if (!q) return true;
      return (g.name + ' ' + g.phone + ' ' + g.cardNo).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').includes(q);
    });
    const k = gSort.k;
    list = list.slice().sort((a, b) => {
      const va = a[k], vb = b[k];
      if (k === 'name') return gSort.dir * String(va).localeCompare(String(vb), 'hr');
      return gSort.dir * ((va == null ? '' : va) > (vb == null ? '' : vb) ? 1 : (va == null ? '' : va) < (vb == null ? '' : vb) ? -1 : 0);
    });
    $('gCount').textContent = `(${list.length} od ${D.guests.length})`;
    const th = (key, label, n) => `<th class="${n ? 'n' : ''}" data-k="${key}">${label}${gSort.k === key ? (gSort.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`;
    $('gTable').innerHTML = `<thead><tr>${th('cardNo', 'Br.')}${th('name', 'Gost')}${th('points', 'Bodovi', 1)}${th('receipts', 'Računi', 1)}${th('amountCents', 'Iznos', 1)}${th('redeemed', 'Nagrade', 1)}${th('lastVisit', 'Zadnji posjet')}</tr></thead><tbody>` +
      list.slice(0, 500).map(g => `<tr class="click" data-id="${g.id}"><td class="small">${g.cardNo}</td><td><b>${esc(g.name)}</b>${g.staff ? ' <span class="tag">osoblje</span>' : ''}${g.points >= rp ? ' <span class="tag warn">nagrada spremna</span>' : ''}<div class="small">${esc(g.phone)}</div></td>` +
        `<td class="n">${g.points}</td><td class="n">${g.receipts}</td><td class="n">${eur(g.amountCents)}</td><td class="n">${g.redeemed}/${g.rewards}</td><td>${ago(g.lastVisit)}</td></tr>`).join('') +
      (list.length ? '' : '<tr><td colspan="7" class="small">Nema gostiju za ovaj filter.</td></tr>') + '</tbody>';
  }

  function renderRewards() {
    const rs = D.totals.rewardStates;
    $('kRewards').innerHTML = [kpi(num(D.totals.rewards), 'uzeto ukupno'), kpi(num(rs['iskorištena']), 'posluženo', pct(D.totals.redemptionRate)), kpi(num(rs.aktivna), 'aktivno'), kpi(num(rs.istekla), 'isteklo', D.totals.rewards ? pct(rs.istekla / D.totals.rewards) : '')].join('');
    const list = D.rewards.filter(r => rFilter === 'all' || r.state === rFilter);
    const cls = { aktivna: 'warn', 'iskorištena': 'ok', istekla: 'bad' };
    $('rTable').innerHTML = '<thead><tr><th>Kod</th><th>Gost</th><th>Stanje</th><th>Uzeta</th><th>Vrijedi do</th><th>Poslužio/la</th></tr></thead><tbody>' +
      list.map(r => `<tr><td style="white-space:nowrap;font-family:monospace">${esc(r.code)}</td><td>${esc(r.guest)} <span class="small">${r.cardNo}</span></td><td><span class="tag ${cls[r.state]}">${r.state}</span></td><td>${dt(r.createdAt)}</td><td>${dd(r.expiresAt)}</td><td>${r.redeemedBy ? esc(r.redeemedBy) + '<div class="small">' + dt(r.redeemedAt) + '</div>' : '–'}</td></tr>`).join('') +
      (list.length ? '' : '<tr><td colspan="6" class="small">Još nema nagrada.</td></tr>') + '</tbody>';
  }

  function renderStaff() {
    $('sTable').innerHTML = '<thead><tr><th>Osoba</th><th class="n">Poslužene nagrade</th><th class="n">Ručnih promjena</th><th class="n">Dodano bodova</th><th class="n">Oduzeto</th></tr></thead><tbody>' +
      D.staff.map(s => `<tr><td><b>${esc(s.name)}</b></td><td class="n">${s.redeemed}</td><td class="n">${s.adjustments}</td><td class="n">${s.pointsAdded}</td><td class="n">${s.pointsRemoved}</td></tr>`).join('') +
      (D.staff.length ? '' : '<tr><td colspan="5" class="small">U ovom razdoblju nema aktivnosti osoblja.</td></tr>') + '</tbody>';
  }

  function renderFeed() {
    const ic = { gost: '🆕', 'račun': '🧾', 'ručno': '✍', nagrada: '🎁', 'iskorišteno': '☕' };
    $('feed').innerHTML = D.feed.map(f => `<div class="it"><time>${dt(f.at)}</time><div>${ic[f.type] || ''} ${esc(f.text)}</div></div>`).join('') || '<div class="empty">Još nema aktivnosti.</div>';
  }

  async function openGuest(id) {
    $('sheet').innerHTML = '<div class="small">Učitavam…</div>'; $('modal').classList.remove('hidden');
    try {
      const g = await api('/api/admin/guest/' + id);
      $('sheet').innerHTML = `<div class="hd"><div><div class="label">Kartica ${g.cardNo}</div><div style="font-size:20px;font-weight:700">${esc(g.name)}</div><div class="small"><a href="tel:${esc(g.phone)}">${esc(g.phone)}</a> · član od ${dd(g.createdAt)}</div></div><div class="kpi"><b>${g.points}</b><span>bodova</span></div></div>` +
        `<div class="label">Nagrade</div>` + (g.rewards.length ? g.rewards.map(r => `<div class="kv"><span style="font-family:monospace">${esc(r.code)}</span><b>${r.status === 'redeemed' ? 'poslužena ' + dt(r.redeemed_at) + (r.redeemed_by ? ' · ' + esc(r.redeemed_by) : '') : 'vrijedi do ' + dd(r.expires_at)}</b></div>`).join('') : '<div class="empty">Još nije uzeo/la nagradu.</div>') +
        `<div class="label">Povijest bodova</div><div class="list">` + (g.history.length ? g.history.map(h => `<div class="item"><div><div class="a">${h.type === 'račun' ? 'Račun' + (h.amount_cents ? ' ' + eur(h.amount_cents) : '') : 'Ručno – ' + esc(h.staff || '?')}</div><div class="b">${dt(h.at)}${h.note ? ' · ' + esc(h.note) : ''}</div></div><div class="p">${h.points > 0 ? '+' : ''}${h.points}</div></div>`).join('') : '<div class="empty">Nema skeniranih računa.</div>') + '</div>' +
        '<button class="btn ghost" id="mClose" type="button">Zatvori</button>';
      $('mClose').onclick = () => $('modal').classList.add('hidden');
    } catch (e) { $('sheet').innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  }

  async function csv(what) {
    try {
      const res = await fetch(`/api/admin/export/${what}.csv?` + query(), { headers: { 'X-Admin': token || '' } });
      if (!res.ok) throw new Error('Izvoz nije uspio.');
      const url = URL.createObjectURL(await res.blob()), a = document.createElement('a');
      a.href = url; a.download = `nomad-${what}-${D ? D.today : 'izvoz'}.csv`; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) { $('mErr').textContent = e.message; }
  }

  // ---------- događaji ----------
  $('fAdmin').addEventListener('submit', async ev => {
    ev.preventDefault(); $('aErr').textContent = '';
    try { const r = await api('/api/admin/login', { pin: $('aPin').value }); token = r.token; try { sessionStorage.setItem('nomadAdmin', token); } catch {} $('aPin').value = ''; enter(); }
    catch (e) { $('aErr').textContent = e.message; }
  });
  $('btnOut').onclick = logout;
  document.querySelector('.tabs').addEventListener('click', e => {
    const b = e.target.closest('button[data-tab]'); if (!b) return;
    document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('on', x === b));
    document.querySelectorAll('[data-pane]').forEach(p => p.classList.toggle('hidden', p.dataset.pane !== b.dataset.tab));
  });
  $('period').addEventListener('click', e => {
    const b = e.target.closest('button[data-d]'); if (!b) return;
    $('period').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    range = { d: b.dataset.d }; load();
  });
  const onDate = () => { if (!$('pOd').value || !$('pDo').value) return; $('period').querySelectorAll('button').forEach(x => x.classList.remove('on')); range = { d: 'custom', od: $('pOd').value, do: $('pDo').value }; load(); };
  $('pOd').addEventListener('change', onDate); $('pDo').addEventListener('change', onDate);
  $('gSearch').addEventListener('input', () => D && renderGuests());
  $('gFilter').addEventListener('click', e => { const b = e.target.closest('button[data-f]'); if (!b) return; gFilter = b.dataset.f; $('gFilter').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); renderGuests(); });
  $('rFilter').addEventListener('click', e => { const b = e.target.closest('button[data-f]'); if (!b) return; rFilter = b.dataset.f; $('rFilter').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); renderRewards(); });
  $('gTable').addEventListener('click', e => {
    const th = e.target.closest('th[data-k]');
    if (th) { const k = th.dataset.k; gSort = { k, dir: gSort.k === k ? -gSort.dir : (k === 'name' || k === 'cardNo' ? 1 : -1) }; return renderGuests(); }
    const tr = e.target.closest('tr[data-id]'); if (tr) openGuest(tr.dataset.id);
  });
  $('modal').addEventListener('click', e => { if (e.target === $('modal')) $('modal').classList.add('hidden'); });
  document.querySelectorAll('[data-csv]').forEach(b => b.onclick = () => csv(b.dataset.csv));
  setInterval(() => { if (token && !document.hidden && !$('aMain').classList.contains('hidden')) load(); }, 120e3);
  if (token) enter();
})();
