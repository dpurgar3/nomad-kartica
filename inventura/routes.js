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
const crypto = require('crypto');
const { createConsumption } = require('./consumption');
const SC = require('./salescsv');
const D = require('./decimal');

const SEED = path.join(__dirname, 'seed', 'stanje-2026-10-09.json');
const SEED_RECIPES = path.join(__dirname, 'seed', 'normativi-remaris.json');

function createInventura({ dbFile, envPin = '', adminPin = '', seed = true } = {}) {
  const db = dbm.open(dbFile);
  const svc = createService(db);
  const auth = createAuth(db, { envPin, adminPin });
  if (seed && fs.existsSync(SEED)) svc.seedIfEmpty(JSON.parse(fs.readFileSync(SEED, 'utf8')), null);
  const cons = createConsumption(db, svc);
  if (seed && fs.existsSync(SEED_RECIPES)) cons.seedRecipesIfEmpty(JSON.parse(fs.readFileSync(SEED_RECIPES, 'utf8')), null);
  // pročitane datoteke prodaje čekaju potvrdu uvoza (najviše 30 min, samo u memoriji)
  const pending = new Map();
  const stash = data => { const t = crypto.randomBytes(12).toString('hex'); pending.set(t, { ...data, at: Date.now() }); for (const [k, v] of pending) if (Date.now() - v.at > 30 * 60e3) pending.delete(k); return t; };
  const unstash = t => { const v = pending.get(String(t || '')); if (!v) throw new InvError('Pročitana datoteka je istekla. Odaberi je ponovno.'); return v; };

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

  // ---------- normativi ----------
  router.get('/api/recipes', h(req => cons.recipes({ search: req.query.q })));
  router.get('/api/recipes/:id', h(req => cons.recipeDetail(Number(req.params.id))));
  router.post('/api/recipes', h(req => cons.saveVersion({ ...(req.body || {}), recipeId: null }, uid(req))));
  router.post('/api/recipes/:id/versions', h(req => cons.saveVersion({ ...(req.body || {}), recipeId: Number(req.params.id) }, uid(req))));

  // ---------- uvoz prodaje ----------
  const salesPayload = (v, body) => {
    if (v.kind === 'pdf') return { period_from: v.period_from, period_to: v.period_to, lines: v.lines, reported_total_cents: v.total_cents, source: 'Remaris – Promet po artiklima (PDF)' };
    const mapped = SC.mapRows(v.rows, body.mapping, { header: body.header !== false });
    const pf = mapped.period_from || body.period_from, pt = mapped.period_to || body.period_to;
    return { period_from: pf, period_to: pt, lines: mapped.lines, parse_errors: mapped.errors, source: 'CSV' };
  };
  router.post('/api/sales/pdf', express.raw({ type: () => true, limit: '8mb' }), h(async req => {
    if (!req.body?.length || req.body.slice(0, 5).toString() !== '%PDF-') throw new InvError('Datoteka nije PDF.');
    let p; try { p = await remaris.parseSalesPdf(req.body); } catch (e) { throw new InvError(e.message); }
    const sha = cons.sha256(req.body);
    const token = stash({ kind: 'pdf', sha, file_name: String(req.query.name || 'promet.pdf').slice(0, 120), ...p });
    const preview = cons.importSales({ locationId: num(req.query.location), file_sha256: sha, ...salesPayload(pending.get(token), {}) }, uid(req), { dryRun: true });
    return { token, kind: 'pdf', preview };
  }));
  router.post('/api/sales/csv', express.text({ type: () => true, limit: '8mb' }), h(req => {
    const text = String(req.body || ''); if (!text.trim()) throw new InvError('Datoteka je prazna.');
    const { delimiter, rows } = SC.parseCsv(text);
    if (rows.length < 2) throw new InvError('CSV nema podataka.');
    const token = stash({ kind: 'csv', sha: cons.sha256(text), file_name: String(req.query.name || 'prodaja.csv').slice(0, 120), rows });
    return { token, kind: 'csv', delimiter, header: rows[0], sample: rows.slice(1, 6), rows: rows.length - 1, mapping: SC.guessMapping(rows[0]) };
  }));
  router.post('/api/sales/preview', h(req => {
    const v = unstash(req.body?.token);
    let pl; try { pl = salesPayload(v, req.body || {}); } catch (e) { throw new InvError(e.message); }
    if (!pl.period_from || !pl.period_to) throw new InvError('Upiši razdoblje prodaje (datoteka nema stupac s datumom).');
    const r = cons.importSales({ locationId: num(req.body?.locationId), file_sha256: v.sha, ...pl }, uid(req), { dryRun: true });
    r.errors = [...(pl.parse_errors || []), ...r.errors];
    return r;
  }));
  router.post('/api/sales/import', h(req => {
    const v = unstash(req.body?.token);
    let pl; try { pl = salesPayload(v, req.body || {}); } catch (e) { throw new InvError(e.message); }
    if (pl.parse_errors?.length) throw new InvError(`${pl.parse_errors.length} redaka ima pogrešku. Ispravi datoteku ili mapiranje stupaca.`);
    const r = cons.importSales({ locationId: num(req.body?.locationId), file_sha256: v.sha, file_name: v.file_name, ...pl }, uid(req));
    pending.delete(req.body.token);
    return r;
  }));
  router.get('/api/sales/imports', h(() => cons.salesImports()));
  router.get('/api/sales/imports/:id', h(req => cons.salesImport(Number(req.params.id))));
  router.post('/api/sales/imports/:id/storno', h(req => { cons.stornoImport(Number(req.params.id), req.body?.reason, uid(req)); return { ok: true }; }));

  // ---------- kontrola utroška ----------
  router.get('/api/consumption/theoretical', h(req => cons.theoretical({ locationId: num(req.query.location), from: req.query.from, to: req.query.to })));
  router.get('/api/consumption/compare', h(req => cons.compare({ locationId: num(req.query.location), startId: req.query.start, endId: req.query.end })));
  router.get('/api/csv/theoretical', h((req, res) => {
    const t = cons.theoretical({ locationId: num(req.query.location), from: req.query.from, to: req.query.to });
    sendCsv(res, `teorijski-utrosak-${t.from}-${t.to}.csv`, C.toCsv(['Razdoblje', 'Šifra', 'Artikl', 'Kategorija', 'Jedinica', 'Teorijski utrošak', 'Nabavna cijena bez PDV-a (EUR)', 'Vrijednost (EUR)', 'Iz normativa'],
      t.articles.map(a => [`${t.from} – ${t.to}`, a.code, a.name, a.category, a.unit, D.csvE4(a.qty_e4), D.csvE4(a.price_e4), D.csvCents(a.value_cents), a.sources.map(x => x.name).join(', ')])));
  }));
  router.get('/api/csv/compare', h((req, res) => {
    const c = cons.compare({ locationId: num(req.query.location), startId: req.query.start, endId: req.query.end });
    sendCsv(res, `kontrola-utroska-${c.from}-${c.to}.csv`, C.toCsv(['Razdoblje', 'Šifra', 'Artikl', 'Jedinica', 'Početno', 'Nabava', 'Završno', 'Stvarni utrošak', 'Teorijski utrošak', 'Evidentirani otpis/lom/interno', 'Neobjašnjeno odstupanje', 'Odstupanje %', 'Vrijednost odstupanja (EUR)'],
      c.rows.map(r => [`${c.from} – ${c.to}`, r.code, r.name, r.unit, D.csvE4(r.start_e4), D.csvE4(r.purchases_e4), D.csvE4(r.end_e4), D.csvE4(r.actual_e4), D.csvE4(r.theoretical_e4), D.csvE4(r.losses_e4), D.csvE4(r.unexplained_e4), r.unexplained_pct_e4 == null ? '' : D.csvE4(r.unexplained_pct_e4), D.csvCents(r.unexplained_cents)])));
  }));

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

  return { router, db, svc, auth, cons };
}

module.exports = { createInventura };
