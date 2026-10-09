// Logički sloj: normativi (recepture s verzijama), uvoz prodaje, teorijski utrošak i usporedba sa stvarnim.
'use strict';
const crypto = require('crypto');
const D = require('./decimal');
const L = require('./logic');
const { InvError } = require('./service');

const norm = s => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().replace(/\s+/g, ' ').trim();
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zagreb' }).format(new Date());
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
const LOSS_TYPES = ['otpis', 'lom', 'interno'];

function createConsumption(db, svc) {
  const q = s => db.prepare(s);
  const audit = svc.audit;

  // ======================= NORMATIVI =======================
  function recipeByCode(code) { return code ? q('SELECT * FROM recipes WHERE sale_code=?').get(String(code)) : null; }
  function recipe(id) { const r = q('SELECT * FROM recipes WHERE id=?').get(id); if (!r) throw new InvError('Normativ ne postoji.', 404); return r; }

  /** Verzija normativa koja vrijedi na zadani datum (zadnja s valid_from <= datum). */
  function versionAt(recipeId, date) {
    return q(`SELECT * FROM recipe_versions WHERE recipe_id=? AND valid_from<=? ORDER BY valid_from DESC, version DESC LIMIT 1`).get(recipeId, date) || null;
  }
  function linesOf(versionId) {
    return q(`SELECT rl.*, a.name AS article, a.unit AS article_unit, a.code AS article_code, a.active AS article_active, a.purchase_price_e4,
      r.name AS sub_recipe, r.sale_code AS sub_code FROM recipe_lines rl LEFT JOIN articles a ON a.id=rl.article_id LEFT JOIN recipes r ON r.id=rl.sub_recipe_id
      WHERE rl.version_id=? ORDER BY rl.id`).all(versionId);
  }
  function recipes({ search } = {}) {
    const t = today();
    let rows = q('SELECT * FROM recipes ORDER BY CAST(sale_code AS INTEGER), sale_code, name').all();
    if (search) { const w = norm(search).split(' '); rows = rows.filter(r => { const k = norm(`${r.sale_code || ''} ${r.name}`); return w.every(x => k.includes(x)); }); }
    return rows.map(r => {
      const v = versionAt(r.id, t) || q('SELECT * FROM recipe_versions WHERE recipe_id=? ORDER BY valid_from DESC, version DESC LIMIT 1').get(r.id);
      const lines = v ? linesOf(v.id) : [];
      return { ...r, current: v ? { ...v, lines } : null, versions: q('SELECT COUNT(*) n FROM recipe_versions WHERE recipe_id=?').get(r.id).n,
        flagged: lines.filter(l => l.note).length, cost_cents: v ? portionCost(r.id, t) : null };
    });
  }
  function recipeDetail(id) {
    const r = recipe(id);
    const versions = q('SELECT v.*, u.name AS user FROM recipe_versions v LEFT JOIN users u ON u.id=v.created_by WHERE recipe_id=? ORDER BY valid_from DESC, version DESC').all(id)
      .map(v => ({ ...v, lines: linesOf(v.id) }));
    const usedIn = q(`SELECT DISTINCT r.id, r.name, r.sale_code FROM recipe_lines rl JOIN recipe_versions v ON v.id=rl.version_id JOIN recipes r ON r.id=v.recipe_id WHERE rl.sub_recipe_id=?`).all(id);
    return { ...r, versions, usedIn, cost_cents: portionCost(id, today()) };
  }

  /** Bi li normativ `recipeId` (izravno ili preko podnormativa) koristio sam sebe? */
  function wouldCycle(recipeId, subIds) {
    const seen = new Set();
    const stack = [...subIds];
    while (stack.length) {
      const id = stack.pop();
      if (id === recipeId) return true;
      if (seen.has(id)) continue; seen.add(id);
      for (const r of q(`SELECT DISTINCT rl.sub_recipe_id s FROM recipe_lines rl JOIN recipe_versions v ON v.id=rl.version_id WHERE v.recipe_id=? AND rl.sub_recipe_id IS NOT NULL`).all(id)) stack.push(r.s);
    }
    return false;
  }

  function cleanLines(lines, recipeId) {
    if (!Array.isArray(lines) || !lines.length) throw new InvError('Normativ mora imati barem jedan sastojak.');
    const out = [];
    lines.forEach((l, i) => {
      const n = i + 1;
      const qty = D.parseE4(l.qty);
      if (qty == null || Number.isNaN(qty) || qty <= 0) throw new InvError(`Sastojak ${n}: količina mora biti pozitivan broj.`);
      if (l.sub_recipe_id) {
        const sub = recipe(Number(l.sub_recipe_id));
        if (sub.id === recipeId) throw new InvError(`Sastojak ${n}: normativ ne može sadržavati sam sebe.`);
        out.push({ article_id: null, sub_recipe_id: sub.id, qty_e4: qty, note: String(l.note || '').trim() || null });
      } else if (l.article_id) {
        const a = svc.article(Number(l.article_id));
        let base; try { base = L.toBaseQty({ qtyE4: qty, unit: l.unit || a.unit }, a.unit); } catch (e) { throw new InvError(`Sastojak ${n} (${a.name}): ${e.message}`); }
        if (base <= 0) throw new InvError(`Sastojak ${n}: količina je premala (zaokružena na 0).`);
        out.push({ article_id: a.id, sub_recipe_id: null, qty_e4: base, note: String(l.note || '').trim() || null });
      } else throw new InvError(`Sastojak ${n}: odaberi artikl ili drugi normativ.`);
    });
    return out;
  }

  /** Nova verzija normativa (ili novi normativ). Postojeće verzije se ne mijenjaju. */
  function saveVersion({ recipeId, sale_code, name, valid_from, yield_loss_pct, note, lines, source }, userId) {
    valid_from = valid_from || today();
    if (!isDate(valid_from)) throw new InvError('Datum početka važenja nije ispravan.');
    const loss = yield_loss_pct === undefined || yield_loss_pct === '' || yield_loss_pct === null ? 0 : D.parseE4(yield_loss_pct);
    if (Number.isNaN(loss) || loss < 0 || loss >= 1000000) throw new InvError('Gubitak pripreme mora biti između 0 i 99,99 %.');
    return db.transaction(() => {
      let rid = recipeId ? recipe(Number(recipeId)).id : null;
      if (!rid) {
        name = String(name || '').trim(); if (!name) throw new InvError('Upiši naziv prodajnog artikla.');
        sale_code = String(sale_code || '').trim() || null;
        if (sale_code && recipeByCode(sale_code)) throw new InvError('Normativ za tu šifru već postoji. Dodaj mu novu verziju.');
        rid = q('INSERT INTO recipes (sale_code, name) VALUES (?, ?)').run(sale_code, name).lastInsertRowid;
        audit('recipe', rid, 'create', null, { sale_code, name }, userId);
      }
      const clean = cleanLines(lines, rid);
      const subs = clean.filter(l => l.sub_recipe_id).map(l => l.sub_recipe_id);
      if (subs.length && wouldCycle(rid, subs)) throw new InvError('Kružna ovisnost: odabrani podnormativ (izravno ili preko drugih) koristi ovaj normativ.');
      if (q('SELECT 1 FROM recipe_versions WHERE recipe_id=? AND valid_from=?').get(rid, valid_from))
        throw new InvError('Verzija s tim datumom već postoji. Za ispravak odaberi drugi datum početka važenja.');
      const version = (q('SELECT MAX(version) m FROM recipe_versions WHERE recipe_id=?').get(rid).m || 0) + 1;
      const vid = q(`INSERT INTO recipe_versions (recipe_id, version, valid_from, yield_loss_pct_e4, note, source, created_by) VALUES (?,?,?,?,?,?,?)`)
        .run(rid, version, valid_from, loss, String(note || '').trim() || null, source || 'ručni unos', userId ?? null).lastInsertRowid;
      const ins = q('INSERT INTO recipe_lines (version_id, article_id, sub_recipe_id, qty_e4, note) VALUES (?,?,?,?,?)');
      for (const l of clean) ins.run(vid, l.article_id, l.sub_recipe_id, l.qty_e4, l.note);
      audit('recipe_version', vid, 'create', null, { recipe_id: rid, version, valid_from, lines: clean }, userId);
      return { recipeId: rid, versionId: vid, version };
    })();
  }

  /**
   * Rastavi `portionsE4` porcija normativa na artikle sa zalihe (rekurzivno kroz podnormative).
   * Gubitak pripreme: potrošnja sirovine = količina × (1 + gubitak %).
   */
  function explode(recipeId, date, portionsE4, acc, path = []) {
    if (path.includes(recipeId)) throw new InvError('Kružna ovisnost normativa: ' + path.concat(recipeId).map(id => recipe(id).name).join(' → '));
    const v = versionAt(recipeId, date);
    if (!v) return { missing: true };
    for (const l of q('SELECT * FROM recipe_lines WHERE version_id=?').all(v.id)) {
      let qty = D.mulE4(portionsE4, l.qty_e4);
      if (v.yield_loss_pct_e4) qty = qty + Number(D.divRound(BigInt(qty) * BigInt(v.yield_loss_pct_e4), 1000000n));
      if (l.article_id) acc.set(l.article_id, (acc.get(l.article_id) || 0) + qty);
      else { const r = explode(l.sub_recipe_id, date, qty, acc, path.concat(recipeId)); if (r.missing) return r; }
    }
    return { missing: false, version: v };
  }
  function portionCost(recipeId, date) {
    const acc = new Map();
    try { if (explode(recipeId, date, 10000, acc).missing) return null; } catch { return null; }
    let c = 0;
    for (const [aid, qty] of acc) { const a = q('SELECT purchase_price_e4 FROM articles WHERE id=?').get(aid); if (a?.purchase_price_e4 == null) return null; c += D.valueCents(qty, a.purchase_price_e4); }
    return c;
  }

  /** Prvo punjenje normativa iz Remaris izvoza. Nepostojeći sastojci dodaju se kao neaktivni artikli (ne ulaze u inventuru). */
  function seedRecipesIfEmpty(seed, userId) {
    if (q('SELECT COUNT(*) n FROM recipes').get().n > 0) return false;
    if (!q('SELECT COUNT(*) n FROM articles').get().n) return false;
    const articles = q('SELECT * FROM articles').all();
    const byName = new Map(); for (const a of articles) { byName.set(norm(a.remaris_name || a.name), a); byName.set(norm(a.name), a); }
    db.transaction(() => {
      const catId = (() => { const n = 'Sastojci iz normativa'; const c = q('SELECT id FROM categories WHERE name=?').get(n); if (c) return c.id;
        return q('INSERT INTO categories (name, sort) VALUES (?, (SELECT COALESCE(MAX(sort),0)+1 FROM categories))').run(n).lastInsertRowid; })();
      const ids = new Map();
      for (const r of seed.normativi) ids.set(r.sifra, q('INSERT INTO recipes (sale_code, name) VALUES (?, ?)').run(r.sifra, r.naziv).lastInsertRowid);
      const byRecipeName = new Map(seed.normativi.map(r => [norm(r.naziv), ids.get(r.sifra)]));
      for (const r of seed.normativi) {
        const rid = ids.get(r.sifra);
        const vid = q(`INSERT INTO recipe_versions (recipe_id, version, valid_from, source, created_by) VALUES (?,?,?,?,?)`).run(rid, 1, seed.vrijedi_od, seed.izvor, userId ?? null).lastInsertRowid;
        const skipped = [];
        for (const s of r.sastojci) {
          const qty = D.parseE4(s.kolicina);
          if (!(qty > 0)) { skipped.push(s.naziv); continue; }
          if (s.jedinica === 'porcija') {
            const sub = byRecipeName.get(norm(s.naziv));
            if (!sub) throw new Error('Podnormativ ne postoji: ' + s.naziv);
            q('INSERT INTO recipe_lines (version_id, sub_recipe_id, qty_e4, note) VALUES (?,?,?,?)').run(vid, sub, qty, s.napomena || null);
            continue;
          }
          let a = byName.get(norm(s.naziv));
          if (!a) {
            const code = svc.nextCodeForSeed();
            const id = q(`INSERT INTO articles (code, name, remaris_name, category_id, unit, active) VALUES (?,?,?,?,?,0)`).run(code, s.naziv, s.naziv, catId, s.jedinica).lastInsertRowid;
            a = q('SELECT * FROM articles WHERE id=?').get(id); byName.set(norm(s.naziv), a);
          }
          let base = qty;
          if (a.unit !== s.jedinica) base = L.toBaseQty({ qtyE4: qty, unit: s.jedinica }, a.unit);
          q('INSERT INTO recipe_lines (version_id, article_id, qty_e4, note) VALUES (?,?,?,?)').run(vid, a.id, base, s.napomena || null);
        }
        if (skipped.length) q('UPDATE recipe_versions SET note=? WHERE id=?').run(`U Remarisu s količinom 0 (izostavljeno): ${skipped.join(', ')}`, vid);
      }
      audit('seed', null, 'normativi', null, { izvor: seed.izvor, normativa: seed.normativi.length }, userId);
    })();
    return true;
  }

  // ======================= UVOZ PRODAJE =======================
  function resolveSale(code, name) {
    const r = code ? recipeByCode(code) : null;
    if (r) return { kind: 'normativ', recipe: r };
    if (!code) { const rn = q('SELECT * FROM recipes').all().find(x => norm(x.name) === norm(name)); if (rn) return { kind: 'normativ', recipe: rn }; }
    const a = code ? q('SELECT * FROM articles WHERE remaris_code=? OR code=?').get(String(code), String(code))
      : q('SELECT * FROM articles').all().find(x => norm(x.remaris_name || x.name) === norm(name));
    if (a) return { kind: 'artikl', article: a };
    return { kind: 'nema' };
  }

  /**
   * Uvoz prodaje (agregirano po razdoblju — Remaris "Promet po artiklima" — ili po stavkama iz CSV-a).
   * Pravila: ista datoteka se ne može uvesti dvaput; razdoblja aktivnih uvoza za istu lokaciju se ne smiju preklapati;
   * stavke CSV-a s oznakom dokumenta koja je već uvezena odbijaju se. Povrati/storna su negativne količine i smanjuju utrošak.
   */
  function importSales({ locationId, period_from, period_to, source, file_name, file_sha256, lines, reported_total_cents }, userId, { dryRun = false } = {}) {
    const loc = svc.location(locationId);
    if (!isDate(period_from) || !isDate(period_to)) throw new InvError('Razdoblje prodaje nije ispravno.');
    if (period_from > period_to) throw new InvError('Početak razdoblja je nakon kraja.');
    if (!Array.isArray(lines) || !lines.length) throw new InvError('Nema stavki prodaje.');
    if (!file_sha256) throw new InvError('Nedostaje oznaka datoteke.');
    const errors = []; const clean = [];
    lines.forEach((l, i) => {
      const qty = D.parseE4(l.qty);
      const name = String(l.name || '').trim();
      if (!name && !l.code) errors.push({ row: l.row ?? i + 1, error: 'Nema naziva ni šifre artikla.' });
      else if (qty == null || Number.isNaN(qty)) errors.push({ row: l.row ?? i + 1, error: `Količina „${l.qty ?? ''}” nije broj.` });
      else if (l.date && (!isDate(l.date) || l.date < period_from || l.date > period_to)) errors.push({ row: l.row ?? i + 1, error: `Datum ${l.date} je izvan razdoblja.` });
      else clean.push({ ...l, name: name || String(l.code), qty_e4: qty, code: l.code ? String(l.code).trim() : null });
    });
    const dup = q(`SELECT * FROM sales_imports WHERE file_sha256=? AND status='aktivan'`).get(file_sha256);
    const overlap = q(`SELECT * FROM sales_imports WHERE location_id=? AND status='aktivan' AND period_from<=? AND period_to>=?`).all(loc.id, period_to, period_from);
    const refs = clean.filter(l => l.ref).map(l => String(l.ref));
    const seenRefs = new Set();
    if (refs.length) {
      const chk = q(`SELECT 1 FROM sales_lines sl JOIN sales_imports si ON si.id=sl.import_id WHERE si.status='aktivan' AND si.location_id=? AND sl.source_ref=? AND COALESCE(sl.sale_code,sl.sale_name)=? LIMIT 1`);
      for (const l of clean) if (l.ref) { const key = l.ref + '|' + (l.code || l.name); if (seenRefs.has(key) || chk.get(loc.id, String(l.ref), l.code || l.name)) errors.push({ row: l.row, error: `Stavka dokumenta ${l.ref} je već uvezena.` }); seenRefs.add(key); }
    }
    // pregled: agregat po šifri/nazivu i povezivanje s normativom
    const agg = new Map();
    for (const l of clean) {
      const k = l.code || norm(l.name);
      if (!agg.has(k)) agg.set(k, { code: l.code, name: l.name, category: l.category || null, qty_e4: 0, total_cents: 0 });
      const g = agg.get(k); g.qty_e4 += l.qty_e4; g.total_cents += l.total_cents || 0;
    }
    const preview = [...agg.values()].map(g => { const r = resolveSale(g.code, g.name); return { ...g, match: r.kind, match_name: r.recipe?.name || r.article?.name || null }; });
    const sum = clean.reduce((s, l) => s + (l.total_cents || 0), 0);
    const result = {
      period_from, period_to, lines: clean.length, errors, preview, total_cents: sum, reported_total_cents: reported_total_cents ?? null,
      duplicate: dup ? { id: dup.id, created_at: dup.created_at } : null,
      overlap: overlap.map(o => ({ id: o.id, period_from: o.period_from, period_to: o.period_to, source: o.source })),
      unmatched: preview.filter(p => p.match === 'nema').length,
    };
    if (dryRun) return result;
    if (dup) throw new InvError(`Ova datoteka je već uvezena (uvoz br. ${dup.id}). Ako je bila pogrešna, prvo stornirajte taj uvoz.`, 409);
    if (overlap.length) throw new InvError(`Razdoblje se preklapa s već uvezenom prodajom (${overlap.map(o => `br. ${o.id}: ${o.period_from} – ${o.period_to}`).join(', ')}). Dvostruki uvoz bi udvostručio utrošak.`, 409);
    if (errors.length) throw new InvError(`${errors.length} redaka ima pogrešku. Ispravi datoteku ili mapiranje stupaca.`);
    if (reported_total_cents != null && sum !== reported_total_cents) throw new InvError(`Zbroj stavki (${D.formatCents(sum)}) ne odgovara ukupnom iznosu izvještaja (${D.formatCents(reported_total_cents)}). Uvoz je zaustavljen.`);
    return db.transaction(() => {
      const id = q(`INSERT INTO sales_imports (location_id, period_from, period_to, source, file_name, file_sha256, total_cents, line_count, created_by) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(loc.id, period_from, period_to, source, file_name || null, file_sha256, sum, clean.length, userId ?? null).lastInsertRowid;
      const ins = q(`INSERT INTO sales_lines (import_id, sale_date, sale_code, sale_name, category, qty_e4, price_cents, total_cents, source_ref) VALUES (?,?,?,?,?,?,?,?,?)`);
      for (const l of clean) ins.run(id, l.date || null, l.code, l.name, l.category || null, l.qty_e4, l.price_cents ?? null, l.total_cents ?? null, l.ref ? String(l.ref) : null);
      audit('sales_import', id, 'create', null, { period_from, period_to, source, lines: clean.length, total_cents: sum }, userId);
      return { ...result, id };
    })();
  }
  function salesImports() {
    return q(`SELECT si.*, l.name AS location, u.name AS user FROM sales_imports si JOIN locations l ON l.id=si.location_id LEFT JOIN users u ON u.id=si.created_by ORDER BY si.period_from DESC, si.id DESC`).all();
  }
  function salesImport(id) {
    const si = q('SELECT * FROM sales_imports WHERE id=?').get(id); if (!si) throw new InvError('Uvoz ne postoji.', 404);
    const lines = q(`SELECT COALESCE(sale_code,'') AS code, MIN(sale_name) AS name, MIN(category) AS category, SUM(qty_e4) AS qty_e4, SUM(total_cents) AS total_cents, COUNT(*) AS rows
      FROM sales_lines WHERE import_id=? GROUP BY COALESCE(sale_code, sale_name) ORDER BY MIN(id)`).all(id)
      .map(l => { const r = resolveSale(l.code || null, l.name); return { ...l, match: r.kind, match_name: r.recipe?.name || r.article?.name || null, recipe_id: r.recipe?.id || null }; });
    return { ...si, lines };
  }
  function stornoImport(id, reason, userId) {
    const si = q('SELECT * FROM sales_imports WHERE id=?').get(id); if (!si) throw new InvError('Uvoz ne postoji.', 404);
    if (si.status !== 'aktivan') throw new InvError('Uvoz je već storniran.');
    reason = String(reason || '').trim(); if (reason.length < 3) throw new InvError('Upiši razlog storniranja.');
    q(`UPDATE sales_imports SET status='storniran', storno_reason=?, storno_at=datetime('now') WHERE id=?`).run(reason, id);
    audit('sales_import', id, 'storno', { status: 'aktivan' }, { status: 'storniran' }, userId, reason);
  }

  // ======================= TEORIJSKI UTROŠAK =======================
  /**
   * Teorijski utrošak sastojka = Σ (prodana količina × normativ koji je vrijedio na početku razdoblja uvoza).
   * Uključuju se samo uvozi čije je razdoblje unutar [from, to]; djelomično preklapanje se isključuje i prijavljuje.
   * Prodajni artikl bez normativa, a s istom šifrom kao artikl sa zalihe, troši se 1 : 1 (npr. boca soka).
   */
  function theoretical({ locationId, from, to }) {
    const loc = svc.location(locationId);
    if (!isDate(from) || !isDate(to) || from > to) throw new InvError('Odaberi ispravno razdoblje.');
    const imports = q(`SELECT * FROM sales_imports WHERE location_id=? AND status='aktivan' AND period_from<=? AND period_to>=? ORDER BY period_from`).all(loc.id, to, from);
    const included = imports.filter(i => i.period_from >= from && i.period_to <= to);
    const excluded = imports.filter(i => !included.includes(i));
    const perArticle = new Map(); const unmatched = new Map(); const warnings = []; const perRecipe = new Map();
    const add = (aid, qty, srcName) => {
      if (!perArticle.has(aid)) perArticle.set(aid, { qty_e4: 0, sources: new Map() });
      const p = perArticle.get(aid); p.qty_e4 += qty; p.sources.set(srcName, (p.sources.get(srcName) || 0) + qty);
    };
    let salesCents = 0;
    for (const imp of included) {
      const versionChanges = q(`SELECT r.name, v.valid_from FROM recipe_versions v JOIN recipes r ON r.id=v.recipe_id WHERE v.valid_from>? AND v.valid_from<=?`).all(imp.period_from, imp.period_to);
      for (const vc of versionChanges) warnings.push(`Normativ „${vc.name}” ima novu verziju od ${vc.valid_from}, unutar razdoblja uvoza ${imp.period_from} – ${imp.period_to}. Prodaja iz tog uvoza računa se po verziji koja je vrijedila ${imp.period_from}; za točan izračun uvezi prodaju podijeljenu po tom datumu.`);
      const lines = q(`SELECT COALESCE(sale_code, sale_name) k, MIN(sale_code) code, MIN(sale_name) name, MIN(sale_date) d, SUM(qty_e4) qty, SUM(total_cents) tot FROM sales_lines WHERE import_id=? GROUP BY k, COALESCE(sale_date, '')`).all(imp.id);
      for (const l of lines) {
        salesCents += l.tot || 0;
        const date = l.d || imp.period_from;
        const r = resolveSale(l.code, l.name);
        if (r.kind === 'normativ') {
          const acc = new Map(); const ex = explode(r.recipe.id, date, l.qty, acc);
          if (ex.missing) { const u = unmatched.get(l.k) || { code: l.code, name: l.name, qty_e4: 0, total_cents: 0, reason: `normativ ne vrijedi na ${date}` }; u.qty_e4 += l.qty; u.total_cents += l.tot || 0; unmatched.set(l.k, u); continue; }
          for (const [aid, qty] of acc) add(aid, qty, r.recipe.name);
          const pr = perRecipe.get(r.recipe.id) || { recipe_id: r.recipe.id, code: r.recipe.sale_code, name: r.recipe.name, qty_e4: 0, total_cents: 0, cost_cents: 0, unpriced: false };
          pr.qty_e4 += l.qty; pr.total_cents += l.tot || 0;
          for (const [aid, qty] of acc) { const a = svc.article(aid); if (a.purchase_price_e4 == null) pr.unpriced = true; else pr.cost_cents += D.valueCents(qty, a.purchase_price_e4); }
          perRecipe.set(r.recipe.id, pr);
        } else if (r.kind === 'artikl') add(r.article.id, l.qty, `prodaja 1:1 (${l.name})`);
        else { const u = unmatched.get(l.k) || { code: l.code, name: l.name, qty_e4: 0, total_cents: 0, reason: 'nema normativa ni artikla s tom šifrom' }; u.qty_e4 += l.qty; u.total_cents += l.tot || 0; unmatched.set(l.k, u); }
      }
    }
    const articles = [...perArticle.entries()].map(([aid, p]) => {
      const a = q('SELECT a.*, c.name AS category FROM articles a LEFT JOIN categories c ON c.id=a.category_id WHERE a.id=?').get(aid);
      return { article_id: aid, code: a.code, name: a.name, unit: a.unit, category: a.category, active: a.active, qty_e4: p.qty_e4, price_e4: a.purchase_price_e4,
        value_cents: D.valueCents(p.qty_e4, a.purchase_price_e4), sources: [...p.sources.entries()].map(([name, qty_e4]) => ({ name, qty_e4 })).sort((x, y) => y.qty_e4 - x.qty_e4) };
    }).sort((x, y) => (y.value_cents || 0) - (x.value_cents || 0));
    return {
      location: loc.name, from, to, basis: 'Σ prodana količina × normativ (verzija važeća na početku razdoblja uvoza); povrati/storna kao negativna prodaja; nabavna cijena bez PDV-a (trenutna).',
      imports: included.map(i => ({ id: i.id, period_from: i.period_from, period_to: i.period_to, source: i.source })),
      excluded: excluded.map(i => ({ id: i.id, period_from: i.period_from, period_to: i.period_to, source: i.source })),
      articles, recipes: [...perRecipe.values()].sort((a, b) => b.total_cents - a.total_cents),
      unmatched: [...unmatched.values()].sort((a, b) => b.total_cents - a.total_cents),
      sales_cents: salesCents, value_cents: articles.reduce((s, a) => s + (a.value_cents || 0), 0), warnings: [...new Set(warnings)],
    };
  }

  // ======================= KONTROLA UTROŠKA =======================
  /**
   * Stvarni utrošak između dviju točaka (zaključena inventura ili početno stanje):
   *   stvarni = početno stanje + nabava u razdoblju − završno prebrojano stanje
   *   neobjašnjeno odstupanje = stvarni − teorijski − evidentirani otpis/lom/interno
   * Ovo NIJE inventurni manjak (on uspoređuje prebrojano s knjižnim stanjem); ovdje se uspoređuje potrošnja s normativom.
   */
  function compare({ locationId, startId, endId }) {
    const loc = svc.location(locationId);
    const point = id => {
      if (id === 'pocetno') {
        const p = svc.setting('pocetno_stanje'); if (!p) throw new InvError('Nema početnog stanja.');
        const m = new Map(); for (const r of q(`SELECT article_id, SUM(qty_e4) s FROM stock_movements WHERE type='pocetno' AND location_id=? GROUP BY article_id`).all(loc.id)) m.set(r.article_id, r.s);
        return { label: `Početno stanje (Remaris, knjižno) ${p.datum}`, date: p.datum, qty: m, physical: false };
      }
      const inv = svc.inventory(Number(id));
      if (inv.status !== 'zakljucena') throw new InvError(`Inventura „${inv.name}” nije zaključena.`);
      const m = new Map(); for (const r of q('SELECT article_id, counted_qty_e4 c FROM inventory_items WHERE inventory_id=? AND counted_qty_e4 IS NOT NULL').all(inv.id)) m.set(r.article_id, r.c);
      return { label: `${inv.name} (${inv.inv_date})`, date: inv.inv_date, qty: m, physical: true };
    };
    const s = point(startId), e = point(endId);
    if (s.date >= e.date) throw new InvError('Završna točka mora biti nakon početne.');
    // prodaja i ulazi: dan nakon početne do dana završne inventure (uključivo)
    const from = new Date(Date.parse(s.date + 'T12:00:00Z') + 864e5).toISOString().slice(0, 10);
    const th = theoretical({ locationId: loc.id, from, to: e.date });
    const thMap = new Map(th.articles.map(a => [a.article_id, a]));
    const mv = (types) => { const m = new Map(); for (const r of q(`SELECT article_id, SUM(qty_e4) s FROM stock_movements WHERE location_id=? AND type IN (${types.map(() => '?').join(',')}) AND movement_date>=? AND movement_date<=? GROUP BY article_id`).all(loc.id, ...types, from, e.date)) m.set(r.article_id, r.s); return m; };
    const purchases = mv(['nabava']); const losses = mv(LOSS_TYPES);
    const ids = new Set([...s.qty.keys(), ...e.qty.keys(), ...thMap.keys()]);
    const rows = [];
    for (const aid of ids) {
      const a = q('SELECT a.*, c.name AS category FROM articles a LEFT JOIN categories c ON c.id=a.category_id WHERE a.id=?').get(aid);
      const start = s.qty.get(aid), end = e.qty.get(aid), theo = thMap.get(aid)?.qty_e4 || 0;
      const inQty = purchases.get(aid) || 0, lossQty = -(losses.get(aid) || 0);
      const complete = start != null && end != null;
      const actual = complete ? start + inQty - end : null;
      const unexplained = complete ? actual - theo - lossQty : null;
      if (!complete && !theo) continue;
      rows.push({ article_id: aid, code: a.code, name: a.name, unit: a.unit, category: a.category, price_e4: a.purchase_price_e4,
        start_e4: start ?? null, purchases_e4: inQty, end_e4: end ?? null, actual_e4: actual, theoretical_e4: theo, losses_e4: lossQty, unexplained_e4: unexplained,
        unexplained_pct_e4: complete && theo ? Number(D.divRound(BigInt(unexplained) * 1000000n, BigInt(theo))) : null,
        unexplained_cents: unexplained == null ? null : D.valueCents(unexplained, a.purchase_price_e4), complete });
    }
    rows.sort((x, y) => Math.abs(y.unexplained_cents || 0) - Math.abs(x.unexplained_cents || 0));
    const days = (Date.parse(e.date) - Date.parse(from)) / 864e5 + 1;
    const covered = th.imports.reduce((n, i) => n + (Date.parse(i.period_to) - Date.parse(i.period_from)) / 864e5 + 1, 0);
    const warnings = [...th.warnings];
    if (covered < days) warnings.push(`Uvezena prodaja pokriva ${covered} od ${days} dana razdoblja (${from} – ${e.date}). Teorijski utrošak je zato manji od stvarnog; uvezi prodaju za cijelo razdoblje.`);
    if (!s.physical) warnings.push('Početna točka je knjižno stanje iz Remarisa, a ne prebrojano stanje.');
    if (th.unmatched.length) warnings.push(`${th.unmatched.length} prodajnih artikala nema normativ — njihov utrošak nije u teorijskom.`);
    warnings.push('Ulazi robe uzimaju se samo iz „Nabava” upisanih u aplikaciji. Usklađenja s Remarisom se ne računaju kao ulaz.');
    return { start: s.label, end: e.label, from, to: e.date, rows, theoretical: th, warnings,
      total_unexplained_cents: rows.reduce((t, r) => t + (r.unexplained_cents || 0), 0),
      basis: 'stvarni = početno + nabava − završno; neobjašnjeno = stvarni − teorijski − evidentirani otpis/lom/interno; vrijednost po trenutnoj nabavnoj cijeni bez PDV-a' };
  }

  return { recipes, recipeDetail, saveVersion, versionAt, explode, portionCost, wouldCycle, seedRecipesIfEmpty,
    resolveSale, importSales, salesImports, salesImport, stornoImport, theoretical, compare, sha256 };
}

module.exports = { createConsumption };
