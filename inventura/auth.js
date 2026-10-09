// Prijava PIN-om (jedan korisnik). Implementirano i testirano:
//  - PIN se čuva samo kao scrypt hash sa solju (ili se zadaje varijablom INVENTURA_PIN na serveru)
//  - sesija: nasumični token u HttpOnly kolačiću; u bazi se čuva samo SHA-256 tokena; istječe nakon 30 dana
//  - nakon 8 pogrešnih pokušaja s iste IP adrese prijava je blokirana 15 minuta
//  - promjene (POST/PUT/DELETE) traže zaglavlje X-Inventura: 1 (zaštita od slanja forme s tuđe stranice)
'use strict';
const crypto = require('crypto');

const COOKIE = 'inv_sess';
const SESSION_DAYS = 30;
const MAX_FAILS = 8, LOCK_MS = 15 * 60 * 1000;

function hashPin(pin, salt = crypto.randomBytes(16).toString('hex')) {
  return `scrypt$${salt}$${crypto.scryptSync(String(pin), salt, 32).toString('hex')}`;
}
function verifyPin(pin, stored) {
  if (!stored) return false;
  const [alg, salt, h] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !h) return false;
  const a = Buffer.from(h, 'hex'), b = crypto.scryptSync(String(pin), salt, 32);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest(), y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y) && String(a) === String(b);
}
const sha = t => crypto.createHash('sha256').update(t).digest('hex');
function validPinFormat(pin) { return /^\d{4,12}$/.test(String(pin || '')); }

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
  return out;
}

function createAuth(db, { envPin = '', adminPin = '' } = {}) {
  const fails = new Map();
  const q = s => db.prepare(s);

  function mode() {
    if (envPin) return 'env';
    return q(`SELECT 1 FROM users WHERE pin_hash IS NOT NULL`).get() ? 'db' : 'setup';
  }
  function owner() {
    let u = q('SELECT * FROM users ORDER BY id LIMIT 1').get();
    if (!u) { q(`INSERT INTO users (name, role) VALUES ('Vlasnik', 'admin')`).run(); u = q('SELECT * FROM users ORDER BY id LIMIT 1').get(); }
    return u;
  }
  function locked(ip) {
    const f = fails.get(ip); if (!f) return false;
    if (Date.now() - f.first > LOCK_MS) { fails.delete(ip); return false; }
    return f.n >= MAX_FAILS;
  }
  function fail(ip) { const f = fails.get(ip); if (!f || Date.now() - f.first > LOCK_MS) fails.set(ip, { n: 1, first: Date.now() }); else f.n++; }

  function newSession(userId) {
    const token = crypto.randomBytes(32).toString('base64url');
    q(`DELETE FROM sessions WHERE expires_at < datetime('now')`).run();
    q(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', '+${SESSION_DAYS} days'))`).run(sha(token), userId);
    return token;
  }
  function userFromToken(token) {
    if (!token) return null;
    return q(`SELECT u.id, u.name, u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at > datetime('now')`).get(sha(token)) || null;
  }

  /** Vraća {ok, token, user} ili {ok:false, error, status}. */
  function login(pin, ip) {
    if (locked(ip)) return { ok: false, status: 429, error: 'Previše pogrešnih pokušaja. Pokušaj ponovno za 15 minuta.' };
    const m = mode();
    if (m === 'setup') return { ok: false, status: 409, error: 'PIN još nije postavljen.', setup: true };
    const u = owner();
    const good = m === 'env' ? safeEqual(pin, envPin) : verifyPin(pin, u.pin_hash);
    if (!good) { fail(ip); return { ok: false, status: 401, error: 'Pogrešan PIN.' }; }
    fails.delete(ip);
    return { ok: true, token: newSession(u.id), user: { id: u.id, name: u.name } };
  }
  /** Prvo postavljanje PIN-a: dopušteno samo dok PIN nije postavljen i uz ispravan ADMIN_PIN kartice. */
  function setup({ adminPin: given, newPin, name }, ip) {
    if (mode() !== 'setup') return { ok: false, status: 409, error: 'PIN je već postavljen.' };
    if (locked(ip)) return { ok: false, status: 429, error: 'Previše pogrešnih pokušaja. Pokušaj ponovno za 15 minuta.' };
    if (!adminPin || adminPin.length < 4) return { ok: false, status: 503, error: 'Na serveru nije postavljen ADMIN_PIN ni INVENTURA_PIN.' };
    if (!safeEqual(given, adminPin)) { fail(ip); return { ok: false, status: 401, error: 'Pogrešan PIN osoblja (ADMIN_PIN).' }; }
    if (!validPinFormat(newPin)) return { ok: false, status: 400, error: 'Novi PIN mora imati 4–12 znamenki.' };
    const u = owner();
    q('UPDATE users SET pin_hash=?, name=? WHERE id=?').run(hashPin(newPin), String(name || '').trim() || 'Vlasnik', u.id);
    return { ok: true, token: newSession(u.id), user: { id: u.id, name } };
  }
  function changePin(userId, oldPin, newPin) {
    if (mode() === 'env') return { ok: false, status: 409, error: 'PIN je zadan na serveru (INVENTURA_PIN) i mijenja se ondje.' };
    const u = q('SELECT * FROM users WHERE id=?').get(userId);
    if (!u || !verifyPin(oldPin, u.pin_hash)) return { ok: false, status: 401, error: 'Trenutni PIN nije ispravan.' };
    if (!validPinFormat(newPin)) return { ok: false, status: 400, error: 'Novi PIN mora imati 4–12 znamenki.' };
    db.transaction(() => {
      q('UPDATE users SET pin_hash=? WHERE id=?').run(hashPin(newPin), userId);
      q('DELETE FROM sessions WHERE user_id=?').run(userId); // odjava svih uređaja
    })();
    return { ok: true, token: newSession(userId) };
  }
  function logout(token) { if (token) q('DELETE FROM sessions WHERE token=?').run(sha(token)); }

  function cookie(req, token, maxAgeDays = SESSION_DAYS) {
    const secure = req.secure ? '; Secure' : '';
    return `${COOKIE}=${token}; Path=/inventura; HttpOnly; SameSite=Strict; Max-Age=${maxAgeDays * 86400}${secure}`;
  }
  function middleware(req, res, next) {
    const token = parseCookies(req.get('cookie'))[COOKIE];
    const u = userFromToken(token);
    if (!u) return res.status(401).json({ error: 'Prijavi se.', login: true });
    if (req.method !== 'GET' && req.get('X-Inventura') !== '1') return res.status(403).json({ error: 'Zahtjev odbijen.' });
    req.user = u; req.token = token; next();
  }
  return { mode, login, setup, changePin, logout, cookie, middleware, tokenOf: req => parseCookies(req.get('cookie'))[COOKIE],
    current: req => userFromToken(parseCookies(req.get('cookie'))[COOKIE]) };
}

module.exports = { createAuth, hashPin, verifyPin, validPinFormat, parseCookies, COOKIE };
