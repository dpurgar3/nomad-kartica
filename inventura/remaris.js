// Uvoz Remaris izvještaja "Skladišna stanja" (PDF) — čita šifru, naziv, jedinicu, stanje i kategoriju.
// Remaris PDF koristi podskup fonta pa su neki nazivi "šifrirani" (pomak znakova za 29); ovdje se dekodiraju.
'use strict';
const path = require('path');

const SPECIAL = { 'ü': 'ć', 'þ': 'č', 'ý': 'Č', 'å': 'ž', 'ä': 'Ž', 'ã': 'š', 'â': 'Š', 'û': 'Ć', 'Ĉ': 'Đ' };
const isGarbled = s => [...s].some(ch => SPECIAL[ch] || ch.charCodeAt(0) < 32);
function decodePiece(s) {
  if (!isGarbled(s)) return s;
  let out = '';
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (SPECIAL[ch]) out += SPECIAL[ch];
    else if (c < 128) out += String.fromCharCode(c + 29);
    else out += ch;
  }
  return out;
}
const clean = s => s.replace(/\s+/g, ' ').trim();
const UNIT_WORDS = /^(Kg|Komad|Litra|Lit|Kom|L)$/i;
const QTY = /^-?[\d.]+,\d+$/;
const SKIP = /^(ARTIST|Caffe bar|Skladište|Skladišna stanja|Šifra|Remaris|Stanje|UnitHeade|r)\b|:/i;

/** Iz liste tekstualnih elemenata {x, y, str, page} složi stavke. Izdvojeno radi testiranja. */
function parseTextItems(elements) {
  const rows = new Map();
  for (const e of elements) {
    if (!e.str || !e.str.trim()) continue;
    const key = `${e.page}:${Math.round(e.y)}`;
    if (!rows.has(key)) rows.set(key, { page: e.page, y: Math.round(e.y), parts: [] });
    rows.get(key).parts.push(e);
  }
  const ordered = [...rows.values()].sort((a, b) => a.page - b.page || b.y - a.y);
  const items = []; let category = null; let datum = null;
  for (const r of ordered) {
    r.parts.sort((a, b) => a.x - b.x);
    const code = clean(r.parts.filter(p => p.x < 90).map(p => decodePiece(p.str)).join(' '));
    const name = clean(r.parts.filter(p => p.x >= 90 && p.x < 440).map(p => decodePiece(p.str)).join(' '));
    const unit = clean(r.parts.filter(p => p.x >= 440 && p.x < 520).map(p => p.str).join(''));
    const qty = clean(r.parts.filter(p => p.x >= 520).map(p => p.str).join(''));
    const all = clean(r.parts.map(p => decodePiece(p.str)).join(' '));
    const dm = /(\d{2})\.(\d{2})\.(\d{4})/.exec(all);
    if (dm && !datum && !UNIT_WORDS.test(unit)) datum = `${dm[3]}-${dm[2]}-${dm[1]}`;
    if (UNIT_WORDS.test(unit) && QTY.test(qty) && name) {
      items.push({ sifra: /^\d+$/.test(code) ? code : null, naziv: name, kategorija: category, jedinica: unit.toLowerCase(),
        stanje: qty.replace(/\./g, '').replace(',', '.') });
      continue;
    }
    // red kategorije: samo tekst u stupcu šifre, bez jedinice i količine
    if (code && !name && !unit && !qty && !/^\d+$/.test(code) && !SKIP.test(code) && !/\d+\/\d+$/.test(code) && !dm) category = code;
  }
  return { items, datum };
}

async function pdfElements(buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const standardFontDataUrl = path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts') + path.sep;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), disableFontFace: true, standardFontDataUrl, verbosity: 0 }).promise;
  const els = [];
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      for (const it of tc.items) els.push({ page: p, x: it.transform[4], y: it.transform[5], str: it.str });
      page.cleanup();
    }
  } finally { await doc.destroy(); }
  return els;
}

