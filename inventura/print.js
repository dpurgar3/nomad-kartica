// Ispisna verzija inventure: zasebna, svijetla HTML stranica (A4) koja se pouzdano ispisuje
// i na mobitelu (bežični pisač preko sustavnog dijaloga za ispis ili "Spremi kao PDF").
'use strict';
const D = require('./decimal');

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hrDate = d => (d ? String(d).slice(0, 10).split('-').reverse().join('.') + '.' : '');
const KIND = { visak: 'višak', manjak: 'manjak', slaze_se: 'slaže se', neprebrojano: 'neprebrojano' };

/**
 * @param {object} inv  inventura (name, inv_date, location, status, closed_at, note)
 * @param {object[]} items stavke iz svc.inventoryItems
 * @param {object} summary iz svc.inventorySummary
 * @param {{mode?: 'lista'|'rezultat', blind?: boolean, only?: string, auto?: boolean, base?: string}} opt
 */
function inventoryPrintHtml(inv, items, summary, opt = {}) {
  const closed = inv.status === 'zakljucena';
  const mode = opt.mode === 'lista' || opt.mode === 'rezultat' ? opt.mode : (closed ? 'rezultat' : 'lista');
  const blind = mode === 'lista' && !!opt.blind;
  let rows = items;
  if (mode === 'rezultat' && opt.only === 'razlike') rows = rows.filter(i => i.kind === 'visak' || i.kind === 'manjak');

  const q = (v, unit) => (v == null ? '' : D.formatE4(v) + (unit ? ' ' + esc(unit) : ''));
  const cols = mode === 'lista'
    ? ['Šifra', 'Artikl', 'Jed.', ...(blind ? [] : ['Knjižno']), 'Prebrojano', 'Napomena']
    : ['Šifra', 'Artikl', 'Jed.', 'Knjižno', 'Prebrojano', 'Razlika', 'Vrijednost (EUR)'];
  const numCols = mode === 'lista' ? new Set(blind ? [] : [3]) : new Set([3, 4, 5, 6]);

  const body = []; let lastCat = null; let n = 0;
  for (const i of rows) {
    if (i.category !== lastCat) { lastCat = i.category; body.push(`<tr class="cat"><td colspan="${cols.length}">${esc(i.category || 'Bez kategorije')}</td></tr>`); }
    n++;
    const cells = mode === 'lista'
      ? [esc(i.code), esc(i.name), esc(i.unit), ...(blind ? [] : [q(i.expected_qty_e4)]), '', '']
      : [esc(i.code), esc(i.name) + (i.note ? `<div class="nt">${esc(i.note)}</div>` : ''), esc(i.unit), q(i.expected_qty_e4), q(i.counted_qty_e4),
        i.diff_e4 == null ? KIND[i.kind] || '' : (i.diff_e4 > 0 ? '+' : '') + D.formatE4(i.diff_e4),
        i.diff_cents == null ? '' : i.price_e4 == null ? 'bez cijene' : D.formatCents(i.diff_cents, { sign: true }).replace(' €', '')];
    body.push(`<tr>${cells.map((c, k) => `<td class="${numCols.has(k) ? 'num' : ''}${mode === 'lista' && cols[k] === 'Prebrojano' ? ' box' : ''}${mode === 'lista' && cols[k] === 'Napomena' ? ' box note' : ''}">${c}</td>`).join('')}</tr>`);
  }

  const sum = mode === 'rezultat' ? `<table class="sum"><tr>
      <td>Prebrojano<b>${summary.counted} / ${summary.total}</b></td>
      <td>Manjak (${summary.shortageCount})<b>${D.formatCents(summary.shortageCents)}</b></td>
      <td>Višak (${summary.surplusCount})<b>${D.formatCents(summary.surplusCents, { sign: true })}</b></td>
      <td>Neto razlika<b>${D.formatCents(summary.netCents, { sign: true })}</b></td></tr></table>
      ${summary.unpricedDiffs ? `<p class="small">${summary.unpricedDiffs} razlika nema nabavnu cijenu pa nisu uključene u vrijednost.</p>` : ''}` : '';

  const self = (o) => `?${new URLSearchParams({ mode, ...(blind ? { slijepo: '1' } : {}), ...(opt.only ? { only: opt.only } : {}), ...o })}`;
  const toolbar = `<div class="bar no-print">
      <button onclick="window.print()">🖨️ Ispiši</button>
      ${mode === 'lista' ? `<a href="${self({ slijepo: blind ? '' : '1' })}">${blind ? 'Prikaži knjižno stanje' : 'Sakrij knjižno (slijepo brojanje)'}</a>` : `<a href="${self({ only: opt.only === 'razlike' ? '' : 'razlike' })}">${opt.only === 'razlike' ? 'Svi artikli' : 'Samo razlike'}</a>`}
      <a href="?${new URLSearchParams({ mode: mode === 'lista' ? 'rezultat' : 'lista' })}">${mode === 'lista' ? 'Rezultat inventure' : 'Lista za brojanje'}</a>
      <a href="${esc(opt.base || '/inventura/')}">← Natrag</a>
      <p>Pritisni <b>🖨️ Ispiši</b> tek kad vidiš tablicu. Ako se prozor za ispis ne otvori: u izborniku preglednika (⋮) odaberi <b>Dijeli → Ispis</b> (Chrome) ili <b>Ispis/PDF</b> (Samsung Internet), pa odaberi bežični pisač ili „Spremi kao PDF”.</p>
    </div>`;

  return `<!doctype html><html lang="hr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow">
<title>${esc(mode === 'lista' ? 'Inventurna lista' : 'Inventura')} – ${esc(inv.name)}</title>
<style>
@page{size:A4;margin:12mm 10mm}
*{box-sizing:border-box}
html,body{margin:0;background:#fff;color:#000;font:11pt/1.3 Arial,Helvetica,sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.wrap{max-width:190mm;margin:0 auto;padding:12px}
h1{font-size:16pt;margin:0 0 2px} .meta{font-size:10pt;color:#333;margin-bottom:10px}
table{width:100%;border-collapse:collapse}
thead{display:table-header-group} tr{page-break-inside:avoid;break-inside:avoid}
th,td{border:1px solid #888;padding:4px 6px;text-align:left;vertical-align:top}
th{background:#e6e6e6;font-size:9pt;text-transform:uppercase}
td.num,th.num{text-align:right;white-space:nowrap}
td.box{min-width:28mm;height:9mm} td.note{min-width:40mm}
tr.cat td{background:#f2f2f2;font-weight:bold;font-size:10pt}
.nt{font-size:8.5pt;color:#444}
.tw{overflow-x:auto} td:first-child{white-space:nowrap}
.sum{margin:0 0 10px} .sum td{width:25%;font-size:9pt} .sum b{display:block;font-size:12pt}
.small{font-size:9pt} .sign{margin-top:18px;display:flex;gap:24px;flex-wrap:wrap;font-size:10pt} .sign div{flex:1;min-width:150px;border-top:1px solid #000;padding-top:3px}
.bar{position:sticky;top:0;background:#fffbe8;border-bottom:1px solid #d4af5a;padding:10px 12px;display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-size:14px}
.bar button,.bar a{font:inherit;padding:10px 14px;border-radius:8px;border:1px solid #8a6a2c;background:#fff;color:#000;text-decoration:none}
.bar button{background:#d4af5a;font-weight:bold;border-color:#d4af5a}
.bar p{flex-basis:100%;margin:2px 0 0;font-size:12px;color:#444}
@media print{.no-print{display:none!important}.tw{overflow:visible}.wrap{padding:0;max-width:none}}
</style></head><body>
${toolbar}
<div class="wrap">
  <h1>${mode === 'lista' ? 'Inventurna lista' : 'Inventura – rezultat'}: ${esc(inv.name)}</h1>
  <div class="meta">NOMAd Caffe Bar · Datum: ${hrDate(inv.inv_date)} · Lokacija: ${esc(inv.location)} · ${closed ? 'Zaključena ' + esc(String(inv.closed_at || '').slice(0, 16)) : 'U tijeku'} · Artikala: ${n}${inv.note ? ' · ' + esc(inv.note) : ''}${mode === 'rezultat' ? ' · Vrijednosti po nabavnoj cijeni bez PDV-a' : ''}</div>
  ${sum}
  <div class="tw"><table><thead><tr>${cols.map((c, k) => `<th class="${numCols.has(k) ? 'num' : ''}">${c}</th>`).join('')}</tr></thead>
  <tbody>${body.join('') || `<tr><td colspan="${cols.length}">Nema artikala.</td></tr>`}</tbody></table></div>
  <div class="sign"><div>Popisao/la (ime, potpis)</div><div>Kontrolirao/la (ime, potpis)</div><div>Datum i vrijeme</div></div>
</div>
${opt.auto ? '<script>addEventListener("load",()=>{if(/Android|iPhone|iPad|Mobile/i.test(navigator.userAgent))return;(document.fonts?document.fonts.ready:Promise.resolve()).then(()=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(()=>{try{window.print()}catch(e){}},300))))})</script>' : ''}
</body></html>`;
}

module.exports = { inventoryPrintHtml };
