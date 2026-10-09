// CSV za Excel (hrvatske postavke): separator ";", decimalni zarez, UTF-8 s BOM-om.
'use strict';
const D = require('./decimal');

function cell(v) {
  if (v == null) return '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(,\d+)?$/.test(s)) s = "'" + s; // zaštita od formula u Excelu
  return /[;"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function toCsv(header, rows) {
  return '﻿' + [header, ...rows].map(r => r.map(cell).join(';')).join('\r\n') + '\r\n';
}
const hrDate = d => (d ? String(d).slice(0, 10).split('-').reverse().join('.') + '.' : '');
const KIND = { visak: 'višak', manjak: 'manjak', slaze_se: 'slaže se', neprebrojano: 'neprebrojano' };

function stockCsv(rows) {
  return toCsv(['Šifra', 'Artikl', 'Kategorija', 'Dobavljač', 'Jedinica', 'Knjižno stanje', 'Nabavna cijena bez PDV-a (EUR)', 'Vrijednost (EUR)', 'Min. zaliha', 'Ispod minimuma', 'Izvor cijene'],
    rows.map(a => [a.code, a.name, a.category, a.supplier, a.unit, D.csvE4(a.stock_e4), D.csvE4(a.purchase_price_e4), D.csvCents(a.value_cents), D.csvE4(a.min_qty_e4), a.below_min ? 'DA' : '', a.price_source]));
}
function inventoryCsv(inv, items) {
  return toCsv(['Inventura', 'Datum', 'Lokacija', 'Status', 'Šifra', 'Artikl', 'Kategorija', 'Jedinica', 'Očekivano (knjižno)', 'Prebrojano', 'Razlika', 'Vrsta', 'Nabavna cijena bez PDV-a (EUR)', 'Vrijednost razlike (EUR)', 'Napomena'],
    items.map(i => [inv.name, hrDate(inv.inv_date), inv.location, inv.status === 'zakljucena' ? 'zaključena' : 'u tijeku', i.code, i.name, i.category, i.unit,
      D.csvE4(i.expected_qty_e4), D.csvE4(i.counted_qty_e4), D.csvE4(i.diff_e4), KIND[i.kind], D.csvE4(i.price_e4), D.csvCents(i.diff_cents), i.note]));
}
function movementsCsv(rows, types) {
  return toCsv(['Datum', 'Vrsta', 'Šifra', 'Artikl', 'Količina', 'Jedinica', 'Cijena (EUR)', 'Razlog', 'Korisnik', 'Uneseno'],
    rows.map(m => [hrDate(m.movement_date), types[m.type]?.label || m.type, m.code, m.article, D.csvE4(m.qty_e4), m.unit, D.csvE4(m.unit_price_e4), m.reason, m.user, m.created_at]));
}
function categoriesCsv(cats) {
  return toCsv(['Kategorija', 'Broj artikala', 'Vrijednost (EUR)', 'Artikala bez cijene'], cats.map(c => [c.category, c.articles, D.csvCents(c.value_cents), c.unpriced]));
}
function historyCsv(invs) {
  return toCsv(['Inventura', 'Datum', 'Lokacija', 'Status', 'Prebrojano', 'Neprebrojano', 'Viškovi (EUR)', 'Manjkovi (EUR)', 'Neto razlika (EUR)', 'Zaključeno'],
    invs.map(i => [i.name, hrDate(i.inv_date), i.location, i.status === 'zakljucena' ? 'zaključena' : 'u tijeku', i.summary.counted, i.summary.uncounted,
      D.csvCents(i.summary.surplusCents), D.csvCents(i.summary.shortageCents), D.csvCents(i.summary.netCents), i.closed_at || '']));
}

module.exports = { toCsv, cell, stockCsv, inventoryCsv, movementsCsv, categoriesCsv, historyCsv };
