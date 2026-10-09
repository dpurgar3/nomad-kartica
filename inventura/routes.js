// Prezentacijski sloj (HTTP): Express router za /inventura. Samo prevodi zahtjeve u pozive servisa.
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');
const dbm = require('./db');
const { createService, InvError } = require('./service');
const { createAuth } = require('./auth');
const L = require('./logic');
const C = require('./csv');
const remaris = require('./remaris');

const SEED = path.join(__dirname, 'seed', 'stanje-2026-10-09.json');

function createInventura({ dbFile, envPin = '', adminPin = '', seed = true } = {}) {
  const db = dbm.open(dbFile);
  const svc = createService(db);
  const auth = createAuth(db, { envPin, adminPin });
  if (seed && fs.existsSync(SEED)) svc.seedIfEmpty(JSON.parse(fs.readFileSync(SEED, 'utf8')), null);

  const router = express.Router();
  router.use('/api', express.json({ limit: '1mb' }));
  router.use(express.static(path.join(__dirname, 'public'), { index: 'index.html', maxAge: 0 }));

  const h = fn => async (req, res, next) => { try { const r = await fn(req, res); if (r !== undefined && !res.headersSent) res.json(r); } catch (e) { next(e); } };
  const ip = req => req.ip || 'x';
  const sendCsv = (res, name, body) => { res.set('Content-Type', 'text/csv; charset=utf-8'); res.set('Content-Disposition', `attachment; filename="${name}"`); res.send(body); };
  const csrf = (req, res, next) => (req.get('X-Inventura') === '1' ? next() : res.status(403).json({ error: 'Zahtjev odbijen.' }));
  const num = v => (v == null || v === '' ? undefined : Number(v));

  // ---------- prijava ----------
  router.get('/api/status', (req, res) => res.json({ mode: auth.mode(), user: auth.current(req) }));
  router.post('/api/login', csrf, (req, res) => {
    const r = auth.login(String(req.body?.pin || ''), ip(req));
    if (!r.ok) return res.status(r.status).json({ error: r.error, setup: r.setup });
    res.set('Set-Cookie', auth.cookie(req, r.token)).json({ user: r.user });
  });
  router.post('/api/setup', csrf, (req, res) => {
    const r = auth.setup(req.body || {}, ip(req));
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    res.set('Set-Cookie', auth.cookie(req, r.token)).json({ user: r.user });
  });
  router.post('/api/logout', csrf, (req, res) => { auth.logout(auth.tokenOf(req)); res.set('Set-Cookie', auth.cookie(req, '', 0)).json({ ok: true }); });

  router.use('/api', auth.middleware);
  const uid = req => req.user.id;

  // ---------- osnovni podaci ----------
  router.get('/api/meta', h(() => ({
    units: L.UNITS, movementTypes: L.MOVEMENT_TYPES, locations: svc.locations(), categories: svc.categories(),
    pocetno: svc.setting('pocetno_stanje'), lastRemaris: svc.setting('zadnji_remaris'), pinMode: auth.mode(),
  })));
  router.get('/api/dashboard', h(req => {
    const loc = num(req.query.location);
    const st = svc.stockReport(loc);
    const invs = svc.inventories();
    return {
      total_cents: st.total_cents, articles: st.articles, unpriced: st.unpriced, negative: st.negative,
      below_min: st.rows.filter(a => a.below_min).length, categories: st.categories,
      open: invs.find(i => i.status === 'u_tijeku') || null, last_closed: invs.find(i => i.status === 'zakljucena') || null,
      recent: svc.movements({ locationId: loc, limit: 8 }), pocetno: svc.setting('pocetno_stanje'), lastRemaris: svc.setting('zadnji_remaris'),
    };
  }));

  // ---------- artikli i kategorije ----------
  router.get('/api/articles', h(req => svc.articles({ locationId: num(req.query.location), search: req.query.q, categoryId: req.query.category, active: req.query.active, belowMin: req.query.belowMin === '1' })));
  router.post('/api/articles', h(req => ({ id: svc.createArticle(req.body || {}, uid(req)) })));
  router.put('/api/articles/:id', h(req => { svc.updateArticle(Number(req.params.id), req.body || {}, uid(req)); return { ok: true }; }));
  router.post('/api/articles/:id/packagings', h(req => ({ id: svc.addPackaging(Number(req.params.id), req.body || {}, uid(req)) })));
  router.delete('/api/packagings/:id', h(req => { svc.deletePackaging(Number(req.params.id), uid(req)); return { ok: true }; }));
  router.get('/api/categories', h(() => svc.categories()));
  router.post('/api/categories', h(req => ({ id: svc.saveCategory(req.body || {}, uid(req)) })));
  router.put('/api/categories/:id', h(req => ({ id: svc.saveCategory({ ...(req.body || {}), id: Number(req.params.id) }, uid(req)) })));
  router.delete('/api/categories/:id', h(req => { svc.deleteCategory(Number(req.params.id), uid(req)); return { ok: true }; }));
  router.post('/api/locations', h(req => ({ id: svc.addLocation(req.body?.name, uid(req)) })));

  // ---------- promjene zaliha ----------
  router.get('/api/movements', h(req => svc.movements({ locationId: num(req.query.location), articleId: req.query.article, type: req.query.type, from: req.query.from, to: req.query.to, limit: req.query.limit })));
  router.post('/api/movements', h(req => ({ id: svc.addMovement({ ...(req.body || {}), locationId: num(req.body?.locationId) }, uid(req)) })));

  // ---------- Remaris ----------
  router.post('/api/remaris/parse', express.raw({ type: () => true, limit: '8mb' }), h(async req => {
    if (!req.body || !req.body.length) throw new InvError('Odaberi PDF datoteku.');
    if (req.body.slice(0, 5).toString() !== '%PDF-') throw new InvError('Datoteka nije PDF.');
    let parsed; try { parsed = await remaris.parsePdf(req.body); } catch (e) { throw new InvError(e.message || 'PDF se ne može pročitati.'); }
    const preview = svc.importRemaris({ items: parsed.items, date: parsed.datum, locationId: num(req.query.location) }, uid(req), { dryRun: true });
    return { datum: parsed.datum, items: parsed.items, preview };
  }));
  router.post('/api/remaris/import', h(req => {
    const { items, date, source } = req.body || {};
    const r = svc.importRemaris({ items, date, source, locationId: num(req.body?.locationId) }, uid(req));
    db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('zadnji_remaris', ?)`).run(JSON.stringify({ datum: date, uvezeno: new Date().toISOString(), promjena: r.updated, novih: r.created }));
    return r;
  }));

  // ---------- inventure ----------
  router.get('/api/inventories', h(() => svc.inventories()));
  router.post('/api/inventories', h(req => ({ id: svc.createInventory({ ...(req.body || {}), locationId: num(req.body?.locationId) }, uid(req)) })));
  router.get('/api/inventories/:id', h(req => { const id = Number(req.params.id); return { inventory: svc.inventory(id), items: svc.inventoryItems(id), summary: svc.inventorySummary(id) }; }));
  router.post('/api/inventories/:id/refresh', h(req => { svc.refreshExpected(Number(req.params.id), uid(req)); return { ok: true }; }));
  router.post('/api/inventories/:id/close', h(req => { svc.closeInventory(Number(req.params.id), { allowUncounted: !!req.body?.allowUncounted }, uid(req)); return { ok: true }; }));
  router.delete('/api/inventories/:id', h(req => { svc.deleteOpenInventory(Number(req.params.id), uid(req)); return { ok: true }; }));
  router.post('/api/items/:id/count', h(req => ({ id: svc.addCount(Number(req.params.id), req.body || {}, uid(req)) })));
  router.put('/api/items/:id/count', h(req => ({ id: svc.setCount(Number(req.params.id), req.body || {}, uid(req)) })));
  router.delete('/api/items/:id/count', h(req => { svc.clearCount(Number(req.params.id), uid(req)); return { ok: true }; }));
  router.delete('/api/counts/:id', h(req => { svc.deleteCount(Number(req.params.id), uid(req)); return { ok: true }; }));
  router.put('/api/items/:id/note', h(req => { svc.setItemNote(Number(req.params.id), req.body?.note); return { ok: true }; }));
  router.post('/api/items/:id/correct', h(req => { svc.correctItem(Number(req.params.id), req.body || {}, uid(req)); return { ok: true }; }));

  // ---------- izvještaji ----------
  router.get('/api/reports/stock', h(req => svc.stockReport(num(req.query.location))));
  router.get('/api/audit', h(req => svc.auditLog(Number(req.query.limit) || 300)));
  const stamp = () => new Date().toISOString().slice(0, 10);
  router.get('/api/csv/stock', h((req, res) => sendCsv(res, `zalihe-${stamp()}.csv`, C.stockCsv(svc.stockReport(num(req.query.location)).rows))));
  router.get('/api/csv/below-min', h((req, res) => sendCsv(res, `ispod-minimuma-${stamp()}.csv`, C.stockCsv(svc.stockReport(num(req.query.location)).rows.filter(a => a.below_min)))));
  router.get('/api/csv/categories', h((req, res) => sendCsv(res, `po-kategorijama-${stamp()}.csv`, C.categoriesCsv(svc.stockReport(num(req.query.location)).categories))));
  router.get('/api/csv/history', h((req, res) => sendCsv(res, `povijest-inventura-${stamp()}.csv`, C.historyCsv(svc.inventories()))));
  router.get('/api/csv/movements', h((req, res) => sendCsv(res, `promjene-${stamp()}.csv`, C.movementsCsv(svc.movements({ locationId: num(req.query.location), type: req.query.type, from: req.query.from, to: req.query.to, limit: 5000 }), L.MOVEMENT_TYPES))));
  router.get('/api/csv/inventory/:id', h((req, res) => {
    const id = Number(req.params.id); const inv = svc.inventory(id);
    let items = svc.inventoryItems(id);
    if (req.query.only === 'razlike') items = items.filter(i => i.kind === 'visak' || i.kind === 'manjak');
    sendCsv(res, `inventura-${inv.inv_date}-${id}.csv`, C.inventoryCsv(inv, items));
  }));

  // ---------- postavke ----------
  router.post('/api/pin', h((req, res) => {
    const r = auth.changePin(uid(req), String(req.body?.oldPin || ''), String(req.body?.newPin || ''));
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    res.set('Set-Cookie', auth.cookie(req, r.token)).json({ ok: true });
  }));
  // sigurnosna kopija cijele baze inventure (SQLite datoteka)
  router.get('/api/backup', h(async (req, res) => {
    const tmp = path.join(os.tmpdir(), `inventura-${Date.now()}.db`);
    await db.backup(tmp);
    res.download(tmp, `inventura-kopija-${stamp()}.db`, () => fs.unlink(tmp, () => {}));
  }));

  router.use('/api', (req, res) => res.status(404).json({ error: 'Nepostojeća adresa.' }));
  router.use((err, req, res, next) => {
    if (err instanceof InvError || err.status) return res.status(err.status || 400).json({ error: err.message });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Datoteka je prevelika.' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Neispravan zahtjev.' });
    console.error('[inventura]', err);
    res.status(500).json({ error: 'Greška na serveru.' });
  });

  return { router, db, svc, auth };
}

module.exports = { createInventura };
