'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const D = require('../inventura/decimal');
const L = require('../inventura/logic');
const dbm = require('../inventura/db');
const { createService } = require('../inventura/service');
const { createAuth, hashPin, verifyPin } = require('../inventura/auth');
const C = require('../inventura/csv');
const { parseTextItems, decodePiece } = require('../inventura/remaris');

const SEED = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'inventura', 'seed', 'stanje-2026-10-09.json'), 'utf8'));
const e4 = s => D.parseE4(s);

function fresh(seed = false) {
  const db = dbm.open(':memory:');
  const svc = createService(db);
  db.prepare(`INSERT INTO users (name) VALUES ('Test')`).run();
  if (seed) svc.seedIfEmpty(SEED, 1);
  return { db, svc };
}
function simple() {
  const { db, svc } = fresh();
  const pivo = svc.createArticle({ code: 'P1', name: 'Pivo 0,5', unit: 'kom', purchase_price: '1,20', category: 'Pivo', min_qty: '24' }, 1);
  const vino = svc.createArticle({ code: 'V1', name: 'Vino', unit: 'l', purchase_price: '4,00', category: 'Vino' }, 1);
  const kava = svc.createArticle({ code: 'K1', name: 'Kava', unit: 'kg', purchase_price: '18,5', category: 'Kave' }, 1);
  svc.addMovement({ articleId: pivo, type: 'nabava', qty: '48', date: '2026-10-01' }, 1);
  svc.addMovement({ articleId: vino, type: 'nabava', qty: '10', date: '2026-10-01' }, 1);
  svc.addMovement({ articleId: kava, type: 'nabava', qty: '2', date: '2026-10-01' }, 1);
  const loc = svc.defaultLocation().id;
  return { db, svc, pivo, vino, kava, loc };
}

// ---------- decimalni brojevi ----------
test('parsiranje hrvatskih brojeva bez pomičnog zareza', () => {
  assert.equal(e4('1,5'), 15000);
  assert.equal(e4('1.234,56'), 12345600);
  assert.equal(e4('0,33'), 3300);
  assert.equal(e4('-1,0844'), -10844);
  assert.equal(e4('2,00005'), 20001); // zaokruživanje na 4 decimale
  assert.equal(e4(''), null);
  assert.ok(Number.isNaN(e4('abc')));
  assert.ok(Number.isNaN(e4('1,2,3')));
  assert.equal(D.valueCents(e4('3'), e4('0,1')), 30); // 3 × 0,10 € = 0,30 € (bez greške 0,30000000000000004)
  assert.equal(D.valueCents(e4('0,333'), e4('1')), 33);
  assert.equal(D.valueCents(e4('-0,005'), e4('1')), -1); // pola od nule
  assert.equal(D.formatCents(123456), '1.234,56 €');
  assert.equal(D.formatE4(e4('-2,5')), '−2,5');
});

// ---------- izračun razlike ----------
test('razlika = prebrojano − očekivano (višak/manjak/neprebrojano)', () => {
  assert.equal(L.difference(e4('10'), e4('12')), e4('2'));
  assert.equal(L.diffKind(L.difference(e4('10'), e4('12'))), 'visak');
  assert.equal(L.diffKind(L.difference(e4('10'), e4('7,5'))), 'manjak');
  assert.equal(L.difference(e4('10'), e4('7,5')), e4('-2,5'));
  assert.equal(L.diffKind(L.difference(e4('10'), e4('10'))), 'slaze_se');
  assert.equal(L.difference(e4('10'), null), null);
  assert.equal(L.diffKind(null), 'neprebrojano');
  assert.equal(L.difference(e4('-2'), e4('0')), e4('2')); // negativno knjižno stanje
});

