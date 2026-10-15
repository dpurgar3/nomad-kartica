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
  assert.equal(e4('0.008'), 80); // točka bez zareza je decimalna točka, ne tisućice
  assert.equal(e4('1.234'), 12340);
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

test('glasovni unos: veličina iz naziva nije količina (ožujsko 0,33 deset)', () => {
const V = require('../inventura/public/voice');
const items = SEED.artikli.map((a, i) => ({ id: i, name: a.naziv, unit: 'kom', packagings: [] }));
const P = t => { const r = V.parseForItems(t, items); return [r.candidates[0]?.item.name, r.qty]; };
assert.deepEqual(P('pivo ožujsko 0,33 10'), ['OŽUJSKO PIVO 0,33l', 10]);
assert.deepEqual(P('Pivo Ožujsko 0,33 deset'), ['OŽUJSKO PIVO 0,33l', 10]);
assert.deepEqual(P('pivo ožujsko 0 33 10'), ['OŽUJSKO PIVO 0,33l', 10]);
assert.deepEqual(P('pivo ožujsko 033 10'), ['OŽUJSKO PIVO 0,33l', 10]);
assert.deepEqual(P('pivo ožujsko nula trideset tri deset'), ['OŽUJSKO PIVO 0,33l', 10]);
assert.deepEqual(P('ožujsko 0,33 l 10'), ['OŽUJSKO PIVO 0,33l', 10]);
assert.deepEqual(P('ožujsko trideset tri deset'), ['OŽUJSKO PIVO 0,33l', 10]);
assert.deepEqual(P('pivo ožujsko 033'), ['OŽUJSKO PIVO 0,33l', null]); // količina nije izgovorena, ne 33
assert.deepEqual(P('pivo ožujsko 0 33'), ['OŽUJSKO PIVO 0,33l', null]);
assert.deepEqual(P('pivo ožujsko 0,5 24'), ['OŽUJSKO PIVO 0,50l', 24]);
assert.deepEqual(P('pivo ožujsko nula pet dvadeset četiri'), ['OŽUJSKO PIVO 0,50l', 24]);
assert.deepEqual(P('coca cola zero 24'), ['COCA COLA / ZERO 0,25l', 24]);
assert.deepEqual(P('stella artois 10'), ['STELLA ARTOIS PIVO 0,33l', 10]);
assert.equal(V.parseUtterance('ožujsko 033').qty, null);
});

test('glasovni unos: strani nazivi po izgovoru (sinar, koka kola, džek denijels)', () => {
const V = require('../inventura/public/voice');
const items = SEED.artikli.map((a, i) => ({ id: i, name: a.naziv, unit: 'kom', packagings: [] }));
const top = t => V.parseForItems(t, items).candidates[0]?.item.name;
assert.equal(V.phon('cynar'), V.phon('sinar'));
assert.equal(V.phon('coca'), V.phon('koka'));
assert.equal(top('sinar 3'), 'Cynar Bitter');
assert.equal(top('koka kola zero 24'), 'COCA COLA / ZERO 0,25l');
assert.equal(top('šveps 8'), 'SCHWEPPES SOKOVI RAZNI 0,25 L.');
assert.equal(top('džek denijels 2'), "Jack Daniel's lit");
assert.equal(top('jegermajster 3'), 'Jagermeister lit');
assert.equal(top('henesi 1'), 'Hennessy lit');
assert.equal(top('stela artoa 10'), 'STELLA ARTOIS PIVO 0,33l');
assert.equal(V.parseForItems('telefon 2', items).candidates.length, 0);
});

// ======================= NORMATIVI, PRODAJA, UTROŠAK =======================
const { createConsumption } = require('../inventura/consumption');
const SC = require('../inventura/salescsv');
const { parseSalesItems } = require('../inventura/remaris');

