'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nomad-admin-'));
process.env.DB_FILE = path.join(dir, 'nomad.db');
process.env.INVENTURA_DB_FILE = path.join(dir, 'inv.db');
process.env.ADMIN_PIN = '9876';
const { app } = require('../server');
const Database = require('better-sqlite3');

let base, server;
test.before(async () => {
  const db = new Database(process.env.DB_FILE);
  const ins = db.prepare('INSERT INTO users (name, phone, pin_hash, token, points, created_at) VALUES (?,?,?,?,?,?)');
  ins.run('Ana Anić', '+385911111111', 'x:y', 't1', 50, '2026-10-15 08:00:00');
  ins.run('Marina Markova', '+385922222222', 'x:y', 't2', 10, '2026-10-16 09:00:00');
  ins.run('Ivo Ivić', '+385933333333', 'x:y', 't3', 0, '2026-10-16 10:00:00');
  const r = db.prepare('INSERT INTO receipts (receipt_key, user_id, receipt_time, amount_cents, points, zg_day, created_at) VALUES (?,?,?,?,?,?,?)');
  r.run('jir:a1', 1, null, 400, 10, '2026-10-15', '2026-10-15 08:05:00');
  r.run('jir:a2', 1, null, 600, 10, '2026-10-16', '2026-10-16 17:30:00');
  r.run('jir:m1', 2, null, 250, 10, '2026-10-16', '2026-10-16 22:30:00'); // 00:30 u Zagrebu, 17.10.
  db.prepare('INSERT INTO adjustments (user_id, points, note, staff, created_at) VALUES (?,?,?,?,?)').run(1, 40, 'stari računi', 'Matija Kuzmić', '2026-10-17 10:00:00');
  db.prepare(`INSERT INTO rewards (code, user_id, name, status, expires_at, redeemed_at, redeemed_by, created_at) VALUES
    ('NMD-AAAA-AAAA', 1, 'Kava', 'redeemed', '2026-11-17 10:00:00', '2026-10-18 09:00:00', 'Marina Markova', '2026-10-17 11:00:00'),
    ('NMD-BBBB-BBBB', 1, 'Kava', 'active', '2026-01-01 00:00:00', NULL, NULL, '2025-12-01 10:00:00')`).run();
  db.close();
  server = app.listen(0); await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());

async function login(pin) {
  const r = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }) });
  return (await r.json()).token;
}

test('vlasnik vidi dashboard s točnim brojkama', async () => {
  const t = await login('9876');
  const d = await (await fetch(base + '/api/admin/dashboard?od=2026-10-14&do=2026-10-20', { headers: { 'X-Admin': t } })).json();
  assert.equal(d.totals.guests, 3);
  assert.equal(d.totals.guestsStaff, 1);
  assert.equal(d.period.scans, 3);
  assert.equal(d.period.newGuests, 3);
  assert.equal(d.period.activeGuests, 2);
  assert.equal(d.period.returningGuests, 1);
  assert.equal(d.period.amountCents, 1250);
  assert.equal(d.period.manualAdded, 40);
  assert.equal(d.period.rewardsRedeemed, 1);
  assert.equal(d.totals.rewardStates['iskorištena'], 1);
  assert.equal(d.totals.rewardStates.istekla, 1);
  assert.equal(d.totals.canClaim, 1);
  // ponoćni račun pada na 17.10. po zagrebačkom vremenu
  assert.equal(d.series.scans[d.series.days.indexOf('2026-10-17')], 1);
  assert.equal(d.byHour[0], 1);
  assert.equal(d.staff.find(s => s.name === 'Marina Markova').redeemed, 1);
  assert.ok(d.alerts.length === 0 || Array.isArray(d.alerts));
  assert.equal(d.guests[0].name, 'Ana Anić');
});

test('detalji gosta i CSV izvoz', async () => {
  const t = await login('9876');
  const g = await (await fetch(base + '/api/admin/guest/1', { headers: { 'X-Admin': t } })).json();
  assert.equal(g.history.length, 3);
  assert.equal(g.rewards.length, 2);
  const csv = await (await fetch(base + '/api/admin/export/gosti.csv', { headers: { 'X-Admin': t } })).text();
  assert.match(csv, /Ana Anić/);
  const all = await (await fetch(base + '/api/admin/dashboard?od=sve', { headers: { 'X-Admin': t } })).json();
  assert.equal(all.from, '2026-10-15');
  assert.ok(all.series.days.length >= 1);
});

test('osoblje (ne vlasnik) nema pristup', async () => {
  const t = await login('0000');
  const r = await fetch(base + '/api/admin/dashboard', { headers: { 'X-Admin': t } });
  assert.equal(r.status, 403);
  const r2 = await fetch(base + '/api/admin/dashboard');
  assert.equal(r2.status, 401);
});