// ---------- konverzija pakiranja i jedinica ----------
test('konverzija pakiranja i jedinica u osnovnu jedinicu', () => {
  assert.equal(L.toBaseQty({ qtyE4: e4('3'), packagingQtyE4: e4('24') }, 'kom'), e4('72')); // 3 gajbe × 24
  assert.equal(L.toBaseQty({ qtyE4: e4('2,5'), packagingQtyE4: e4('0,7') }, 'l'), e4('1,75')); // 2,5 boce × 0,7 l
  assert.equal(L.toBaseQty({ qtyE4: e4('750'), unit: 'ml' }, 'l'), e4('0,75'));
  assert.equal(L.toBaseQty({ qtyE4: e4('3'), unit: 'dl' }, 'l'), e4('0,3'));
  assert.equal(L.toBaseQty({ qtyE4: e4('250'), unit: 'g' }, 'kg'), e4('0,25'));
  assert.equal(L.toBaseQty({ qtyE4: e4('1,5'), unit: 'l' }, 'l'), e4('1,5'));
  assert.throws(() => L.toBaseQty({ qtyE4: e4('1'), unit: 'kg' }, 'l'), /nisu usporedive/);
  assert.throws(() => L.toBaseQty({ qtyE4: e4('1'), unit: 'kom' }, 'kg'), /nisu usporedive/);
  assert.throws(() => L.toBaseQty({ qtyE4: e4('1'), packagingQtyE4: 0 }, 'kom'), /pozitivan/);
});

// ---------- vrijednost ----------
test('vrednovanje zaliha i razlika po nabavnoj cijeni bez PDV-a', () => {
  const { svc, pivo, loc } = simple();
  const st = svc.stockReport(loc);
  // 48 × 1,20 + 10 × 4,00 + 2 × 18,50 = 57,60 + 40 + 37 = 134,60
  assert.equal(st.total_cents, 13460);
  const vino = st.categories.find(c => c.category === 'Vino');
  assert.equal(vino.value_cents, 4000);
  const inv = svc.createInventory({ date: '2026-10-09' }, 1);
  const it = svc.inventoryItems(inv).find(i => i.article_id === pivo);
  svc.addCount(it.id, { qty: '45' }, 1);
  const s = svc.inventorySummary(inv);
  assert.equal(s.shortageCents, -360); // 3 × 1,20
  assert.equal(s.netCents, -360);
  assert.equal(s.counted, 1); assert.equal(s.uncounted, 2);
});

// ---------- neispravan / negativan unos ----------
test('odbija neispravan i negativan unos', () => {
  const { svc, pivo, vino } = simple();
  assert.throws(() => svc.createArticle({ name: '', unit: 'kom' }, 1), /naziv/);
  assert.throws(() => svc.createArticle({ name: 'X', unit: 'boca' }, 1), /jedinicu/);
  assert.throws(() => svc.createArticle({ name: 'X', unit: 'kom', purchase_price: '-1' }, 1), /negativna/);
  assert.throws(() => svc.createArticle({ name: 'X', unit: 'kom', purchase_price: 'skupo' }, 1), /broj/);
  assert.throws(() => svc.createArticle({ name: 'X', unit: 'kom', vat_rate: 22 }, 1), /PDV/);
  assert.throws(() => svc.createArticle({ code: 'P1', name: 'Dupli', unit: 'kom' }, 1), /šifrom/);
  assert.throws(() => svc.addMovement({ articleId: pivo, type: 'otpis', qty: '-2', reason: 'x' }, 1), /pozitivnu/);
  assert.throws(() => svc.addMovement({ articleId: pivo, type: 'nabava', qty: '0' }, 1), /nula/);
  assert.throws(() => svc.addMovement({ articleId: pivo, type: 'pocetno', qty: '5' }, 1), /nedopuštena/);
  assert.throws(() => svc.addMovement({ articleId: pivo, type: 'otpis', qty: '1' }, 1), /razlog/);
  assert.throws(() => svc.addMovement({ articleId: vino, type: 'nabava', qty: '1', unit: 'kg' }, 1), /nisu usporedive/);
  assert.throws(() => svc.addPackaging(pivo, { name: 'Gajba', qty: '0' }, 1), /pozitivan/);
  assert.throws(() => svc.updateArticle(vino, { unit: 'kg' }, 1), /Jedinica se ne može/);
  const inv = svc.createInventory({ date: '2026-10-09' }, 1);
  const it = svc.inventoryItems(inv)[0];
  assert.throws(() => svc.addCount(it.id, { qty: '-1' }, 1), /negativna/);
  assert.throws(() => svc.addCount(it.id, { qty: 'pet' }, 1), /ispravan broj/);
  assert.throws(() => svc.addCount(it.id, { qty: '' }, 1), /Upiši količinu/);
  assert.throws(() => svc.createInventory({ date: '2026-10-10' }, 1), /već postoji inventura u tijeku/);
  assert.throws(() => svc.createInventory({ date: '9.10.2026' }, 1), /Datum/);
});