function cafe() {
  const { db, svc } = fresh();
  const kava = svc.createArticle({ code: 'KAVA', name: 'Kava zrno', unit: 'kg', purchase_price: '20' }, 1);
  const mlijeko = svc.createArticle({ code: 'MLI', name: 'Mlijeko', unit: 'l', purchase_price: '1' }, 1);
  const secer = svc.createArticle({ code: 'SEC', name: 'Šećer vrećica', unit: 'kom', purchase_price: '0,02' }, 1);
  const sok = svc.createArticle({ code: '2006', name: 'Sok 0,25', unit: 'kom', purchase_price: '0,8' }, 1);
  const cons = createConsumption(db, svc);
  const espresso = cons.saveVersion({ sale_code: '1000', name: 'Espresso', valid_from: '2026-01-01', lines: [{ article_id: kava, qty: '8', unit: 'g' }, { article_id: secer, qty: '1' }] }, 1).recipeId;
  const bijela = cons.saveVersion({ sale_code: '1016', name: 'Kava s mlijekom', valid_from: '2026-01-01', lines: [{ sub_recipe_id: espresso, qty: '1' }, { article_id: mlijeko, qty: '0,15' }] }, 1).recipeId;
  return { db, svc, cons, kava, mlijeko, secer, sok, espresso, bijela, loc: svc.defaultLocation().id };
}
const sale = (code, name, qty, date, ref) => ({ code, name, qty, date, ref });

test('normativ: jedinice se preračunavaju, podnormativi se rastavljaju, gubitak pripreme', () => {
  const { cons, kava, mlijeko, secer, bijela } = cafe();
  const acc = new Map(); cons.explode(bijela, '2026-05-01', e4('10'), acc);
  assert.equal(acc.get(kava), e4('0,08')); // 10 × 8 g = 0,08 kg
  assert.equal(acc.get(mlijeko), e4('1,5'));
  assert.equal(acc.get(secer), e4('10'));
  const r = cons.saveVersion({ sale_code: '1100', name: 'Limunada', yield_loss_pct: '10', lines: [{ article_id: mlijeko, qty: '0,2' }] }, 1);
  const a2 = new Map(); cons.explode(r.recipeId, '2099-01-01', e4('10'), a2);
  assert.equal(a2.get(mlijeko), e4('2,2')); // 2 l + 10 % gubitka
  assert.equal(cons.portionCost(bijela, '2026-05-01'), 33); // 0,16 € kava + 0,02 € šećer + 0,15 € mlijeko
});

test('normativ: verzije čuvaju povijest, prodaja koristi verziju važeću na datum prodaje', () => {
  const { cons, db, kava, espresso } = cafe();
  cons.saveVersion({ recipeId: espresso, valid_from: '2026-06-01', lines: [{ article_id: kava, qty: '0,009' }] }, 1);
  assert.throws(() => cons.saveVersion({ recipeId: espresso, valid_from: '2026-06-01', lines: [{ article_id: kava, qty: '0,01' }] }, 1), /već postoji/);
  assert.equal(cons.versionAt(espresso, '2026-05-31').version, 1);
  assert.equal(cons.versionAt(espresso, '2026-06-01').version, 2);
  assert.equal(cons.versionAt(espresso, '2025-12-31'), null);
  const v1 = cons.recipeDetail(espresso).versions.find(v => v.version === 1);
  assert.equal(v1.lines.find(l => l.article_id === kava).qty_e4, e4('0,008')); // stara verzija nepromijenjena
  cons.importSales({ period_from: '2026-05-01', period_to: '2026-06-30', file_sha256: 'x1', source: 'CSV',
    lines: [sale('1000', 'Espresso', '100', '2026-05-15'), sale('1000', 'Espresso', '100', '2026-06-15')] }, 1);
  const t = cons.theoretical({ from: '2026-05-01', to: '2026-06-30' });
  assert.equal(t.articles.find(a => a.article_id === kava).qty_e4, e4('1,7')); // 100×0,008 + 100×0,009
  assert.equal(db.prepare('SELECT COUNT(*) n FROM recipe_versions WHERE recipe_id=?').get(espresso).n, 2);
});

