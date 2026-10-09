// Poslovna pravila inventure — čista logika, bez baze i bez sučelja.
'use strict';
const D = require('./decimal');

// Mjerne jedinice. Jedinice iste "dimenzije" mogu se preračunavati; različite (npr. kg i l) ne smiju.
// factorE4 = koliko osnovnih jedinica dimenzije sadrži 1 ova jedinica (×10 000).
const UNITS = {
  kom: { name: 'komad', dim: 'count', factorE4: 10000 },
  l: { name: 'litra', dim: 'volume', factorE4: 10000 },
  ml: { name: 'mililitra', dim: 'volume', factorE4: 10 },     // 0,001 l
  dl: { name: 'decilitra', dim: 'volume', factorE4: 1000 },   // 0,1 l
  kg: { name: 'kilogram', dim: 'mass', factorE4: 10000 },
  g: { name: 'gram', dim: 'mass', factorE4: 10 },             // 0,001 kg
};
// Remaris "UnitHeader" → naša jedinica
const REMARIS_UNITS = { komad: 'kom', kom: 'kom', litra: 'l', lit: 'l', l: 'l', kg: 'kg', kilogram: 'kg' };

const MOVEMENT_TYPES = {
  pocetno: { label: 'Početno stanje', sign: 0, manual: false },
  nabava: { label: 'Nabava (ulaz)', sign: +1, manual: true },
  otpis: { label: 'Otpis', sign: -1, manual: true },
  lom: { label: 'Razbijena / oštećena roba', sign: -1, manual: true },
  interno: { label: 'Interno korištenje', sign: -1, manual: true },
  korekcija: { label: 'Ručna korekcija (+/−)', sign: 0, manual: true },
  remaris: { label: 'Usklađenje sa stanjem iz Remarisa', sign: 0, manual: false },
  inventura: { label: 'Inventurna razlika', sign: 0, manual: false },
  ispravak_inventure: { label: 'Ispravak zaključene inventure', sign: 0, manual: false },
};

function unitInfo(code) {
  const u = UNITS[code];
  if (!u) throw new Error(`Nepoznata mjerna jedinica: ${code}`);
  return u;
}

/** Faktor (×10 000) za preračun 1 [from] u [to]; baca grešku ako jedinice nisu usporedive. */
function conversionFactorE4(from, to) {
  const a = unitInfo(from), b = unitInfo(to);
  if (a.dim !== b.dim) throw new Error(`Jedinice ${from} i ${to} nisu usporedive (nema definirane konverzije).`);
  return Number(D.divRound(BigInt(a.factorE4) * 10000n, BigInt(b.factorE4)));
}

/**
 * Preračun unosa u osnovnu jedinicu artikla.
 * entry: { qtyE4, unit?: 'kg'|'l'|..., packagingQtyE4?: (sadržaj jednog pakiranja u jedinici artikla) }
 */
function toBaseQty(entry, articleUnit) {
  const { qtyE4 } = entry;
  if (qtyE4 == null || Number.isNaN(qtyE4)) throw new Error('Količina nije ispravan broj.');
  if (entry.packagingQtyE4 != null) {
    if (!(entry.packagingQtyE4 > 0)) throw new Error('Pakiranje mora imati pozitivan sadržaj.');
    return D.mulE4(qtyE4, entry.packagingQtyE4);
  }
  const unit = entry.unit || articleUnit;
  if (unit === articleUnit) return qtyE4;
  return D.mulE4(qtyE4, conversionFactorE4(unit, articleUnit));
}

/** Razlika = fizički utvrđeno − očekivano. Pozitivno = višak, negativno = manjak. */
function difference(expectedE4, countedE4) {
  if (countedE4 == null) return null; // neprebrojano
  return countedE4 - (expectedE4 || 0);
}
function diffKind(diffE4) {
  if (diffE4 == null) return 'neprebrojano';
  if (diffE4 > 0) return 'visak';
  if (diffE4 < 0) return 'manjak';
  return 'slaze_se';
}

/** Validacija fizički prebrojene količine: broj, nije negativan. */
function validateCount(qtyE4) {
  if (qtyE4 == null) throw new Error('Upiši količinu.');
  if (Number.isNaN(qtyE4)) throw new Error('Količina nije ispravan broj (npr. 12 ili 1,5).');
  if (qtyE4 < 0) throw new Error('Prebrojana količina ne može biti negativna.');
  return qtyE4;
}

/** Validacija promjene zalihe; vraća količinu s ispravnim predznakom. */
function signedMovementQty(type, qtyE4) {
  const t = MOVEMENT_TYPES[type];
  if (!t || !t.manual) throw new Error('Nepoznata ili nedopuštena vrsta promjene.');
  if (qtyE4 == null || Number.isNaN(qtyE4)) throw new Error('Količina nije ispravan broj.');
  if (qtyE4 === 0) throw new Error('Količina ne može biti nula.');
  if (t.sign === 0) return qtyE4; // korekcija: korisnik zadaje predznak
  if (qtyE4 < 0) throw new Error('Za ovu vrstu promjene upiši pozitivnu količinu; predznak se postavlja sam.');
  return t.sign * qtyE4;
}

/** Sažetak stavki inventure (za izvještaj). items: [{expectedE4, countedE4, priceE4}] */
function summarize(items) {
  const s = { total: items.length, counted: 0, uncounted: 0, surplusCount: 0, shortageCount: 0, surplusCents: 0, shortageCents: 0, netCents: 0, countedValueCents: 0, unpricedDiffs: 0 };
  for (const it of items) {
    const d = difference(it.expectedE4, it.countedE4);
    if (d == null) { s.uncounted++; continue; }
    s.counted++;
    const v = D.valueCents(d, it.priceE4);
    if (it.priceE4 == null && d !== 0) s.unpricedDiffs++;
    if (d > 0) { s.surplusCount++; s.surplusCents += v || 0; }
    if (d < 0) { s.shortageCount++; s.shortageCents += v || 0; }
    s.netCents += v || 0;
    s.countedValueCents += D.valueCents(it.countedE4, it.priceE4) || 0;
  }
  return s;
}

module.exports = { UNITS, REMARIS_UNITS, MOVEMENT_TYPES, conversionFactorE4, toBaseQty, difference, diffKind, validateCount, signedMovementQty, summarize };