test('promjene zaliha: predznak, korekcija, pakiranje', () => {
  const { svc, pivo, loc } = simple();
  const gajba = svc.addPackaging(pivo, { name: 'Gajba 24', qty: '24' }, 1);
  svc.addMovement({ articleId: pivo, type: 'nabava', qty: '2', packagingId: gajba, unitPrice: '1,30' }, 1);
  assert.equal(svc.bookStock(pivo, loc), e4('96'));
  assert.equal(svc.article(pivo).purchase_price_e4, e4('1,30')); // zadnja nabavna cijena
  svc.addMovement({ articleId: pivo, type: 'lom', qty: '1' }, 1);
  svc.addMovement({ articleId: pivo, type: 'interno', qty: '2' }, 1);
  svc.addMovement({ articleId: pivo, type: 'otpis', qty: '3', reason: 'istekao rok' }, 1);
  svc.addMovement({ articleId: pivo, type: 'korekcija', qty: '-4', reason: 'greška unosa' }, 1);
  assert.equal(svc.bookStock(pivo, loc), e4('86'));
  const mv = svc.movements({ articleId: pivo });
  assert.ok(mv.every(m => m.user === 'Test'));
  assert.equal(mv.find(m => m.type === 'otpis').reason, 'istekao rok');
});

// ---------- nepotpuna inventura ----------
test('nepotpuna inventura: spremanje u tijeku i zaključivanje samo uz potvrdu', () => {
  const { svc, pivo, vino, kava, loc } = simple();
  const inv = svc.createInventory({ date: '2026-10-09' }, 1);
  const items = svc.inventoryItems(inv);
  const ip = items.find(i => i.article_id === pivo);
  const gajba = svc.addPackaging(pivo, { name: 'Gajba', qty: '24' }, 1);
  svc.addCount(ip.id, { qty: '1', packagingId: gajba }, 1); // 24
  svc.addCount(ip.id, { qty: '20' }, 1); // + 20 = 44
  assert.equal(svc.inventoryItems(inv).find(i => i.id === ip.id).counted_qty_e4, e4('44'));
  const iv = items.find(i => i.article_id === vino);
  svc.addCount(iv.id, { qty: '10500', unit: 'ml' }, 1); // 10,5 l
  assert.throws(() => svc.closeInventory(inv, {}, 1), /nije prebrojano/);
  assert.equal(svc.inventory(inv).status, 'u_tijeku');
  svc.closeInventory(inv, { allowUncounted: true }, 1);
  assert.equal(svc.bookStock(pivo, loc), e4('44'));
  assert.equal(svc.bookStock(vino, loc), e4('10,5'));
  assert.equal(svc.bookStock(kava, loc), e4('2')); // neprebrojano ostaje nepromijenjeno
  const after = svc.inventoryItems(inv);
  assert.equal(after.find(i => i.article_id === kava).kind, 'neprebrojano');
  assert.equal(after.find(i => i.article_id === pivo).diff_e4, e4('-4'));
  assert.equal(after.find(i => i.article_id === vino).kind, 'visak');
});

test('inventura bez ijednog prebrojanog artikla ne može se zaključiti', () => {
  const { svc } = simple();
  const inv = svc.createInventory({}, 1);
  assert.throws(() => svc.closeInventory(inv, { allowUncounted: true }, 1), /Nijedan artikl/);
});

