// Uvoz prodaje iz CSV-a: prepoznavanje separatora, čitanje s navodnicima i mapiranje stupaca.
'use strict';
const D = require('./decimal');

function detectDelimiter(text) {
  const first = text.split(/\r?\n/).find(l => l.trim()) || '';
  const counts = [';', ',', '\t', '|'].map(d => [d, first.split(d).length - 1]).sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ';';
}
/** CSV → niz redaka (niz ćelija). Podržava navodnike, "" unutar navodnika i nove retke u ćeliji. */
function parseCsv(text, delim) {
  text = String(text).replace(/^﻿/, '');
  delim = delim || detectDelimiter(text);
  const rows = []; let row = [], cell = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false; } else cell += c; continue; }
    if (c === '"' && cell === '') inQ = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); cell = ''; if (row.some(x => x.trim())) rows.push(row); row = []; }
    else cell += c;
  }
  row.push(cell); if (row.some(x => x.trim())) rows.push(row);
  return { delimiter: delim, rows };
}
/** "9.10.2026", "09.10.2026. 14:30", "2026-10-09", "2026-10-09T14:30" → "2026-10-09" (null ako nije datum) */
function parseDate(s) {
  s = String(s || '').trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return valid(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})/.exec(s) || /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (m) return valid(+m[3], +m[2], +m[1]);
  return null;
  function valid(y, mo, d) { const dt = new Date(Date.UTC(y, mo - 1, d)); return dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? dt.toISOString().slice(0, 10) : null; }
}
function moneyCents(s) {
  if (s == null || String(s).trim() === '') return null;
  const v = D.parseE4(String(s).replace(/EUR|€/gi, '').trim());
  if (v == null || Number.isNaN(v)) return NaN;
  return Number(D.divRound(BigInt(v), 100n));
}
/**
 * mapping: { date, code, name, qty, ref, price, total } = indeksi stupaca (ili null); header: ima li prvi red zaglavlje.
 * Vraća { lines, errors, period_from, period_to }.
 */
function mapRows(rows, mapping, { header = true } = {}) {
  const m = mapping || {};
  if (m.qty == null || (m.code == null && m.name == null)) throw new Error('Odaberi stupac s količinom i stupac sa šifrom ili nazivom artikla.');
  const lines = [], errors = [];
  const body = header ? rows.slice(1) : rows;
  body.forEach((r, i) => {
    const rowNo = i + (header ? 2 : 1);
    const get = k => (m[k] == null || m[k] === '' ? null : String(r[Number(m[k])] ?? '').trim());
    const line = { row: rowNo, code: get('code') || null, name: get('name') || '', qty: get('qty'), ref: get('ref') || null };
    if (m.date != null && m.date !== '') { line.date = parseDate(get('date')); if (!line.date) { errors.push({ row: rowNo, error: `Datum „${get('date')}” nije prepoznat (npr. 9.10.2026. ili 2026-10-09).` }); return; } }
    const pc = moneyCents(get('price')), tc = moneyCents(get('total'));
    if (Number.isNaN(pc) || Number.isNaN(tc)) { errors.push({ row: rowNo, error: 'Cijena ili iznos nije broj.' }); return; }
    line.price_cents = pc; line.total_cents = tc;
    const q = D.parseE4(line.qty);
    if (q == null || Number.isNaN(q)) { errors.push({ row: rowNo, error: `Količina „${line.qty ?? ''}” nije broj.` }); return; }
    if (!line.code && !line.name) { errors.push({ row: rowNo, error: 'Nema šifre ni naziva artikla.' }); return; }
    lines.push(line);
  });
  const dates = lines.map(l => l.date).filter(Boolean).sort();
  return { lines, errors, period_from: dates[0] || null, period_to: dates[dates.length - 1] || null };
}
/** Prijedlog mapiranja po nazivima stupaca. */
function guessMapping(headerRow) {
  const h = headerRow.map(x => String(x).toLowerCase());
  const find = re => { const i = h.findIndex(x => re.test(x)); return i >= 0 ? i : null; };
  return { date: find(/datum|date|vrijeme/), code: find(/šifra|sifra|code|kod|plu/), name: find(/artikl|naziv|name|proizvod/), qty: find(/količina|kolicina|kol\.?$|qty|quantity/),
    ref: find(/račun|racun|dokument|broj|transak|receipt|id$/), price: find(/cijena|price/), total: find(/ukupno|iznos|total|amount/) };
}

module.exports = { parseCsv, detectDelimiter, parseDate, mapRows, guessMapping, moneyCents };
