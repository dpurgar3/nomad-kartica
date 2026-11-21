// NOMAd kartica vjernosti – vlasnički admin panel (samo ADMIN_PIN)
'use strict';

const TZ = 'Europe/Zagreb';
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const partsFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', weekday: 'short', hour: '2-digit' });
const WD = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

// SQLite datetime('now') je UTC "YYYY-MM-DD HH:MM:SS"; ISO s Z također prolazi
function toDate(s) {
  if (!s) return null;
  const str = String(s);
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(str) ? str : str.replace(' ', 'T') + 'Z');
  return isNaN(d) ? null : d;
}
function zgDay(d) { return dayFmt.format(d); }
function zgParts(d) {
  const p = Object.fromEntries(partsFmt.formatToParts(d).map(x => [x.type, x.value]));
  return { wd: WD[p.weekday], hour: parseInt(p.hour, 10) };
}
function addDays(day, n) {
  const d = new Date(day + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function daysBetween(a, b) { return Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 86400e3); }
function cardNo(id) { return String(id).padStart(6, '0'); }
function normName(n) { return String(n || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase().replace(/\s+/g, ' ').trim(); }
function csvCell(v) { const s = v == null ? '' : String(v); return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }

// Sve brojke se računaju u JS-u iz sirovih redaka (mala baza), da dani/sati budu točni po zagrebačkom vremenu.
function loadAll(db) {
  const users = db.prepare('SELECT id, name, phone, points, created_at FROM users').all();
  const receipts = db.prepare('SELECT id, user_id, receipt_time, amount_cents, points, created_at FROM receipts').all();
  const adjustments = db.prepare('SELECT id, user_id, points, note, staff, created_at FROM adjustments').all();
  const rewards = db.prepare('SELECT id, code, user_id, name, status, expires_at, redeemed_at, redeemed_by, created_at FROM rewards').all();
  for (const r of [...users, ...receipts, ...adjustments, ...rewards]) r._at = toDate(r.created_at);
  for (const r of rewards) { r._exp = toDate(r.expires_at); r._red = toDate(r.redeemed_at); }
  return { users, receipts, adjustments, rewards };
}

function rewardState(r, now) {
  if (r.status === 'redeemed') return 'iskorištena';
  if (r._exp && r._exp <= now) return 'istekla';
  return 'aktivna';
}

function buildDashboard(db, cfg, staffNames, q) {
  const now = new Date();
  const today = zgDay(now);
  const { users, receipts, adjustments, rewards } = loadAll(db);
  let from = /^\d{4}-\d{2}-\d{2}$/.test(q.od || '') ? q.od : addDays(today, -29);
  let to = /^\d{4}-\d{2}-\d{2}$/.test(q.do || '') ? q.do : today;
  if (q.od === 'sve') {
    const first = [...users, ...receipts].map(r => r._at).filter(Boolean).sort((a, b) => a - b)[0];
    from = first ? zgDay(first) : today; to = today;
  }
  if (from > to) [from, to] = [to, from];
  if (daysBetween(from, to) > 730) from = addDays(to, -730);
  const inRange = d => { if (!d) return false; const k = zgDay(d); return k >= from && k <= to; };
  const staffSet = new Set(staffNames.map(normName));
  const isStaff = u => staffSet.has(normName(u.name));
  const userById = new Map(users.map(u => [u.id, u]));

  // --- po gostu ---
  const per = new Map(users.map(u => [u.id, { receipts: 0, amount: 0, lastVisit: null, firstVisit: null, rewards: 0, redeemed: 0, earned: 0 }]));
  for (const r of receipts) {
    const p = per.get(r.user_id); if (!p) continue;
    p.receipts++; p.earned += r.points; if (r.amount_cents) p.amount += r.amount_cents;
    if (!p.lastVisit || r._at > p.lastVisit) p.lastVisit = r._at;
    if (!p.firstVisit || r._at < p.firstVisit) p.firstVisit = r._at;
  }
  for (const a of adjustments) { const p = per.get(a.user_id); if (p && a.points > 0) p.earned += a.points; }
  for (const r of rewards) { const p = per.get(r.user_id); if (!p) continue; p.rewards++; if (r.status === 'redeemed') p.redeemed++; }

  // --- razdoblje ---
  const R = receipts.filter(r => inRange(r._at));
  const A = adjustments.filter(a => inRange(a._at));
  const RW = rewards.filter(r => inRange(r._at));
  const RD = rewards.filter(r => r.status === 'redeemed' && inRange(r._red));
  const NU = users.filter(u => inRange(u._at));
  const activeIds = new Set(R.map(r => r.user_id));
  const amounts = R.map(r => r.amount_cents).filter(x => x != null && x > 0);
  const amountSum = amounts.reduce((s, x) => s + x, 0);

  // povratni gosti u razdoblju: imaju barem 2 računa ukupno do kraja razdoblja i barem 1 u razdoblju
  const returning = [...activeIds].filter(id => receipts.filter(r => r.user_id === id && zgDay(r._at) <= to).length >= 2).length;

  const rewardStates = { aktivna: 0, iskorištena: 0, istekla: 0 };
  for (const r of rewards) rewardStates[rewardState(r, now)]++;

  const totalPointsOut = users.reduce((s, u) => s + u.points, 0);
  const nearReward = users.filter(u => u.points >= cfg.rewardPoints - cfg.pointsPerReceipt && u.points < cfg.rewardPoints).length;
  const canClaim = users.filter(u => u.points >= cfg.rewardPoints).length;
  const inactive30 = users.filter(u => { const p = per.get(u.id); return p.receipts > 0 && daysBetween(zgDay(p.lastVisit), today) > 30; }).length;
  const neverScanned = users.filter(u => per.get(u.id).receipts === 0).length;

  // --- dnevni niz ---
  const days = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  const idx = new Map(days.map((d, i) => [d, i]));
  const series = { days, scans: days.map(() => 0), newGuests: days.map(() => 0), rewardsClaimed: days.map(() => 0), rewardsRedeemed: days.map(() => 0), amount: days.map(() => 0) };
  for (const r of R) { const i = idx.get(zgDay(r._at)); series.scans[i]++; series.amount[i] += r.amount_cents || 0; }
  for (const u of NU) series.newGuests[idx.get(zgDay(u._at))]++;
  for (const r of RW) series.rewardsClaimed[idx.get(zgDay(r._at))]++;
  for (const r of RD) series.rewardsRedeemed[idx.get(zgDay(r._red))]++;

  // --- dan u tjednu / sat (po vremenu skeniranja) ---
  const byWeekday = Array(7).fill(0), byHour = Array(24).fill(0);
  for (const r of R) { const p = zgParts(r._at); byWeekday[p.wd]++; byHour[p.hour]++; }

  // --- osoblje ---
  const staffMap = new Map();
  const st = n => { const k = n || 'nepoznato'; if (!staffMap.has(k)) staffMap.set(k, { name: k, redeemed: 0, adjustments: 0, pointsAdded: 0, pointsRemoved: 0 }); return staffMap.get(k); };
  for (const r of RD) st(r.redeemed_by).redeemed++;
  for (const a of A) { const s = st(a.staff); s.adjustments++; if (a.points > 0) s.pointsAdded += a.points; else s.pointsRemoved += -a.points; }

  // --- upozorenja (moguće zloupotrebe) ---
  const alerts = [];
  for (const a of A) {
    const u = userById.get(a.user_id);
    if (u && isStaff(u)) alerts.push({ at: a.created_at, text: `${a.staff || '?'} je dao/la ${a.points} bodova kartici osoblja (${u.name}).` });
    if (Math.abs(a.points) >= 50) alerts.push({ at: a.created_at, text: `Velika ručna promjena: ${a.points > 0 ? '+' : ''}${a.points} bodova za ${u ? u.name : '?'} (${a.staff || '?'}).` });
  }
  for (const r of RD) { const u = userById.get(r.user_id); if (u && isStaff(u) && r.redeemed_by !== 'Dražen') alerts.push({ at: r.redeemed_at, text: `Nagradu člana osoblja (${u.name}) potvrdio/la ${r.redeemed_by || '?'}.` }); }
  const manualShare = (A.filter(a => a.points > 0).length) / Math.max(1, R.length + A.filter(a => a.points > 0).length);
  if (A.length >= 5 && manualShare > 0.3) alerts.push({ at: null, text: `Ručnih dodavanja bodova je ${Math.round(manualShare * 100)} % od svih dodavanja – provjeri zašto računi nisu skenirani.` });
  alerts.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));

  // --- popis gostiju ---
  const guests = users.map(u => {
    const p = per.get(u.id);
    return {
      id: u.id, cardNo: cardNo(u.id), name: u.name, phone: u.phone, points: u.points, staff: isStaff(u),
      createdAt: u.created_at, receipts: p.receipts, amountCents: p.amount, earned: p.earned,
      lastVisit: p.lastVisit ? p.lastVisit.toISOString() : null, rewards: p.rewards, redeemed: p.redeemed,
    };
  }).sort((a, b) => b.receipts - a.receipts || b.points - a.points || a.id - b.id);

  // --- nagrade ---
  const rewardList = rewards.slice().sort((a, b) => b.id - a.id).slice(0, 300).map(r => {
    const u = userById.get(r.user_id);
    return { code: r.code, guest: u ? u.name : '?', cardNo: cardNo(r.user_id), name: r.name, state: rewardState(r, now),
      createdAt: r.created_at, expiresAt: r.expires_at, redeemedAt: r.redeemed_at, redeemedBy: r.redeemed_by };
  });

  // --- zadnje aktivnosti ---
  const feed = [];
  const nm = id => (userById.get(id) || {}).name || '?';
  for (const u of users) feed.push({ at: u._at, type: 'gost', text: `Nova kartica: ${u.name} (${cardNo(u.id)})` });
  for (const r of receipts) feed.push({ at: r._at, type: 'račun', text: `${nm(r.user_id)} skenirao/la račun${r.amount_cents ? ' ' + (r.amount_cents / 100).toFixed(2).replace('.', ',') + ' €' : ''} · +${r.points}` });
  for (const a of adjustments) feed.push({ at: a._at, type: 'ručno', text: `${a.staff || '?'}: ${a.points > 0 ? '+' : ''}${a.points} bodova za ${nm(a.user_id)}${a.note ? ' – ' + a.note : ''}` });
  for (const r of rewards) {
    feed.push({ at: r._at, type: 'nagrada', text: `${nm(r.user_id)} je uzeo/la nagradu (${r.code})` });
    if (r._red) feed.push({ at: r._red, type: 'iskorišteno', text: `${r.redeemed_by || '?'} je poslužio/la nagradu ${r.code} – ${nm(r.user_id)}` });
  }
  feed.sort((a, b) => b.at - a.at);

  return {
    generated: now.toISOString(), from, to, today,
    rules: { pointsPerReceipt: cfg.pointsPerReceipt, rewardPoints: cfg.rewardPoints, rewardName: cfg.rewardName,
      rewardValidDays: cfg.rewardValidDays, maxReceiptsPerDay: cfg.maxReceiptsPerDay, receiptMaxAgeMinutes: cfg.receiptMaxAgeMinutes },
    totals: {
      guests: users.length, guestsStaff: users.filter(isStaff).length, scans: receipts.length, rewards: rewards.length,
      rewardStates, pointsOutstanding: totalPointsOut, canClaim, nearReward, inactive30, neverScanned,
      redemptionRate: rewards.length ? rewardStates['iskorištena'] / rewards.length : 0,
      amountCents: receipts.reduce((s, r) => s + (r.amount_cents || 0), 0),
    },
    period: {
      newGuests: NU.length, activeGuests: activeIds.size, returningGuests: returning, scans: R.length,
      pointsFromReceipts: R.reduce((s, r) => s + r.points, 0),
      manualAdded: A.filter(a => a.points > 0).reduce((s, a) => s + a.points, 0),
      manualRemoved: -A.filter(a => a.points < 0).reduce((s, a) => s + a.points, 0),
      manualCount: A.length, rewardsClaimed: RW.length, rewardsRedeemed: RD.length,
      amountCents: amountSum, avgReceiptCents: amounts.length ? Math.round(amountSum / amounts.length) : null,
      scansPerActiveGuest: activeIds.size ? R.length / activeIds.size : 0,
    },
    series, byWeekday, byHour,
    staff: [...staffMap.values()].sort((a, b) => b.redeemed - a.redeemed || b.adjustments - a.adjustments),
    alerts: alerts.slice(0, 30),
    guests, rewards: rewardList,
    feed: feed.slice(0, 60).map(f => ({ at: f.at ? f.at.toISOString() : null, type: f.type, text: f.text })),
  };
}