// ---------- zaključivanje i povijest ----------
test('zaključena inventura je zaključana; ispravak samo s razlogom i čuva povijest', () => {
  const { db, svc, pivo, loc } = simple();
  const inv = svc.createInventory({ date: '2026-10-09' }, 1);
  for (const it of svc.inventoryItems(inv)) svc.setCount(it.id, { qty: it.article_id === pivo ? '40' : String(D.formatE4(it.expected_qty_e4)) }, 1);
  svc.closeInventory(inv, {}, 1);
  const it = svc.inventoryItems(inv).find(i => i.article_id === pivo);
  assert.throws(() => svc.addCount(it.id, { qty: '1' }, 1), /zaključena/);
  assert.throws(() => svc.setCount(it.id, { qty: '1' }, 1), /zaključena/);
  assert.throws(() => svc.deleteOpenInventory(inv, 1), /zaključena/);
  assert.throws(() => svc.refreshExpected(inv, 1), /zaključena/);
  assert.throws(() => svc.correctItem(it.id, { qty: '42', reason: '' }, 1), /razlog/);
  svc.correctItem(it.id, { qty: '42', reason: 'pronađena gajba u skladištu' }, 1);
  assert.equal(svc.bookStock(pivo, loc), e4('42'));
  const it2 = svc.inventoryItems(inv).find(i => i.article_id === pivo);
  assert.equal(it2.counted_qty_e4, e4('42'));
  assert.equal(it2.corrections.length, 1);
  assert.equal(it2.corrections[0].old_qty_e4, e4('40'));
  assert.equal(it2.corrections[0].new_qty_e4, e4('42'));
  // izvorni unosi i knjiženja ostaju
  assert.equal(it2.counts.length, 1);
  const types = svc.movements({ articleId: pivo }).map(m => m.type);
  assert.ok(types.includes('inventura') && types.includes('ispravak_inventure'));
  const log = svc.auditLog().map(a => a.action);
  assert.ok(log.includes('close') && log.includes('correction'));
  // nijedan zapis nije izbrisan
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM stock_movements WHERE article_id=?`).get(pivo).n, 3); // nabava + inventura + ispravak
});

test('promjena unosa dok je inventura u tijeku čuva stare unose kao obrisane', () => {
  const { db, svc } = simple();
  const inv = svc.createInventory({}, 1);
  const it = svc.inventoryItems(inv)[0];
  svc.addCount(it.id, { qty: '5' }, 1);
  svc.setCount(it.id, { qty: '7' }, 1);
  assert.equal(svc.inventoryItems(inv).find(i => i.id === it.id).counted_qty_e4, e4('7'));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM inventory_counts WHERE item_id=?').get(it.id).n, 2);
  svc.clearCount(it.id, 1);
  assert.equal(svc.inventoryItems(inv).find(i => i.id === it.id).counted_qty_e4, null);
});

test('očekivano stanje: snimka pri otvaranju, osvježavanje i knjiženja tijekom inventure', () => {
  const { svc, pivo, loc } = simple();
  const inv = svc.createInventory({}, 1);
  svc.addMovement({ articleId: pivo, type: 'nabava', qty: '24' }, 1); // dostava tijekom inventure
  let it = svc.inventoryItems(inv).find(i => i.article_id === pivo);
  assert.equal(it.expected_qty_e4, e4('48'));
  assert.equal(it.book_now_e4, e4('72'));
  svc.refreshExpected(inv, 1);
  it = svc.inventoryItems(inv).find(i => i.article_id === pivo);
  assert.equal(it.expected_qty_e4, e4('72'));
  svc.addCount(it.id, { qty: '70' }, 1);
  svc.closeInventory(inv, { allowUncounted: true }, 1);
  assert.equal(svc.bookStock(pivo, loc), e4('70'));
});

// ---------- Remaris ----------
test('početno stanje iz Remarisa: 113 artikala, količine i cijene', () => {
  const { svc, db } = fresh(true);
  const loc = svc.defaultLocation().id;
  assert.equal(db.prepare('SELECT COUNT(*) n FROM articles').get().n, 113);
  const coca = svc.articles({ search: 'coca cola zero' })[0];
  assert.equal(coca.code, '2006'); assert.equal(coca.unit, 'kom'); assert.equal(coca.stock_e4, e4('163'));
  const limun = svc.articles({ search: 'limun' }).find(a => a.name.toLowerCase().startsWith('limun'));
  assert.equal(limun.stock_e4, e4('-1,0844'));
  assert.equal(svc.articles().filter(a => a.purchase_price_e4 == null).length, 11);
  assert.equal(svc.seedIfEmpty(SEED, 1), false); // ne puni dvaput
  assert.ok(db.prepare(`SELECT COUNT(*) n FROM stock_movements WHERE type='pocetno'`).get().n === 113);
  // usklađenje: novi izvještaj iz Remarisa (prodano 10 Coca-Cola)
  const items = SEED.artikli.map(a => (a.sifra === '2006' ? { ...a, stanje: '153.0000' } : a));
  const prev = svc.importRemaris({ items, date: '2026-10-10' }, 1, { dryRun: true });
  assert.equal(prev.updated, 1);
  assert.equal(svc.bookStock(coca.id, loc), e4('163')); // probni prikaz ništa ne knjiži
  svc.importRemaris({ items, date: '2026-10-10' }, 1);
  assert.equal(svc.bookStock(coca.id, loc), e4('153'));
});

test('Remaris PDF: dekodiranje naziva i čitanje redaka', () => {
  assert.equal(decodePiece('3ULSUDYDN\u0003]D\u0003YUXüX\u0003þRNRODGX'), 'Pripravak za vruću čokoladu');
  assert.equal(decodePiece('Kava Zadužna kg'), 'Kava Zadužna kg');
  const els = [
    { page: 1, x: 16, y: 726, str: 'Šifra' }, { page: 1, x: 543, y: 726, str: 'Stanje' },
    { page: 1, x: 16, y: 700, str: 'Sokovi' },
    { page: 1, x: 16, y: 598, str: '2006' }, { page: 1, x: 96, y: 598, str: 'COCA COLA / ZERO 0,25l' }, { page: 1, x: 459, y: 598, str: 'Komad' }, { page: 1, x: 532, y: 598, str: '1.163,0000' },
    { page: 1, x: 96, y: 581, str: 'Limun' }, { page: 1, x: 469, y: 581, str: 'Kg' }, { page: 1, x: 537, y: 581, str: '-1,0844' },
    { page: 2, x: 16, y: 780, str: 'Skladište: Glavno' },
    { page: 2, x: 16, y: 40, str: '09.10.2026' },
  ];
  const r = parseTextItems(els);
  assert.equal(r.items.length, 2);
  assert.deepEqual(r.items[0], { sifra: '2006', naziv: 'COCA COLA / ZERO 0,25l', kategorija: 'Sokovi', jedinica: 'komad', stanje: '1163.0000' });
  assert.equal(r.items[1].sifra, null); assert.equal(r.items[1].stanje, '-1.0844');
  assert.equal(r.datum, '2026-10-09');
});

test('stvarni Remaris PDF (ako postoji lokalno) daje isto što i početno stanje', { skip: !process.env.REMARIS_PDF }, async () => {
  const { parsePdf } = require('../inventura/remaris');
  const r = await parsePdf(fs.readFileSync(process.env.REMARIS_PDF));
  assert.equal(r.items.length, SEED.artikli.length);
  r.items.forEach((it, i) => { assert.equal(it.naziv, SEED.artikli[i].naziv); assert.equal(it.kategorija, SEED.artikli[i].kategorija); assert.equal(e4(it.stanje), e4(SEED.artikli[i].stanje)); });
});

// ---------- CSV ----------
test('CSV za Excel: BOM, točka-zarez, decimalni zarez, zaštita formula', () => {
  const { svc, loc } = simple();
  const csv = C.stockCsv(svc.stockReport(loc).rows);
  assert.ok(csv.startsWith('﻿Šifra;Artikl;'));
  assert.ok(csv.includes('P1;Pivo 0,5;Pivo;;kom;48;1,2;57,60;24;;'));
  assert.equal(C.cell('=SUM(A1)'), "'=SUM(A1)");
  assert.equal(C.cell('-12,5'), '-12,5');
  assert.equal(C.cell('a;b'), '"a;b"');
});

// ---------- prijava ----------
test('PIN: hash, prijava, blokada nakon pogrešnih pokušaja, prvo postavljanje', () => {
  const h = hashPin('1234');
  assert.ok(verifyPin('1234', h)); assert.ok(!verifyPin('1235', h)); assert.ok(!h.includes('1234$'));
  const db = dbm.open(':memory:');
  const a = createAuth(db, { adminPin: '9999' });
  assert.equal(a.mode(), 'setup');
  assert.equal(a.login('1234', 'ip1').status, 409);
  assert.equal(a.setup({ adminPin: '0000', newPin: '4321' }, 'ip1').status, 401);
  assert.equal(a.setup({ adminPin: '9999', newPin: '12' }, 'ip1').status, 400);
  assert.ok(a.setup({ adminPin: '9999', newPin: '4321', name: 'Dražen' }, 'ip1').ok);
  assert.equal(a.mode(), 'db');
  assert.equal(a.setup({ adminPin: '9999', newPin: '5555' }, 'ip1').status, 409); // ne može ponovno
  assert.ok(a.login('4321', 'ip2').ok);
  for (let i = 0; i < 8; i++) assert.equal(a.login('0000', 'ip3').status, 401);
  assert.equal(a.login('4321', 'ip3').status, 429); // blokirano i s ispravnim PIN-om
  assert.ok(a.login('4321', 'ip4').ok);
  const e = createAuth(dbm.open(':memory:'), { envPin: '777777' });
  assert.equal(e.mode(), 'env'); assert.ok(e.login('777777', 'x').ok); assert.equal(e.login('777778', 'x').status, 401);
});

// ---------- migracije ----------
test('migracije se izvode samo jednom i ne brišu podatke', () => {
  const file = path.join(require('os').tmpdir(), `inv-mig-${process.pid}.db`);
  try {
    let db = dbm.open(file); createService(db).seedIfEmpty(SEED, null); db.close();
    db = dbm.open(file);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM schema_migrations').get().n, dbm.MIGRATIONS.length);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM articles').get().n, 113);
    db.close();
  } finally { for (const s of ['', '-wal', '-shm']) fs.rmSync(file + s, { force: true }); }
});

// ---------- glasovni unos ----------
test('glasovni unos: brojevi izgovoreni riječima i znamenkama', () => {
  const V = require('../inventura/public/voice');
  assert.equal(V.wordsToNumber(['dvadeset', 'četiri'].map(V.norm)), 24);
  assert.equal(V.wordsToNumber(['jedan', 'i', 'pol']), 1.5);
  assert.equal(V.wordsToNumber(['dva', 'zarez', 'pet']), 2.5);
  assert.equal(V.wordsToNumber(['sto', 'dvadeset']), 120);
  assert.equal(V.wordsToNumber(['dvije', 'tisuce', 'tristo']), 2300);
  assert.equal(V.wordsToNumber(['pola']), 0.5);
  assert.deepEqual(V.parseUtterance('Coca cola dvadeset četiri'), { query: 'coca cola', qty: 24, unit: null, pack: null });
  assert.deepEqual(V.parseUtterance('Jamnica dvije gajbe'), { query: 'jamnica', qty: 2, unit: null, pack: 'gajb' });
  assert.deepEqual(V.parseUtterance('limun jedan i pol kila'), { query: 'limun', qty: 1.5, unit: 'kg', pack: null });
  assert.deepEqual(V.parseUtterance('Coca-Cola 0,25 24'), { query: 'coca cola 0.25', qty: 24, unit: null, pack: null });
  assert.deepEqual(V.parseUtterance('kava 750 grama'), { query: 'kava', qty: 750, unit: 'g', pack: null });
  assert.equal(V.parseUtterance('samo naziv').qty, null);
});
test('glasovni unos: prepoznavanje artikla i pakiranja', () => {
  const V = require('../inventura/public/voice');
  const items = SEED.artikli.map((a, i) => ({ id: i, name: a.naziv, unit: 'kom', packagings: [] }));
  const top = n => V.matchArticles(V.parseUtterance(n).query, items)[0]?.item.name;
  assert.equal(top('coca cola zero 24'), 'COCA COLA / ZERO 0,25l');
  assert.equal(top('stella artois 10'), 'STELLA ARTOIS PIVO 0,33l');
  assert.equal(top('grejp dva'), SEED.artikli.find(a => /^grejp/i.test(a.naziv)).naziv);
  const art = { unit: 'kom', packagings: [{ id: 7, name: 'Gajba 24' }] };
  assert.deepEqual(V.resolveUnit({ pack: 'gajb' }, art), { packagingId: 7, label: 'Gajba 24' });
  assert.ok(V.resolveUnit({ pack: 'boc' }, art).error);
  assert.deepEqual(V.resolveUnit({ unit: 'l' }, { unit: 'kom' }), { unit: 'l', label: 'l' });
});
