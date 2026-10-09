// Decimalni brojevi bez pomičnog zareza.
// Količine i cijene čuvaju se kao CIJELI brojevi s 4 decimale (×10 000), npr. 1,5 → 15000.
// Novčani iznosi (vrijednosti) čuvaju se u CENTIMA (×100).
// Zaokruživanje: pola od nule (0,005 → 0,01; −0,005 → −0,01).
'use strict';

const SCALE = 10000n; // 4 decimale

/** "1,5" | "1.5" | "1 234,5" | 1.5 → 15000 (int, ×10 000). Vraća null za prazno, NaN za neispravno. */
function parseE4(input) {
  if (input === null || input === undefined) return null;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return NaN;
    input = input.toFixed(6);
  }
  let s = String(input).trim().replace(/\s/g, '').replace(/ /g, '');
  if (s === '') return null;
  // hrvatski format s točkom tisućica: 1.234,56
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, '');
  s = s.replace(',', '.');
  const m = /^([+-])?(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) return NaN;
  const neg = m[1] === '-';
  const intPart = BigInt(m[2]);
  let frac = (m[3] || '');
  // zaokruži na 4 decimale (pola od nule)
  let extra = 0n;
  if (frac.length > 4) {
    const next = Number(frac[4]);
    frac = frac.slice(0, 4);
    if (next >= 5) extra = 1n;
  }
  frac = frac.padEnd(4, '0');
  let v = intPart * SCALE + BigInt(frac) + extra;
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) return NaN;
  return Number(neg ? -v : v);
}

/** Dijeljenje BigInt-a sa zaokruživanjem pola od nule. */
function divRound(num, den) {
  const neg = (num < 0n) !== (den < 0n);
  const a = num < 0n ? -num : num, b = den < 0n ? -den : den;
  let q = a / b; const r = a % b;
  if (r * 2n >= b) q += 1n;
  return neg ? -q : q;
}

/** Umnožak dvije vrijednosti ×10 000 → rezultat ×10 000 (npr. 3 gajbe × 24 kom). */
function mulE4(a, b) {
  return Number(divRound(BigInt(a) * BigInt(b), SCALE));
}

/** Količina (×10 000) × cijena (×10 000 EUR) → iznos u centima. */
function valueCents(qtyE4, priceE4) {
  if (qtyE4 == null || priceE4 == null) return null;
  return Number(divRound(BigInt(qtyE4) * BigInt(priceE4), 1000000n));
}

/** ×10 000 → "1,5" (hrvatski format, do 4 decimale, bez suvišnih nula). */
function formatE4(v, { minFrac = 0, maxFrac = 4 } = {}) {
  if (v == null || Number.isNaN(v)) return '';
  const neg = v < 0; let a = BigInt(Math.abs(v));
  const int = a / SCALE; let frac = (a % SCALE).toString().padStart(4, '0');
  frac = frac.slice(0, maxFrac).replace(/0+$/, '');
  while (frac.length < minFrac) frac += '0';
  const intStr = int.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return (neg ? '−' : '') + intStr + (frac ? ',' + frac : '');
}

/** centi → "1.234,56 €" */
function formatCents(c, { sign = false } = {}) {
  if (c == null || Number.isNaN(c)) return '';
  const neg = c < 0; const a = Math.abs(c);
  const int = Math.floor(a / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const s = int + ',' + String(a % 100).padStart(2, '0') + ' €';
  return (neg ? '−' : (sign && c > 0 ? '+' : '')) + s;
}

/** ×10 000 → "1,5" za CSV/Excel (bez točke tisućica). */
function csvE4(v) {
  if (v == null) return '';
  return formatE4(v).replace(/\./g, '').replace('−', '-');
}
function csvCents(c) {
  if (c == null) return '';
  const neg = c < 0; const a = Math.abs(c);
  return (neg ? '-' : '') + Math.floor(a / 100) + ',' + String(a % 100).padStart(2, '0');
}

module.exports = { parseE4, mulE4, valueCents, formatE4, formatCents, csvE4, csvCents, divRound, SCALE: 10000 };
