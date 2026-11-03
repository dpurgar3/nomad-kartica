// NOMAd kartica vjernosti – server (Node.js + Express + SQLite)
'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const Database = require('better-sqlite3');
const QRCode = require('qrcode');
const { checkOibPhoto } = require('./receipt-check');

// ---------- Postavke (.env) ----------
loadEnv(path.join(__dirname, '.env'));
const CFG = {
  port: int(process.env.PORT, 3000),
  dbFile: process.env.DB_FILE || path.join(__dirname, 'data', 'nomad.db'),
  adminPin: process.env.ADMIN_PIN || '',
  // Dodatni članovi osoblja (vlasnik se prijavljuje s ADMIN_PIN). Povezuju se s gostom po imenu.
  staff: [
    { name: 'Marina Markova', pin: '0000' },
    { name: 'Matija Kuzmić', pin: '1111' },
  ],
  wifiSsid: process.env.WIFI_SSID || 'ASUS - NOMAd',
  wifiPassword: process.env.WIFI_PASSWORD || '',
  pointsPerReceipt: int(process.env.POINTS_PER_RECEIPT, 10),
  rewardPoints: int(process.env.REWARD_POINTS, 50),
  rewardName: process.env.REWARD_NAME || 'Velika kava s mlijekom + kroasan',
  rewardValidDays: int(process.env.REWARD_VALID_DAYS, 30),
  maxReceiptsPerDay: int(process.env.MAX_RECEIPTS_PER_DAY, 1),
  receiptMaxAgeHours: int(process.env.RECEIPT_MAX_AGE_HOURS, 48),
  minReceiptCents: int(process.env.MIN_RECEIPT_CENTS, 0),
  address: process.env.ADDRESS || 'Kulturni centar Ivan Rabuzin, Novi Marof',
  // OIB izdavatelja: bodove donose samo računi na kojima je otisnut ovaj OIB (Ugostiteljski obrt Artist)
  oib: (process.env.NOMAD_OIB || '53253782263').replace(/\D/g, ''),
};
if ((!CFG.adminPin || CFG.adminPin.length < 4) && !CFG.staff.length) {
  console.warn('UPOZORENJE: ADMIN_PIN nije postavljen (min. 4 znamenke) – ekran za osoblje je isključen.');
}

// ---------- Baza ----------
fs.mkdirSync(path.dirname(CFG.dbFile), { recursive: true });
const db = new Database(CFG.dbFile);
db.pragma('journal_mode = WAL');
db.exec(`CREATE TABLE IF NOT EXISTS obavijesti (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tekst TEXT NOT NULL,
  vrijedi_do TEXT,
  autor TEXT,
  created_at TEXT DEFAULT (datetime('now'))
)`);
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  pin_hash TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  points INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_key TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  receipt_time TEXT,
  amount_cents INTEGER,
  points INTEGER NOT NULL,
  zg_day TEXT NOT NULL,
  raw TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS adjustments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  points INTEGER NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS rewards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  expires_at TEXT NOT NULL,
  redeemed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_receipts_user_day ON receipts(user_id, zg_day);