test('normativ: kružne ovisnosti i neispravni sastojci se odbijaju', () => {
  const { cons, kava, espresso, bijela } = cafe();
  assert.throws(() => cons.saveVersion({ recipeId: espresso, valid_from: '2026-03-01', lines: [{ sub_recipe_id: bijela, qty: '1' }] }, 1), /Kružna/);
  assert.throws(() => cons.saveVersion({ recipeId: espresso, valid_from: '2026-03-01', lines: [{ sub_recipe_id: espresso, qty: '1' }] }, 1), /sam sebe/);
  assert.throws(() => cons.saveVersion({ recipeId: espresso, valid_from: '2026-03-01', lines: [{ article_id: kava, qty: '1', unit: 'l' }] }, 1), /nisu usporedive/);
  assert.throws(() => cons.saveVersion({ recipeId: espresso, valid_from: '2026-03-01', lines: [{ article_id: kava, qty: '0' }] }, 1), /pozitivan/);
  assert.throws(() => cons.saveVersion({ recipeId: espresso, valid_from: '2026-03-01', lines: [] }, 1), /barem jedan/);
  assert.throws(() => cons.saveVersion({ sale_code: '1000', name: 'Dupli', lines: [{ article_id: kava, qty: '1' }] }, 1), /već postoji/);
});

test('uvoz prodaje: deduplikacija datoteke, preklapanje razdoblja, storno i ponovni uvoz', () => {
  const { cons } = cafe();
  const base = { period_from: '2026-01-01', period_to: '2026-01-31', source: 'CSV', lines: [sale('1000', 'Espresso', '10')] };
  const r = cons.importSales({ ...base, file_sha256: 'A' }, 1);
  assert.throws(() => cons.importSales({ ...base, file_sha256: 'A' }, 1), /već uvezena/);
  assert.throws(() => cons.importSales({ ...base, file_sha256: 'B', period_from: '2026-01-15', period_to: '2026-02-15' }, 1), /preklapa/);
  assert.ok(cons.importSales({ ...base, file_sha256: 'B', period_from: '2026-02-01', period_to: '2026-02-28' }, 1).id);
  assert.throws(() => cons.stornoImport(r.id, '', 1), /razlog/);
  cons.stornoImport(r.id, 'pogrešna datoteka', 1);
  assert.equal(cons.salesImports().find(i => i.id === r.id).status, 'storniran'); // ostaje u povijesti
  assert.ok(cons.importSales({ ...base, file_sha256: 'A' }, 1).id); // nakon storna dopušteno
  assert.throws(() => cons.importSales({ ...base, file_sha256: 'C', period_from: '2026-03-01', period_to: '2026-03-31', lines: [sale('1000', 'Espresso', 'deset')] }, 1), /pogrešku/);
  assert.throws(() => cons.importSales({ ...base, file_sha256: 'D', period_from: '2026-03-01', period_to: '2026-03-31', reported_total_cents: 999, lines: [{ ...sale('1000', 'Espresso', '1'), total_cents: 180 }] }, 1), /ne odgovara/);
});

test('uvoz prodaje: ista stavka računa ne može se uvesti dvaput; povrat smanjuje utrošak', () => {
  const { cons, kava, sok } = cafe();
  cons.importSales({ period_from: '2026-04-01', period_to: '2026-04-01', file_sha256: 'R1', source: 'CSV',
    lines: [sale('1000', 'Espresso', '3', '2026-04-01', 'R-1'), sale('2006', 'Sok', '2', '2026-04-01', 'R-1')] }, 1);
  const dry = cons.importSales({ period_from: '2026-04-02', period_to: '2026-04-02', file_sha256: 'R2', source: 'CSV',
    lines: [sale('1000', 'Espresso', '1', '2026-04-02', 'R-1'), sale('1000', 'Espresso', '-1', '2026-04-02', 'R-2')] }, 1, { dryRun: true });
  assert.equal(dry.errors.length, 1); assert.match(dry.errors[0].error, /već uvezena/);
  cons.importSales({ period_from: '2026-04-02', period_to: '2026-04-02', file_sha256: 'R3', source: 'CSV', lines: [sale('1000', 'Espresso', '-1', '2026-04-02', 'R-2')] }, 1);
  const t = cons.theoretical({ from: '2026-04-01', to: '2026-04-30' });
  assert.equal(t.articles.find(a => a.article_id === kava).qty_e4, e4('0,016')); // 3 − 1 povrat = 2 espressa
  assert.equal(t.articles.find(a => a.article_id === sok).qty_e4, e4('2')); // bez normativa: 1 : 1 po šifri artikla
  const t2 = cons.theoretical({ from: '2026-04-02', to: '2026-04-30' });
  assert.equal(t2.excluded.length, 0); assert.equal(t2.imports.length, 1);
});

