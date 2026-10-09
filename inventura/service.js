// Logički sloj: poslovne operacije inventure nad bazom (bez HTTP-a i bez prikaza).
'use strict';
const D = require('./decimal');
const L = require('./logic');

class InvError extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }

const norm = s => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().replace(/\s+/g, ' ').trim();
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zagreb' }).format(new Date());
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

function createService(db) {
  const q = (sql) => db.prepare(sql);

  function audit(entity, entityId, action, before, after, userId, reason) {
    q(`INSERT INTO audit_log (entity, entity_id, action, before_json, after_json, reason, user_id) VALUES (?,?,?,?,?,?,?)`)
      .run(entity, entityId ?? null, action, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, reason || null, userId ?? null);
  }

  // ---------- osnovno ----------
  function defaultLocation() {
    let l = q('SELECT * FROM locations ORDER BY id LIMIT 1').get();
    if (!l) { q(`INSERT INTO locations (name) VALUES ('Glavno')`).run(); l = q('SELECT * FROM locations ORDER BY id LIMIT 1').get(); }
    return l;
  }
  function locations() { defaultLocation(); return q('SELECT * FROM locations ORDER BY id').all(); }
  function location(id) { const l = id ? q('SELECT * FROM locations WHERE id=?').get(id) : defaultLocation(); if (!l) throw new InvError('Lokacija ne postoji.', 404); return l; }
  function addLocation(name, userId) {
    name = String(name || '').trim(); if (!name) throw new InvError('Upiši naziv lokacije.');
    if (q('SELECT 1 FROM locations WHERE name=?').get(name)) throw new InvError('Lokacija s tim nazivom već postoji.');
    const id = q('INSERT INTO locations (name) VALUES (?)').run(name).lastInsertRowid;
    audit('location', id, 'create', null, { name }, userId); return id;
  }

  function categoryId(name) {
    name = String(name || '').trim(); if (!name) return null;
    const c = q('SELECT id FROM categories WHERE name=?').get(name);
    if (c) return c.id;
    const sort = (q('SELECT MAX(sort) m FROM categories').get().m || 0) + 1;
    return q('INSERT INTO categories (name, sort) VALUES (?, ?)').run(name, sort).lastInsertRowid;
  }
  function categories() {
    return q(`SELECT c.*, (SELECT COUNT(*) FROM articles a WHERE a.category_id=c.id) AS article_count FROM categories c ORDER BY c.sort, c.name`).all();
  }
  function saveCategory({ id, name, sort }, userId) {
    name = String(name || '').trim(); if (!name) throw new InvError('Upiši naziv kategorije.');
    const dup = q('SELECT id FROM categories WHERE name=?').get(name);
    if (dup && dup.id !== id) throw new InvError('Kategorija s tim nazivom već postoji.');
    if (id) {
      const before = q('SELECT * FROM categories WHERE id=?').get(id); if (!before) throw new InvError('Kategorija ne postoji.', 404);
      q('UPDATE categories SET name=?, sort=? WHERE id=?').run(name, Number.isInteger(sort) ? sort : before.sort, id);
      audit('category', id, 'update', before, { name, sort }, userId); return id;
    }
    const nid = categoryId(name); audit('category', nid, 'create', null, { name }, userId); return nid;
  }
  function deleteCategory(id, userId) {
    const c = q('SELECT * FROM categories WHERE id=?').get(id); if (!c) throw new InvError('Kategorija ne postoji.', 404);
    if (q('SELECT 1 FROM articles WHERE category_id=?').get(id)) throw new InvError('Kategorija ima artikle. Premjesti ih pa je onda obriši.');
    q('DELETE FROM categories WHERE id=?').run(id); audit('category', id, 'delete', c, null, userId);
  }

  function nextCode() {
    const rows = q(`SELECT code FROM articles WHERE code LIKE 'N-%'`).all();
    const max = rows.reduce((m, r) => Math.max(m, parseInt(r.code.slice(2), 10) || 0), 0);
    return 'N-' + String(max + 1).padStart(3, '0');
  }

  // ---------- stanje ----------
  function bookStock(articleId, locationId) {
    return q('SELECT COALESCE(SUM(qty_e4),0) s FROM stock_movements WHERE article_id=? AND location_id=?').get(articleId, locationId).s;
  }
  function stockMap(locationId) {
    const m = new Map();
    for (const r of q('SELECT article_id, SUM(qty_e4) s FROM stock_movements WHERE location_id=? GROUP BY article_id').all(locationId)) m.set(r.article_id, r.s);
    return m;
  }

  // ---------- artikli ----------
  function articleRow(a, stock) {
    const s = stock.get(a.id) || 0;
    return { ...a, stock_e4: s, value_cents: D.valueCents(s, a.purchase_price_e4), below_min: a.min_qty_e4 != null && s < a.min_qty_e4 };
  }
  function articles({ locationId, search, categoryId: cat, active, belowMin } = {}) {
    const loc = location(locationId);
    const stock = stockMap(loc.id);
    let rows = q(`SELECT a.*, c.name AS category FROM articles a LEFT JOIN categories c ON c.id=a.category_id ORDER BY c.sort, c.name, a.name`).all();
    const pk = new Map();
    for (const p of q('SELECT * FROM packagings ORDER BY qty_e4').all()) { if (!pk.has(p.article_id)) pk.set(p.article_id, []); pk.get(p.article_id).push(p); }
    rows = rows.map(a => ({ ...articleRow(a, stock), packagings: pk.get(a.id) || [] }));
    if (search) { const t = norm(search).split(' '); rows = rows.filter(a => { const k = norm(`${a.code} ${a.name} ${a.remaris_name || ''} ${a.category || ''} ${a.supplier || ''}`); return t.every(x => k.includes(x)); }); }
    if (cat) rows = rows.filter(a => a.category_id === Number(cat));
    if (active === '1' || active === true) rows = rows.filter(a => a.active);
    if (active === '0' || active === false) rows = rows.filter(a => !a.active);
    if (belowMin) rows = rows.filter(a => a.active && a.below_min);
    return rows;
  }
  function article(id) {
    const a = q(`SELECT a.*, c.name AS category FROM articles a LEFT JOIN categories c ON c.id=a.category_id WHERE a.id=?`).get(id);
    if (!a) throw new InvError('Artikl ne postoji.', 404);
    return a;
  }

  function cleanArticleInput(inp, existing) {
    const out = {};
    out.code = String(inp.code ?? existing?.code ?? '').trim() || null;
    out.name = String(inp.name ?? existing?.name ?? '').trim();
    if (!out.name) throw new InvError('Upiši naziv artikla.');
    out.unit = String(inp.unit ?? existing?.unit ?? '').trim();
    if (!L.UNITS[out.unit]) throw new InvError('Odaberi mjernu jedinicu.');
    const price = inp.purchase_price !== undefined ? D.parseE4(inp.purchase_price) : existing?.purchase_price_e4 ?? null;
    if (Number.isNaN(price)) throw new InvError('Nabavna cijena nije ispravan broj.');
    if (price != null && price < 0) throw new InvError('Nabavna cijena ne može biti negativna.');
    out.purchase_price_e4 = price;
    const min = inp.min_qty !== undefined ? D.parseE4(inp.min_qty) : existing?.min_qty_e4 ?? null;
    if (Number.isNaN(min)) throw new InvError('Minimalna zaliha nije ispravan broj.');
    if (min != null && min < 0) throw new InvError('Minimalna zaliha ne može biti negativna.');
    out.min_qty_e4 = min;
    let vat = inp.vat_rate !== undefined ? inp.vat_rate : existing?.vat_rate ?? null;
    vat = vat === '' || vat === null ? null : Number(vat);
    if (vat != null && ![0, 5, 13, 25].includes(vat)) throw new InvError('Stopa PDV-a mora biti 0, 5, 13 ili 25 %.');
    out.vat_rate = vat;
    out.supplier = inp.supplier !== undefined ? (String(inp.supplier).trim() || null) : existing?.supplier ?? null;
    out.active = inp.active !== undefined ? (inp.active ? 1 : 0) : existing?.active ?? 1;
    out.category_id = inp.category !== undefined ? categoryId(inp.category) : existing?.category_id ?? null;
    return out;
  }
  function createArticle(inp, userId) {
    const a = cleanArticleInput(inp);
    if (!a.code) a.code = nextCode();
    if (q('SELECT 1 FROM articles WHERE code=?').get(a.code)) throw new InvError('Artikl s tom šifrom već postoji.');
    const id = q(`INSERT INTO articles (code, name, category_id, supplier, unit, purchase_price_e4, price_source, vat_rate, min_qty_e4, active)
      VALUES (@code, @name, @category_id, @supplier, @unit, @purchase_price_e4, @price_source, @vat_rate, @min_qty_e4, @active)`).run({ ...a, price_source: a.purchase_price_e4 != null ? 'ručni unos' : null }).lastInsertRowid;
    audit('article', id, 'create', null, a, userId);
    return id;
  }
  function updateArticle(id, inp, userId) {
    const before = article(id);
    const a = cleanArticleInput(inp, before);
    if (!a.code) throw new InvError('Šifra ne može biti prazna.');
    const dup = q('SELECT id FROM articles WHERE code=?').get(a.code);
    if (dup && dup.id !== id) throw new InvError('Artikl s tom šifrom već postoji.');
    if (a.unit !== before.unit && q('SELECT 1 FROM stock_movements WHERE article_id=?').get(id))
      throw new InvError('Jedinica se ne može mijenjati jer artikl već ima knjižene količine (miješale bi se nekompatibilne jedinice).');
    const priceSrc = a.purchase_price_e4 !== before.purchase_price_e4 ? 'ručni unos' : before.price_source;
    q(`UPDATE articles SET code=@code, name=@name, category_id=@category_id, supplier=@supplier, unit=@unit, purchase_price_e4=@purchase_price_e4,
       price_source=@price_source, vat_rate=@vat_rate, min_qty_e4=@min_qty_e4, active=@active, updated_at=datetime('now') WHERE id=@id`).run({ ...a, price_source: priceSrc, id });
    audit('article', id, 'update', before, a, userId);
  }

  function addPackaging(articleId, { name, qty }, userId) {
    const a = article(articleId);
    name = String(name || '').trim(); if (!name) throw new InvError('Upiši naziv pakiranja (npr. gajba, boca 0,7 l).');
    const qe = D.parseE4(qty);
    if (qe == null || Number.isNaN(qe) || qe <= 0) throw new InvError(`Upiši koliko ${a.unit} sadrži jedno pakiranje (pozitivan broj).`);
    if (q('SELECT 1 FROM packagings WHERE article_id=? AND name=?').get(articleId, name)) throw new InvError('Pakiranje s tim nazivom već postoji.');
    const id = q('INSERT INTO packagings (article_id, name, qty_e4) VALUES (?,?,?)').run(articleId, name, qe).lastInsertRowid;
    audit('packaging', id, 'create', null, { article_id: articleId, name, qty_e4: qe }, userId); return id;
  }
  function deletePackaging(id, userId) {
    const p = q('SELECT * FROM packagings WHERE id=?').get(id); if (!p) throw new InvError('Pakiranje ne postoji.', 404);
    q('DELETE FROM packagings WHERE id=?').run(id); audit('packaging', id, 'delete', p, null, userId);
  }

  // ---------- promjene zaliha ----------
  function addMovement({ articleId, locationId, type, qty, unit, packagingId, date, reason, unitPrice }, userId) {
    const a = article(Number(articleId)); const loc = location(locationId);
    if (!a.active) throw new InvError('Artikl nije aktivan.');
    const qe = D.parseE4(qty);
    let pk = null; if (packagingId) { pk = q('SELECT * FROM packagings WHERE id=? AND article_id=?').get(packagingId, a.id); if (!pk) throw new InvError('Pakiranje ne pripada artiklu.'); }
    let base; try { base = L.toBaseQty({ qtyE4: qe, unit, packagingQtyE4: pk?.qty_e4 }, a.unit); } catch (e) { throw new InvError(e.message); }
    let signed; try { signed = L.signedMovementQty(type, base); } catch (e) { throw new InvError(e.message); }
    reason = String(reason || '').trim();
    if (!reason && (type === 'korekcija' || type === 'otpis')) throw new InvError('Upiši razlog promjene.');
    date = date || today(); if (!isDate(date)) throw new InvError('Datum nije ispravan.');
    let price = unitPrice !== undefined && unitPrice !== '' ? D.parseE4(unitPrice) : null;
    if (Number.isNaN(price) || (price != null && price < 0)) throw new InvError('Cijena nije ispravna.');
    const id = db.transaction(() => {
      const mid = q(`INSERT INTO stock_movements (article_id, location_id, type, qty_e4, unit_price_e4, reason, movement_date, user_id) VALUES (?,?,?,?,?,?,?,?)`)
        .run(a.id, loc.id, type, signed, price, reason || L.MOVEMENT_TYPES[type].label, date, userId).lastInsertRowid;
      if (type === 'nabava' && price != null) {
        q(`UPDATE articles SET purchase_price_e4=?, price_source=?, updated_at=datetime('now') WHERE id=?`).run(price, `nabava ${date}`, a.id);
        audit('article', a.id, 'price_from_purchase', { purchase_price_e4: a.purchase_price_e4 }, { purchase_price_e4: price }, userId);
      }
      audit('movement', mid, 'create', null, { article_id: a.id, type, qty_e4: signed, date, reason }, userId);
      return mid;
    })();
    return id;
  }
  function movements({ locationId, articleId, type, from, to, limit = 500 } = {}) {
    const loc = location(locationId);
    const w = ['m.location_id=?']; const p = [loc.id];
    if (articleId) { w.push('m.article_id=?'); p.push(Number(articleId)); }
    if (type) { w.push('m.type=?'); p.push(type); }
    if (from && isDate(from)) { w.push('m.movement_date>=?'); p.push(from); }
    if (to && isDate(to)) { w.push('m.movement_date<=?'); p.push(to); }
    return q(`SELECT m.*, a.code, a.name AS article, a.unit, u.name AS user FROM stock_movements m JOIN articles a ON a.id=m.article_id
      LEFT JOIN users u ON u.id=m.user_id WHERE ${w.join(' AND ')} ORDER BY m.movement_date DESC, m.id DESC LIMIT ${Math.min(Number(limit) || 500, 5000)}`).all(...p);
  }

  // ---------- početno stanje i uvoz iz Remarisa ----------
  function findArticleForRemaris(it) {
    if (it.sifra) { const a = q('SELECT * FROM articles WHERE remaris_code=?').get(String(it.sifra)); if (a) return a; }
    const n = norm(it.naziv);
    return q('SELECT * FROM articles').all().find(a => norm(a.remaris_name || a.name) === n) || null;
  }
  /** Prvo punjenje: artikli + početno stanje (vrsta "pocetno"). Izvodi se samo ako nema artikala. */
  function seedIfEmpty(seed, userId) {
    if (q('SELECT COUNT(*) n FROM articles').get().n > 0) return false;
    const loc = defaultLocation();
    db.transaction(() => {
      for (const it of seed.artikli) {
        const unit = L.REMARIS_UNITS[String(it.jedinica).toLowerCase()] || it.jedinica;
        const code = it.sifra ? String(it.sifra) : nextCode();
        const price = it.nabavna_cijena != null ? D.parseE4(it.nabavna_cijena) : null;
        const id = q(`INSERT INTO articles (code, remaris_code, name, remaris_name, category_id, supplier, unit, purchase_price_e4, price_source, vat_rate)
          VALUES (?,?,?,?,?,?,?,?,?,?)`).run(code, it.sifra || null, it.naziv, it.naziv, categoryId(it.kategorija), it.dobavljac || null, unit, price,
          price != null ? (it.izvor_cijene || 'Remaris primke') : null, it.pdv ?? null).lastInsertRowid;
        const qty = D.parseE4(it.stanje);
        q(`INSERT INTO stock_movements (article_id, location_id, type, qty_e4, reason, movement_date, user_id) VALUES (?,?,?,?,?,?,?)`)
          .run(id, loc.id, 'pocetno', qty, `Početno stanje — ${seed.izvor}`, seed.datum, userId ?? null);
      }
      q(`INSERT OR REPLACE INTO settings (key, value) VALUES ('pocetno_stanje', ?)`).run(JSON.stringify({ izvor: seed.izvor, datum: seed.datum, cijene: seed.cijene }));
      audit('seed', null, 'pocetno_stanje', null, { izvor: seed.izvor, artikala: seed.artikli.length }, userId);
    })();
    return true;
  }
  /**
   * Usklađenje sa stanjem iz Remarisa: knjiženo stanje u aplikaciji postaje jednako Remarisovom
   * (razlika se knjiži kao promjena vrste "remaris"). Novi artikli se dodaju.
   */
  function importRemaris({ items, date, source, locationId }, userId, { dryRun = false } = {}) {
    const loc = location(locationId); date = date || today();
    if (!isDate(date)) throw new InvError('Datum nije ispravan.');
    if (!Array.isArray(items) || !items.length) throw new InvError('U izvještaju nema artikala.');
    const result = { updated: 0, unchanged: 0, created: 0, rows: [] };
    const run = () => {
      for (const it of items) {
        const qty = D.parseE4(it.stanje); if (qty == null || Number.isNaN(qty)) continue;
        let a = findArticleForRemaris(it);
        let created = false;
        if (!a) {
          const unit = L.REMARIS_UNITS[String(it.jedinica).toLowerCase()];
          if (!unit) continue;
          if (!dryRun) {
            const code = it.sifra && !q('SELECT 1 FROM articles WHERE code=?').get(String(it.sifra)) ? String(it.sifra) : nextCode();
            const id = q(`INSERT INTO articles (code, remaris_code, name, remaris_name, category_id, unit) VALUES (?,?,?,?,?,?)`)
              .run(code, it.sifra || null, it.naziv, it.naziv, categoryId(it.kategorija), unit).lastInsertRowid;
            a = article(id);
          } else a = { id: null, name: it.naziv, unit };
          created = true; result.created++;
        }
        const book = a.id ? bookStock(a.id, loc.id) : 0;
        const diff = qty - book;
        result.rows.push({ name: a.name, created, book_e4: book, remaris_e4: qty, diff_e4: diff });
        if (diff === 0) { result.unchanged++; continue; }
        result.updated++;
        if (!dryRun) q(`INSERT INTO stock_movements (article_id, location_id, type, qty_e4, reason, movement_date, user_id) VALUES (?,?,?,?,?,?,?)`)
          .run(a.id, loc.id, 'remaris', diff, `Usklađenje s Remarisom: ${source || 'izvještaj Skladišna stanja'}`, date, userId);
      }
      if (!dryRun) audit('remaris_import', null, 'import', null, { source, date, updated: result.updated, created: result.created }, userId);
    };
    if (dryRun) run(); else db.transaction(run)();
    return result;
  }

  // ---------- inventura ----------
  function inventory(id) {
    const i = q(`SELECT i.*, l.name AS location, u.name AS created_by_name, c.name AS closed_by_name FROM inventories i JOIN locations l ON l.id=i.location_id
      LEFT JOIN users u ON u.id=i.created_by LEFT JOIN users c ON c.id=i.closed_by WHERE i.id=?`).get(id);
    if (!i) throw new InvError('Inventura ne postoji.', 404);
    return i;
  }
  function createInventory({ name, date, locationId, note }, userId) {
    const loc = location(locationId);
    date = date || today(); if (!isDate(date)) throw new InvError('Datum nije ispravan.');
    name = String(name || '').trim() || `Inventura ${date.split('-').reverse().join('.')}.`;
    if (q(`SELECT 1 FROM inventories WHERE location_id=? AND status='u_tijeku'`).get(loc.id))
      throw new InvError('Za ovu lokaciju već postoji inventura u tijeku. Završi je ili nastavi s njom.');
    const stock = stockMap(loc.id);
    return db.transaction(() => {
      const id = q(`INSERT INTO inventories (name, inv_date, location_id, note, created_by) VALUES (?,?,?,?,?)`).run(name, date, loc.id, note || null, userId).lastInsertRowid;
      const ins = q(`INSERT INTO inventory_items (inventory_id, article_id, expected_qty_e4, price_e4) VALUES (?,?,?,?)`);
      for (const a of q('SELECT * FROM articles WHERE active=1').all()) ins.run(id, a.id, stock.get(a.id) || 0, a.purchase_price_e4);
      audit('inventory', id, 'create', null, { name, date, location: loc.name }, userId);
      return id;
    })();
  }
  function assertOpen(inv) { if (inv.status !== 'u_tijeku') throw new InvError('Inventura je zaključena. Promjene su moguće samo kroz ispravak s obrazloženjem.', 409); }

  function inventoryItems(invId) {
    const inv = inventory(invId);
    const stock = stockMap(inv.location_id);
    const rows = q(`SELECT ii.*, a.code, a.name, a.unit, a.purchase_price_e4 AS current_price_e4, c.name AS category, c.sort AS category_sort
      FROM inventory_items ii JOIN articles a ON a.id=ii.article_id LEFT JOIN categories c ON c.id=a.category_id WHERE ii.inventory_id=? ORDER BY c.sort, c.name, a.name`).all(invId);
    const counts = new Map();
    for (const c of q(`SELECT ic.*, u.name AS user FROM inventory_counts ic JOIN inventory_items ii ON ii.id=ic.item_id LEFT JOIN users u ON u.id=ic.user_id
      WHERE ii.inventory_id=? AND ic.deleted_at IS NULL ORDER BY ic.id`).all(invId)) { if (!counts.has(c.item_id)) counts.set(c.item_id, []); counts.get(c.item_id).push(c); }
    const corr = new Map();
    for (const c of q(`SELECT ic.*, u.name AS user FROM inventory_corrections ic JOIN inventory_items ii ON ii.id=ic.item_id LEFT JOIN users u ON u.id=ic.user_id WHERE ii.inventory_id=? ORDER BY ic.id`).all(invId)) { if (!corr.has(c.item_id)) corr.set(c.item_id, []); corr.get(c.item_id).push(c); }
    const pk = new Map();
    for (const p of q('SELECT * FROM packagings ORDER BY qty_e4').all()) { if (!pk.has(p.article_id)) pk.set(p.article_id, []); pk.get(p.article_id).push(p); }
    return rows.map(r => {
      const diff = L.difference(r.expected_qty_e4, r.counted_qty_e4);
      return { ...r, diff_e4: diff, kind: L.diffKind(diff), diff_cents: diff == null ? null : D.valueCents(diff, r.price_e4),
        expected_value_cents: D.valueCents(r.expected_qty_e4, r.price_e4), counted_value_cents: D.valueCents(r.counted_qty_e4, r.price_e4),
        book_now_e4: inv.status === 'u_tijeku' ? (stock.get(r.article_id) || 0) : null,
        counts: counts.get(r.id) || [], corrections: corr.get(r.id) || [], packagings: pk.get(r.article_id) || [] };
    });
  }
  function inventorySummary(invId) {
    const items = inventoryItems(invId);
    return L.summarize(items.map(i => ({ expectedE4: i.expected_qty_e4, countedE4: i.counted_qty_e4, priceE4: i.price_e4 })));
  }
  function itemWithInventory(itemId) {
    const it = q('SELECT ii.*, a.unit, a.name FROM inventory_items ii JOIN articles a ON a.id=ii.article_id WHERE ii.id=?').get(itemId);
    if (!it) throw new InvError('Stavka inventure ne postoji.', 404);
    return { it, inv: inventory(it.inventory_id) };
  }
  function recomputeCounted(itemId) {
    const r = q('SELECT COUNT(*) n, COALESCE(SUM(qty_e4),0) s FROM inventory_counts WHERE item_id=? AND deleted_at IS NULL').get(itemId);
    q(`UPDATE inventory_items SET counted_qty_e4=?, updated_at=datetime('now') WHERE id=?`).run(r.n ? r.s : null, itemId);
  }
  /** Unos prebrojane količine (zbraja se s već unesenim za taj artikl). */
  function addCount(itemId, { qty, unit, packagingId }, userId) {
    const { it, inv } = itemWithInventory(itemId); assertOpen(inv);
    const qe = D.parseE4(qty);
    try { L.validateCount(qe); } catch (e) { throw new InvError(e.message); }
    let pk = null; if (packagingId) { pk = q('SELECT * FROM packagings WHERE id=? AND article_id=?').get(packagingId, it.article_id); if (!pk) throw new InvError('Pakiranje ne pripada artiklu.'); }
    let base; try { base = L.toBaseQty({ qtyE4: qe, unit, packagingQtyE4: pk?.qty_e4 }, it.unit); } catch (e) { throw new InvError(e.message); }
    const label = pk ? `${D.formatE4(qe)} × ${pk.name}` : `${D.formatE4(qe)} ${unit || it.unit}`;
    return db.transaction(() => {
      const id = q('INSERT INTO inventory_counts (item_id, input_qty_e4, input_label, qty_e4, user_id) VALUES (?,?,?,?,?)').run(itemId, qe, label, base, userId).lastInsertRowid;
      recomputeCounted(itemId); return id;
    })();
  }
  /** Postavi ukupnu prebrojanu količinu (zamjenjuje dosadašnje unose; stari ostaju u povijesti kao obrisani). */
  function setCount(itemId, { qty, unit, packagingId }, userId) {
    const { inv } = itemWithInventory(itemId); assertOpen(inv);
    return db.transaction(() => {
      q(`UPDATE inventory_counts SET deleted_at=datetime('now') WHERE item_id=? AND deleted_at IS NULL`).run(itemId);
      recomputeCounted(itemId);
      return addCount(itemId, { qty, unit, packagingId }, userId);
    })();
  }
  function deleteCount(countId, userId) {
    const c = q('SELECT * FROM inventory_counts WHERE id=?').get(countId); if (!c || c.deleted_at) throw new InvError('Unos ne postoji.', 404);
    const { inv } = itemWithInventory(c.item_id); assertOpen(inv);
    db.transaction(() => { q(`UPDATE inventory_counts SET deleted_at=datetime('now') WHERE id=?`).run(countId); recomputeCounted(c.item_id); })();
  }
  function clearCount(itemId, userId) {
    const { inv } = itemWithInventory(itemId); assertOpen(inv);
    db.transaction(() => { q(`UPDATE inventory_counts SET deleted_at=datetime('now') WHERE item_id=? AND deleted_at IS NULL`).run(itemId); recomputeCounted(itemId); })();
  }
  function setItemNote(itemId, note) {
    const { inv } = itemWithInventory(itemId); assertOpen(inv);
    q(`UPDATE inventory_items SET note=?, updated_at=datetime('now') WHERE id=?`).run(String(note || '').trim() || null, itemId);
  }
  /** Osvježi očekivano stanje i cijene na trenutno knjiženo (dok je inventura u tijeku). */
  function refreshExpected(invId, userId) {
    const inv = inventory(invId); assertOpen(inv);
    const stock = stockMap(inv.location_id);
    db.transaction(() => {
      for (const r of q('SELECT ii.id, ii.article_id, a.purchase_price_e4 FROM inventory_items ii JOIN articles a ON a.id=ii.article_id WHERE ii.inventory_id=?').all(invId))
        q('UPDATE inventory_items SET expected_qty_e4=?, price_e4=? WHERE id=?').run(stock.get(r.article_id) || 0, r.purchase_price_e4, r.id);
      // novi aktivni artikli dodani nakon početka inventure
      const ins = q(`INSERT OR IGNORE INTO inventory_items (inventory_id, article_id, expected_qty_e4, price_e4) VALUES (?,?,?,?)`);
      for (const a of q('SELECT * FROM articles WHERE active=1').all()) ins.run(invId, a.id, stock.get(a.id) || 0, a.purchase_price_e4);
      audit('inventory', invId, 'refresh_expected', null, null, userId);
    })();
  }
  /**
   * Zaključivanje: za svaki prebrojani artikl knjiži se inventurna razlika, pa knjiženo stanje postaje jednako prebrojanom.
   * Neprebrojani artikli ostaju nepromijenjeni (dopušteno samo uz allowUncounted).
   */
  function closeInventory(invId, { allowUncounted = false } = {}, userId) {
    const inv = inventory(invId); assertOpen(inv);
    const items = q('SELECT * FROM inventory_items WHERE inventory_id=?').all(invId);
    const counted = items.filter(i => i.counted_qty_e4 != null);
    if (!counted.length) throw new InvError('Nijedan artikl nije prebrojan. Inventura se ne može zaključiti.');
    const uncounted = items.length - counted.length;
    if (uncounted && !allowUncounted) throw new InvError(`${uncounted} artikala nije prebrojano. Prebroji ih ili potvrdi zaključivanje uz neprebrojane (njihovo stanje ostaje nepromijenjeno).`, 409);
    const stock = stockMap(inv.location_id);
    db.transaction(() => {
      for (const it of counted) {
        const book = stock.get(it.article_id) || 0;
        // očekivano = knjiženo stanje u trenutku zaključivanja (ako se u međuvremenu nešto knjižilo)
        if (book !== it.expected_qty_e4) q('UPDATE inventory_items SET expected_qty_e4=? WHERE id=?').run(book, it.id);
        const diff = it.counted_qty_e4 - book;
        if (diff !== 0) q(`INSERT INTO stock_movements (article_id, location_id, type, qty_e4, unit_price_e4, reason, movement_date, user_id, inventory_id) VALUES (?,?,?,?,?,?,?,?,?)`)
          .run(it.article_id, inv.location_id, 'inventura', diff, it.price_e4, `Inventurna razlika — ${inv.name}`, inv.inv_date, userId, invId);
      }
      q(`UPDATE inventories SET status='zakljucena', closed_by=?, closed_at=datetime('now') WHERE id=?`).run(userId, invId);
      audit('inventory', invId, 'close', { status: 'u_tijeku' }, { status: 'zakljucena', counted: counted.length, uncounted }, userId);
    })();
  }
  /** Ispravak zaključene inventure: nova količina + obrazloženje; stara vrijednost ostaje u povijesti. */
  function correctItem(itemId, { qty, reason }, userId) {
    const { it, inv } = itemWithInventory(itemId);
    if (inv.status !== 'zakljucena') throw new InvError('Dok je inventura u tijeku, količinu promijeni izravno.');
    reason = String(reason || '').trim(); if (reason.length < 3) throw new InvError('Upiši razlog ispravka.');
    const nq = D.parseE4(qty); try { L.validateCount(nq); } catch (e) { throw new InvError(e.message); }
    const old = it.counted_qty_e4;
    if (old === nq) throw new InvError('Nova količina je ista kao postojeća.');
    db.transaction(() => {
      q('INSERT INTO inventory_corrections (item_id, old_qty_e4, new_qty_e4, reason, user_id) VALUES (?,?,?,?,?)').run(itemId, old, nq, reason, userId);
      q(`UPDATE inventory_items SET counted_qty_e4=?, updated_at=datetime('now') WHERE id=?`).run(nq, itemId);
      const delta = nq - (old == null ? it.expected_qty_e4 : old);
      if (delta !== 0) q(`INSERT INTO stock_movements (article_id, location_id, type, qty_e4, unit_price_e4, reason, movement_date, user_id, inventory_id) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(it.article_id, inv.location_id, 'ispravak_inventure', delta, it.price_e4, `Ispravak inventure „${inv.name}”: ${reason}`, today(), userId, inv.id);
      audit('inventory_item', itemId, 'correction', { counted_qty_e4: old }, { counted_qty_e4: nq }, userId, reason);
    })();
  }
  function inventories() {
    return q(`SELECT i.*, l.name AS location FROM inventories i JOIN locations l ON l.id=i.location_id ORDER BY i.inv_date DESC, i.id DESC`).all()
      .map(i => ({ ...i, summary: inventorySummary(i.id) }));
  }
  function deleteOpenInventory(invId, userId) {
    const inv = inventory(invId); assertOpen(inv);
    db.transaction(() => {
      q('DELETE FROM inventory_counts WHERE item_id IN (SELECT id FROM inventory_items WHERE inventory_id=?)').run(invId);
      q('DELETE FROM inventory_items WHERE inventory_id=?').run(invId);
      q('DELETE FROM inventories WHERE id=?').run(invId);
      audit('inventory', invId, 'delete_open', { name: inv.name, date: inv.inv_date }, null, userId);
    })();
  }

  // ---------- izvještaji ----------
  function stockReport(locationId) {
    const rows = articles({ locationId }).filter(a => a.active);
    const byCat = new Map();
    let total = 0, unpriced = 0, negative = 0;
    for (const a of rows) {
      const k = a.category || 'Bez kategorije';
      if (!byCat.has(k)) byCat.set(k, { category: k, articles: 0, value_cents: 0, unpriced: 0 });
      const c = byCat.get(k); c.articles++;
      if (a.purchase_price_e4 == null) { c.unpriced++; unpriced++; }
      else if (a.stock_e4 > 0) { c.value_cents += a.value_cents; total += a.value_cents; }
      if (a.stock_e4 < 0) negative++;
    }
    return { total_cents: total, articles: rows.length, unpriced, negative, categories: [...byCat.values()], rows };
  }
  function auditLog(limit = 300) {
    return q(`SELECT a.*, u.name AS user FROM audit_log a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT ?`).all(Math.min(limit, 2000));
  }
  function setting(key) { const r = q('SELECT value FROM settings WHERE key=?').get(key); return r ? JSON.parse(r.value) : null; }

  return {
    InvError, defaultLocation, locations, location, addLocation, categories, saveCategory, deleteCategory,
    bookStock, articles, article, createArticle, updateArticle, addPackaging, deletePackaging,
    addMovement, movements, seedIfEmpty, importRemaris,
    inventory, createInventory, inventoryItems, inventorySummary, addCount, setCount, deleteCount, clearCount, setItemNote, refreshExpected,
    closeInventory, correctItem, inventories, deleteOpenInventory, stockReport, auditLog, setting, audit, nextCodeForSeed: nextCode,
  };
}

module.exports = { createService, InvError };