`);
// tko je potvrdio nagradu / dodao bodove
for (const sql of ['ALTER TABLE rewards ADD COLUMN redeemed_by TEXT', 'ALTER TABLE adjustments ADD COLUMN staff TEXT']) {
  try { db.exec(sql); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
}

// ---------- Pomoćne ----------
function int(v, d) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; }
function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
function zgDay(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zagreb', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
function zgOffsetMin(date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Zagreb', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(date).map(x => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  return Math.round((asUtc - Math.floor(date.getTime() / 60000) * 60000) / 60000);
}
function zagrebLocalToDate(y, mo, d, h, mi) {
  const guess = new Date(Date.UTC(y, mo - 1, d, h, mi));
  return new Date(guess.getTime() - zgOffsetMin(guess) * 60000);
}
function hashPin(pin, salt = crypto.randomBytes(16).toString('hex')) {
  return salt + ':' + crypto.scryptSync(String(pin), salt, 32).toString('hex');
}
function checkPin(pin, stored) {
  const [salt, h] = stored.split(':');
  const a = Buffer.from(h, 'hex'), b = crypto.scryptSync(String(pin), salt, 32);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function normPhone(p) {
  let s = String(p || '').replace(/[^\d+]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  if (s.startsWith('0')) s = '+385' + s.slice(1);
  return s;
}
function cardNo(id) { return String(id).padStart(6, '0'); }
function rewardCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const pick = n => Array.from(crypto.randomBytes(n), b => A[b % A.length]).join('');
  return `NMD-${pick(4)}-${pick(4)}`;
}

// Fiskalni račun (HR): QR kod sadrži poveznicu za provjeru računa u Poreznoj upravi,
// npr. https://porezna.gov.hr/rn?jir=…&datv=20261008_1842&izn=400 (ili zki= umjesto jir=).
function parseReceipt(text) {
  const raw = String(text || '').trim().slice(0, 500);
  let url;
  try { url = new URL(raw); } catch { return { error: 'Ovo nije kod s fiskalnog računa. Skeniraj QR kod na dnu računa.' }; }
  if (!/porezna/i.test(url.hostname)) return { error: 'Ovo nije kod s fiskalnog računa. Skeniraj QR kod na dnu računa.' };
  const jir = (url.searchParams.get('jir') || '').trim().toLowerCase();
  const zki = (url.searchParams.get('zki') || '').trim().toLowerCase();
  const key = jir ? 'jir:' + jir : zki ? 'zki:' + zki : '';
  if (!key || (jir || zki).length < 20) return { error: 'Kod s računa nije potpun. Pokušaj ponovno.' };
  const m = (url.searchParams.get('datv') || '').match(/^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})$/);
  if (!m) return { error: 'Na kodu nema datuma računa. Pokušaj ponovno.' };
  const when = zagrebLocalToDate(+m[1], +m[2], +m[3], +m[4], +m[5]);
  const izn = url.searchParams.get('izn');
  const amountCents = izn != null && /^\d+$/.test(izn) ? parseInt(izn, 10) : null;
  return { key, when, amountCents, raw };
}

// Jednostavno ograničavanje broja zahtjeva
const hits = new Map();
function limit(name, max, windowMs) {
  return (req, res, next) => {
    const k = name + ':' + req.ip, now = Date.now();
    const arr = (hits.get(k) || []).filter(t => now - t < windowMs);
    arr.push(now); hits.set(k, arr);
    if (arr.length > max) return res.status(429).json({ error: 'Previše pokušaja. Pričekaj malo pa pokušaj ponovno.' });
    next();
  };
}
setInterval(() => { const now = Date.now(); for (const [k, a] of hits) if (!a.some(t => now - t < 3600e3)) hits.delete(k); }, 600e3).unref();

// ---------- Aplikacija ----------
const app = express();
app.set('trust proxy', 1);
const smallJson = express.json({ limit: '10kb' });
app.use((req, res, next) => (req.path === '/api/scan' || req.path.startsWith('/inventura') || req.path.startsWith('/agent') ? next() : smallJson(req, res, next)));
// ---------- Inventura (zasebna baza data/inventura.db) ----------
const inventura = require('./inventura/routes').createInventura({
  dbFile: process.env.INVENTURA_DB_FILE || path.join(path.dirname(CFG.dbFile), 'inventura.db'),
  envPin: process.env.INVENTURA_PIN || '',
  adminPin: CFG.adminPin,
});
app.use('/inventura', inventura.router);
// ---------- Agent NOMAd (AI chat za web nomadinfo.space) – čita i normative iz inventure ----------
require('./agent/agent').mount(app, { inventuraDb: inventura.db, obavijesti: aktivneObavijesti });
app.get(['/i', '/I'], (req, res) => res.redirect(302, '/inventura/')); // kratki link za mobitel
app.get(['/o', '/O'], (req, res) => res.redirect(302, '/osoblje#obavijesti')); // obavijesti za web
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.use('/vendor/html5-qrcode.min.js', (req, res) =>
  res.sendFile(path.join(__dirname, 'node_modules', 'html5-qrcode', 'html5-qrcode.min.js')));
app.use('/vendor/jsQR.js', (req, res) =>
  res.sendFile(path.join(__dirname, 'node_modules', 'jsqr', 'dist', 'jsQR.js')));

function auth(req, res, next) {
  const t = req.get('X-Token');
  const u = t && db.prepare('SELECT * FROM users WHERE token = ?').get(t);
  if (!u) return res.status(401).json({ error: 'Prijavi se ponovno.' });
  req.user = u; next();
}
function meView(u) {
  const recent = db.prepare(`SELECT 'račun' AS kind, points, created_at AS at, amount_cents FROM receipts WHERE user_id=?
    UNION ALL SELECT 'osoblje' AS kind, points, created_at AS at, NULL FROM adjustments WHERE user_id=?
    ORDER BY at DESC LIMIT 5`).all(u.id, u.id);
  const rewards = db.prepare(`SELECT code, name, expires_at FROM rewards WHERE user_id=? AND status='active' AND expires_at > datetime('now') ORDER BY id`).all(u.id);
  return { name: u.name, cardNo: cardNo(u.id), points: u.points, recent, rewards };
}

app.get('/api/config', (req, res) => res.json({
  wifiSsid: CFG.wifiSsid, wifiPassword: CFG.wifiPassword, pointsPerReceipt: CFG.pointsPerReceipt,
  rewardPoints: CFG.rewardPoints, rewardName: CFG.rewardName, rewardValidDays: CFG.rewardValidDays,
  maxReceiptsPerDay: CFG.maxReceiptsPerDay, address: CFG.address,
}));

app.post('/api/register', limit('reg', 5, 3600e3), (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 40);
  const phone = normPhone(req.body.phone);
  const pin = String(req.body.pin || '');
  if (name.length < 2) return res.status(400).json({ error: 'Upiši ime.' });
  if (!/^\+\d{8,15}$/.test(phone)) return res.status(400).json({ error: 'Upiši ispravan broj mobitela.' });
  if (!/^\d{4}$/.test(pin)) return res.status(400).json({ error: 'PIN mora imati 4 znamenke.' });
  if (req.body.consent !== true) return res.status(400).json({ error: 'Za karticu je potrebna privola.' });
  if (db.prepare('SELECT 1 FROM users WHERE phone=?').get(phone))
    return res.status(409).json({ error: 'Taj broj već ima karticu. Prijavi se s PIN-om.' });
  const token = crypto.randomBytes(32).toString('hex');
  const info = db.prepare('INSERT INTO users (name, phone, pin_hash, token) VALUES (?,?,?,?)').run(name, phone, hashPin(pin), token);
  res.json({ token, me: meView(db.prepare('SELECT * FROM users WHERE id=?').get(info.lastInsertRowid)) });
});

app.post('/api/login', limit('login', 8, 900e3), (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE phone=?').get(normPhone(req.body.phone));
  if (!u || !checkPin(req.body.pin || '', u.pin_hash)) return res.status(401).json({ error: 'Broj mobitela ili PIN nisu točni.' });
  res.json({ token: u.token, me: meView(u) });
});

app.get('/api/me', auth, (req, res) => res.json(meView(req.user)));

// Gost fotografira cijeli račun. Mobitel pročita QR kod i šalje ga sa smanjenom fotografijom;
// server provjeri pravila računa, a zatim na fotografiji pročita OIB izdavatelja (računi iz drugih trgovina se odbijaju).
app.post('/api/scan', express.json({ limit: '6mb' }), auth, limit('scan', 20, 3600e3), async (req, res) => {
  const m = String(req.body.image || '').match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!m || !req.body.qr) return res.status(400).json({ error: 'Fotografiraj račun i pokušaj ponovno.' });
  const r = parseReceipt(req.body.qr);
  if (r.error) return res.status(400).json({ error: r.error });
  const now = Date.now();
  // prvo OIB (je li račun iz NOMAd-a), zatim ostala pravila (već iskorišten, 1 dnevno)
  if (now - r.when.getTime() <= CFG.receiptMaxAgeHours * 3600e3 && r.when.getTime() <= now + 3600e3) {
    const oib = await checkOibPhoto(Buffer.from(m[2], 'base64'), CFG.oib);
    if (oib.error) return res.status(400).json({ error: oib.error, code: oib.code });
  }
  if (r.when.getTime() > now + 3600e3) return res.status(400).json({ error: 'Datum na računu nije ispravan.' });
  if (now - r.when.getTime() > CFG.receiptMaxAgeHours * 3600e3)
    return res.status(400).json({ error: `Račun je stariji od ${CFG.receiptMaxAgeHours} sati. Skeniraj račun odmah nakon plaćanja.` });
  if (CFG.minReceiptCents && r.amountCents != null && r.amountCents < CFG.minReceiptCents)
    return res.status(400).json({ error: `Za bodove račun mora biti barem ${(CFG.minReceiptCents / 100).toFixed(2).replace('.', ',')} €.` });
  if (db.prepare('SELECT 1 FROM receipts WHERE receipt_key=?').get(r.key))
    return res.status(409).json({ error: 'Ovaj račun je već iskorišten.' });
  const day = zgDay();
  const today = db.prepare('SELECT COUNT(*) AS n FROM receipts WHERE user_id=? AND zg_day=?').get(req.user.id, day).n;
  if (today >= CFG.maxReceiptsPerDay)
    return res.status(429).json({ error: CFG.maxReceiptsPerDay === 1 ? 'Danas si već skenirao račun. Vidimo se sutra!' : 'Dosegnut je dnevni broj računa.' });
  const tx = db.transaction(() => {
    db.prepare('INSERT INTO receipts (receipt_key, user_id, receipt_time, amount_cents, points, zg_day, raw) VALUES (?,?,?,?,?,?,?)')
      .run(r.key, req.user.id, r.when.toISOString(), r.amountCents, CFG.pointsPerReceipt, day, r.raw);
    db.prepare('UPDATE users SET points = points + ? WHERE id=?').run(CFG.pointsPerReceipt, req.user.id);
  });
  try { tx(); } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'Ovaj račun je već iskorišten.' });
    throw e;
  }
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  res.json({ added: CFG.pointsPerReceipt, amountCents: r.amountCents, me: meView(u) });
});

app.post('/api/reward', auth, (req, res) => {
  const tx = db.transaction(() => {
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
    if (u.points < CFG.rewardPoints) return null;
    db.prepare('UPDATE users SET points = points - ? WHERE id=?').run(CFG.rewardPoints, u.id);
    const code = rewardCode();
    db.prepare(`INSERT INTO rewards (code, user_id, name, expires_at) VALUES (?,?,?, datetime('now', ?))`)
      .run(code, u.id, CFG.rewardName, `+${CFG.rewardValidDays} days`);
    return code;
  });
  const code = tx();
  if (!code) return res.status(400).json({ error: `Za nagradu treba ${CFG.rewardPoints} bodova.` });
  res.json({ code, me: meView(db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id)) });
});

app.get('/api/reward/:code/qr.svg', async (req, res) => {
  const code = String(req.params.code).toUpperCase();
  if (!/^NMD-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) return res.status(400).end();
  res.type('image/svg+xml').send(await QRCode.toString(code, { type: 'svg', margin: 1, color: { dark: '#000000', light: '#ffffff' } }));
});

// ---------- Osoblje ----------
const adminSessions = new Map();
function adminAuth(req, res, next) {
  const t = req.get('X-Admin'), sess = t && adminSessions.get(t);
  if (!sess || sess.exp < Date.now()) return res.status(401).json({ error: 'Prijavi se PIN-om osoblja.' });
  req.staff = sess;
  next();
}
function pinEq(pin, ref) {
  const a = Buffer.from(String(pin)), b = Buffer.from(String(ref || ''));
  return b.length >= 4 && a.length === b.length && crypto.timingSafeEqual(a, b);
}
function normName(n) { return String(n || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toLowerCase().replace(/\s+/g, ' ').trim(); }
// gostinska kartica člana osoblja (traži se po imenu, pa radi i ako se registrira kasnije)
function staffGuestIds(name) {
  const n = normName(name);
  return db.prepare('SELECT id, name FROM users').all().filter(u => normName(u.name) === n).map(u => u.id);
}
app.post('/api/admin/login', limit('admin', 5, 900e3), (req, res) => {
  const pin = String(req.body.pin || '');
  const members = [{ name: 'Dražen', pin: CFG.adminPin, owner: true }, ...CFG.staff].filter(m => m.pin && m.pin.length >= 4);
  if (!members.length) return res.status(503).json({ error: 'PIN osoblja nije postavljen na serveru.' });
  const m = members.find(x => pinEq(pin, x.pin));
  if (!m) return res.status(401).json({ error: 'Pogrešan PIN.' });
  const t = crypto.randomBytes(24).toString('hex');
  adminSessions.set(t, { exp: Date.now() + 14 * 3600e3, name: m.name, owner: !!m.owner });
  res.json({ token: t, name: m.name });
});
app.get('/api/admin/me', adminAuth, (req, res) => res.json({ name: req.staff.name, owner: !!req.staff.owner }));

// ---------- Obavijesti za web (Agent NOMAd ih čita) ----------
function zgDanas() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zagreb' }).format(new Date()); }
function aktivneObavijesti() {
  return db.prepare('SELECT id, tekst, vrijedi_do, created_at FROM obavijesti WHERE vrijedi_do IS NULL OR vrijedi_do >= ? ORDER BY id DESC LIMIT 30').all(zgDanas());
}
function ownerOnly(req, res, next) { return req.staff.owner ? next() : res.status(403).json({ error: 'Obavijesti uređuje samo vlasnik.' }); }
app.get('/api/admin/obavijesti', adminAuth, ownerOnly, (req, res) => {
  res.json({ danas: zgDanas(), list: db.prepare('SELECT id, tekst, vrijedi_do, created_at FROM obavijesti ORDER BY id DESC LIMIT 60').all() });
});
app.post('/api/admin/obavijesti', adminAuth, ownerOnly, (req, res) => {
  const tekst = String(req.body.tekst || '').trim().slice(0, 1000);
  const doDat = String(req.body.vrijediDo || '').trim();
  if (tekst.length < 3) return res.status(400).json({ error: 'Upiši tekst obavijesti.' });
  if (doDat && !/^\d{4}-\d{2}-\d{2}$/.test(doDat)) return res.status(400).json({ error: 'Datum nije ispravan.' });
  db.prepare('INSERT INTO obavijesti (tekst, vrijedi_do, autor) VALUES (?,?,?)').run(tekst, doDat || null, req.staff.name);
  res.json({ ok: true });
});
app.post('/api/admin/obavijesti/:id/obrisi', adminAuth, ownerOnly, (req, res) => {
  db.prepare('DELETE FROM obavijesti WHERE id=?').run(parseInt(req.params.id, 10) || 0);
  res.json({ ok: true });
});
app.post('/api/admin/redeem', adminAuth, (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  const r = db.prepare('SELECT r.*, u.name AS guest FROM rewards r JOIN users u ON u.id=r.user_id WHERE r.code=?').get(code);
  if (!r) return res.status(404).json({ error: 'Kod ne postoji.' });
  if (r.status === 'redeemed') return res.status(409).json({ error: `Kod je već iskorišten (${new Date(r.redeemed_at.replace(' ', 'T') + 'Z').toLocaleString('hr-HR', { timeZone: 'Europe/Zagreb' })}).` });
  if (db.prepare(`SELECT expires_at <= datetime('now') AS x FROM rewards WHERE id=?`).get(r.id).x)
    return res.status(410).json({ error: 'Kodu je istekao rok.' });
  if (!req.staff.owner && staffGuestIds(req.staff.name).includes(r.user_id))
    return res.status(403).json({ error: 'Vlastitu nagradu ne možeš sam potvrditi – neka to napravi drugi član osoblja.' });
  db.prepare(`UPDATE rewards SET status='redeemed', redeemed_at=datetime('now'), redeemed_by=? WHERE id=?`).run(req.staff.name, r.id);
  res.json({ ok: true, guest: r.guest, item: r.name, cardNo: cardNo(r.user_id) });
});
app.get('/api/admin/lookup', adminAuth, (req, res) => {
  const q = String(req.query.q || '').trim();
  const byCard = /^\d{1,6}$/.test(q) ? db.prepare('SELECT * FROM users WHERE id=?').get(parseInt(q, 10)) : null;
  const u = byCard || db.prepare('SELECT * FROM users WHERE phone=?').get(normPhone(q));
  if (!u) return res.status(404).json({ error: 'Gost nije pronađen.' });
  res.json({ cardNo: cardNo(u.id), name: u.name, phone: u.phone, points: u.points });
});
app.post('/api/admin/points', adminAuth, (req, res) => {
  const id = parseInt(req.body.cardNo, 10), pts = parseInt(req.body.points, 10);
  const note = String(req.body.note || '').slice(0, 100);
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!u) return res.status(404).json({ error: 'Gost nije pronađen.' });
  if (!Number.isFinite(pts) || pts === 0 || Math.abs(pts) > 100) return res.status(400).json({ error: 'Bodovi: od -100 do 100.' });
  if (u.points + pts < 0) return res.status(400).json({ error: 'Gost nema toliko bodova.' });
  if (!req.staff.owner && staffGuestIds(req.staff.name).includes(id))
    return res.status(403).json({ error: 'Sebi ne možeš mijenjati bodove.' });
  db.transaction(() => {
    db.prepare('INSERT INTO adjustments (user_id, points, note, staff) VALUES (?,?,?,?)').run(id, pts, note, req.staff.name);
    db.prepare('UPDATE users SET points = points + ? WHERE id=?').run(pts, id);
  })();
  res.json({ ok: true, points: u.points + pts, name: u.name });
});
app.get('/api/admin/stats', adminAuth, (req, res) => {
  const day = zgDay();
  res.json({
    guests: db.prepare('SELECT COUNT(*) n FROM users').get().n,
    scansToday: db.prepare('SELECT COUNT(*) n FROM receipts WHERE zg_day=?').get(day).n,
    scansTotal: db.prepare('SELECT COUNT(*) n FROM receipts').get().n,
    rewardsRedeemed: db.prepare(`SELECT COUNT(*) n FROM rewards WHERE status='redeemed'`).get().n,
    rewardsActive: db.prepare(`SELECT COUNT(*) n FROM rewards WHERE status='active' AND expires_at > datetime('now')`).get().n,
  });
});

// ---------- Vlasnički admin panel (/admin, kratki link /a) ----------
require('./admin/dashboard').mount(app, { db, cfg: CFG, adminAuth, staffNames: CFG.staff.map(s => s.name) });

app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'Fotografija je prevelika. Pokušaj ponovno.' });
  console.error(err); res.status(500).json({ error: 'Greška na serveru.' });
});

if (require.main === module) {
  app.listen(CFG.port, () => console.log(`NOMAd kartica radi na http://localhost:${CFG.port}`));
}
module.exports = { app, parseReceipt, zagrebLocalToDate };