test('teorijski utrošak: prodaja bez normativa i uvoz koji samo djelomično pada u razdoblje', () => {
  const { cons } = cafe();
  cons.importSales({ period_from: '2026-01-01', period_to: '2026-01-31', file_sha256: 'P', source: 'PDF', lines: [sale('9999', 'Nepoznato piće', '5'), sale('1000', 'Espresso', '10')] }, 1);
  const t = cons.theoretical({ from: '2026-01-01', to: '2026-01-31' });
  assert.equal(t.unmatched.length, 1); assert.equal(t.unmatched[0].name, 'Nepoznato piće');
  const part = cons.theoretical({ from: '2026-01-10', to: '2026-01-31' });
  assert.equal(part.imports.length, 0); assert.equal(part.excluded.length, 1); assert.equal(part.articles.length, 0);
});

test('kontrola utroška: stvarni = početno + nabava − završno; odstupanje odvojeno od otpisa', () => {
  const { cons, svc, kava, mlijeko, loc } = cafe();
  // početna inventura 31.1.: kava 2 kg, mlijeko 10 l
  const i1 = svc.createInventory({ date: '2026-01-31' }, 1);
  for (const it of svc.inventoryItems(i1)) if (it.article_id === kava) svc.setCount(it.id, { qty: '2' }, 1); else if (it.article_id === mlijeko) svc.setCount(it.id, { qty: '10' }, 1);
  svc.closeInventory(i1, { allowUncounted: true }, 1);
  svc.addMovement({ articleId: kava, type: 'nabava', qty: '5', date: '2026-02-10' }, 1);
  svc.addMovement({ articleId: kava, type: 'otpis', qty: '0,2', reason: 'prolivena', date: '2026-02-12' }, 1);
  cons.importSales({ period_from: '2026-02-01', period_to: '2026-02-28', file_sha256: 'F', source: 'CSV', lines: [sale('1016', 'Kava s mlijekom', '500')] }, 1);
  const i2 = svc.createInventory({ date: '2026-02-28' }, 1);
  for (const it of svc.inventoryItems(i2)) if (it.article_id === kava) svc.setCount(it.id, { qty: '2,5' }, 1); else if (it.article_id === mlijeko) svc.setCount(it.id, { qty: '30' }, 1);
  svc.closeInventory(i2, { allowUncounted: true }, 1);
  const c = cons.compare({ locationId: loc, startId: String(i1), endId: String(i2) });
  const k = c.rows.find(r => r.article_id === kava);
  assert.equal(k.actual_e4, e4('4,5'));        // 2 + 5 − 2,5
  assert.equal(k.theoretical_e4, e4('4'));     // 500 × 8 g
  assert.equal(k.losses_e4, e4('0,2'));
  assert.equal(k.unexplained_e4, e4('0,3'));   // 4,5 − 4 − 0,2
  assert.equal(k.unexplained_cents, 600);      // 0,3 kg × 20 €
  assert.equal(k.unexplained_pct_e4, e4('7,5'));
  const m = c.rows.find(r => r.article_id === mlijeko);
  assert.equal(m.actual_e4, e4('-20'));        // nabava mlijeka nije upisana → negativni stvarni utrošak
  assert.ok(c.warnings.some(w => /Nabava/.test(w)));
  assert.throws(() => cons.compare({ locationId: loc, startId: String(i2), endId: String(i1) }), /nakon/);
});