const hrNum = s => s.replace(/\s*EUR\s*$/, '').replace(/\./g, '').replace(',', '.');
const toCents = s => { const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(hrNum(s)); if (!m) return NaN; return (m[1] ? -1 : 1) * (Number(m[2]) * 100 + Number((m[3] || '0').padEnd(2, '0'))); };
const hrDateIso = (d, m, y) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** Remaris izvještaj "Promet po artiklima": razdoblje, stavke (šifra, naziv, kategorija, količina, cijena, ukupno) i ukupni iznos. */
function parseSalesItems(elements) {
  const rows = new Map();
  for (const e of elements) {
    if (!e.str || !e.str.trim()) continue;
    const key = `${e.page}:${Math.round(e.y)}`;
    if (!rows.has(key)) rows.set(key, { page: e.page, y: Math.round(e.y), parts: [] });
    rows.get(key).parts.push(e);
  }
  const ordered = [...rows.values()].sort((a, b) => a.page - b.page || b.y - a.y);
  const lines = []; let category = null, from = null, to = null, total = null;
  for (const r of ordered) {
    r.parts.sort((a, b) => a.x - b.x);
    const toks = r.parts.map(p => ({ x: p.x, s: clean(decodePiece(p.str)) })).filter(t => t.s);
    const text = toks.map(t => t.s).join(' ');
    const per = /razdoblje\s+(\d{1,2})\.(\d{1,2})\.(\d{4})\.?\s*-\s*(\d{1,2})\.(\d{1,2})\.(\d{4})/i.exec(text);
    if (per) { from = hrDateIso(per[1], per[2], per[3]); to = hrDateIso(per[4], per[5], per[6]); continue; }
    const tot = /^Ukupno artikli:\s*(-?[\d.]+,\d{2})\s*EUR$/.exec(text);
    if (tot) { total = toCents(tot[1]); continue; }
    const eur = toks.filter(t => /EUR$/.test(t.s));
    if (/^\d+$/.test(toks[0]?.s || '') && toks[0].x < 75 && eur.length >= 2) {
      const qtyTok = toks.filter(t => t.x > 300 && /^-?[\d.]+,\d+$/.test(t.s))[0];
      const name = toks.filter(t => t.x >= 75 && (!qtyTok || t.x < qtyTok.x) && !/EUR$/.test(t.s)).map(t => t.s).join(' ');
      if (!qtyTok || !name) continue;
      lines.push({ code: toks[0].s, name, category, qty: hrNum(qtyTok.s), price_cents: toCents(eur[eur.length - 2].s), total_cents: toCents(eur[eur.length - 1].s) });
      continue;
    }
    if (toks.length === 1 && toks[0].x < 75 && !/^(Šifra|Ukupno)/.test(toks[0].s) && !/\d+\/\d+$/.test(toks[0].s) && !/[:\d]/.test(toks[0].s) && !/^(ARTIST|Caffe bar)/.test(toks[0].s)) category = toks[0].s;
  }
  return { period_from: from, period_to: to, total_cents: total, lines };
}

async function parseSalesPdf(buffer) {
  const res = parseSalesItems(await pdfElements(buffer));
  if (!res.lines.length) throw new Error('U PDF-u nisu pronađene stavke prodaje. Je li to Remaris izvještaj „Promet po artiklima”?');
  if (!res.period_from) throw new Error('U PDF-u nije pronađeno razdoblje („za razdoblje …”).');
  return res;
}

async function parsePdf(buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const standardFontDataUrl = path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts') + path.sep;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), disableFontFace: true, standardFontDataUrl, verbosity: 0 }).promise;
  const els = [];
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      for (const it of tc.items) els.push({ page: p, x: it.transform[4], y: it.transform[5], str: it.str });
      page.cleanup();
    }
  } finally { await doc.destroy(); }
  const res = parseTextItems(els);
  if (!res.items.length) throw new Error('U PDF-u nisu pronađene stavke. Je li to Remaris izvještaj "Skladišna stanja"?');
  return res;
}

module.exports = { parsePdf, parseTextItems, decodePiece, parseSalesPdf, parseSalesItems, toCents };