function guestDetail(db, id) {
  const u = db.prepare('SELECT id, name, phone, points, created_at FROM users WHERE id=?').get(id);
  if (!u) return null;
  const rows = db.prepare(`
    SELECT 'račun' AS type, points, created_at AS at, amount_cents, NULL AS note, NULL AS staff FROM receipts WHERE user_id=?
    UNION ALL SELECT 'ručno', points, created_at, NULL, note, staff FROM adjustments WHERE user_id=?
    ORDER BY at DESC LIMIT 200`).all(id, id);
  const rewards = db.prepare('SELECT code, name, status, expires_at, redeemed_at, redeemed_by, created_at FROM rewards WHERE user_id=? ORDER BY id DESC').all(id);
  return { cardNo: cardNo(u.id), name: u.name, phone: u.phone, points: u.points, createdAt: u.created_at, history: rows, rewards };
}

function mount(app, { db, cfg, adminAuth, staffNames }) {
  const owner = (req, res, next) => (req.staff && req.staff.owner ? next() : res.status(403).json({ error: 'Admin panel je samo za vlasnika.' }));
  app.get(['/a', '/A'], (req, res) => res.redirect(302, '/admin'));
  app.get('/api/admin/dashboard', adminAuth, owner, (req, res) => res.json(buildDashboard(db, cfg, staffNames, req.query)));
  app.get('/api/admin/guest/:id', adminAuth, owner, (req, res) => {
    const g = guestDetail(db, parseInt(req.params.id, 10) || 0);
    if (!g) return res.status(404).json({ error: 'Gost nije pronađen.' });
    res.json(g);
  });
  app.get('/api/admin/export/:what.csv', adminAuth, owner, (req, res) => {
    const d = buildDashboard(db, cfg, staffNames, req.query);
    let head, rows;
    if (req.params.what === 'gosti') {
      head = ['Kartica', 'Ime', 'Mobitel', 'Bodovi', 'Računa', 'Iznos računa (€)', 'Nagrada', 'Iskorišteno', 'Zadnji posjet', 'Registriran', 'Osoblje'];
      rows = d.guests.map(g => [g.cardNo, g.name, g.phone, g.points, g.receipts, (g.amountCents / 100).toFixed(2).replace('.', ','), g.rewards, g.redeemed,
        g.lastVisit ? zgDay(new Date(g.lastVisit)) : '', g.createdAt ? zgDay(toDate(g.createdAt)) : '', g.staff ? 'da' : '']);
    } else if (req.params.what === 'nagrade') {
      head = ['Kod', 'Gost', 'Kartica', 'Nagrada', 'Stanje', 'Uzeta', 'Vrijedi do', 'Iskorištena', 'Poslužio/la'];
      rows = d.rewards.map(r => [r.code, r.guest, r.cardNo, r.name, r.state, r.createdAt, r.expiresAt, r.redeemedAt || '', r.redeemedBy || '']);
    } else return res.status(404).end();
    const body = '﻿' + [head, ...rows].map(r => r.map(csvCell).join(';')).join('\r\n');
    res.set('Content-Disposition', `attachment; filename="nomad-${req.params.what}-${d.today}.csv"`);
    res.type('text/csv; charset=utf-8').send(body);
  });
}

module.exports = { mount, buildDashboard, guestDetail };