test('CSV prodaje: separator, navodnici, datumi, mapiranje i pogreške po retku', () => {
  const csv = '﻿Datum;Račun;Šifra;Artikl;Količina;Iznos\r\n9.10.2026. 14:30;R-1;1000;"Espresso; kratki";2;3,60\r\n2026-10-10;R-2;1016;Kava;1,5;3,60\r\n31.2.2026;R-3;1000;Espresso;1;1,80\r\n10.10.2026;R-4;1000;Espresso;x;1,80\r\n';
  const { delimiter, rows } = SC.parseCsv(csv);
  assert.equal(delimiter, ';'); assert.equal(rows.length, 5); assert.equal(rows[1][3], 'Espresso; kratki');
  const map = SC.guessMapping(rows[0]);
  assert.deepEqual([map.date, map.ref, map.code, map.name, map.qty, map.total], [0, 1, 2, 3, 4, 5]);
  const r = SC.mapRows(rows, map);
  assert.equal(r.lines.length, 2); assert.equal(r.errors.length, 2);
  assert.equal(r.errors[0].row, 4); assert.match(r.errors[0].error, /Datum/);
  assert.match(r.errors[1].error, /Količina/);
  assert.equal(r.period_from, '2026-10-09'); assert.equal(r.period_to, '2026-10-10');
  assert.equal(r.lines[0].total_cents, 360);
  assert.equal(SC.parseDate('2026-02-30'), null);
});

test('Remaris PDF „Promet po artiklima”: razdoblje, stavke i ukupno', () => {
  const els = [
    { page: 1, x: 200, y: 700, str: 'za razdoblje 1.1.2026. - 30.9.2026.' },
    { page: 1, x: 39, y: 565, str: 'Kave' },
    { page: 1, x: 31, y: 548, str: '1000' }, { page: 1, x: 81, y: 548, str: '(635(662\u0003.$9$\u0003.5$û$' }, { page: 1, x: 334, y: 548, str: '2.680,00' }, { page: 1, x: 410, y: 548, str: '1,80 EUR' }, { page: 1, x: 485, y: 548, str: '4.824,00 EUR' },
    { page: 1, x: 31, y: 531, str: '1000' }, { page: 1, x: 81, y: 531, str: 'KAVA ESPRESSO' }, { page: 1, x: 354, y: 531, str: '-1,00' }, { page: 1, x: 410, y: 531, str: '1,80 EUR' }, { page: 1, x: 505, y: 531, str: '-1,80 EUR' },
    { page: 1, x: 300, y: 300, str: 'Ukupno artikli: 4.822,20 EUR' },
  ];
  const r = parseSalesItems(els);
  assert.equal(r.period_from, '2026-01-01'); assert.equal(r.period_to, '2026-09-30'); assert.equal(r.total_cents, 482220);
  assert.equal(r.lines.length, 2);
  assert.deepEqual(r.lines[0], { code: '1000', name: 'ESPRESSO KAVA KRAĆA', category: 'Kave', qty: '2680.00', price_cents: 180, total_cents: 482400 });
  assert.equal(r.lines[1].qty, '-1.00'); assert.equal(r.lines[1].total_cents, -180);
});

test('stvarni Remaris normativi i promet: uvoz bez pogreške i zbroj jednak izvještaju', { skip: !process.env.REMARIS_PROMET }, async () => {
  const { parseSalesPdf } = require('../inventura/remaris');
  const { db, svc } = fresh(true);
  const cons = createConsumption(db, svc);
  assert.ok(cons.seedRecipesIfEmpty(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'inventura', 'seed', 'normativi-remaris.json'), 'utf8')), 1));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM recipes').get().n, 127);
  const buf = fs.readFileSync(process.env.REMARIS_PROMET);
  const p = await parseSalesPdf(buf);
  const r = cons.importSales({ period_from: p.period_from, period_to: p.period_to, lines: p.lines, reported_total_cents: p.total_cents, file_sha256: cons.sha256(buf), source: 'PDF' }, 1);
  assert.equal(r.total_cents, 12488054);
  const t = cons.theoretical({ from: '2026-01-01', to: '2026-09-30' });
  const kava = t.articles.find(a => a.name.startsWith('Kava Zadužna'));
  assert.ok(kava.qty_e4 > e4('100') && kava.qty_e4 < e4('200'), 'kava ' + kava.qty_e4);
});
