// Glasovni unos (hrvatski): "coca cola dvadeset četiri", "jamnica dvije gajbe", "limun jedan i pol kila",
// "ožujsko nula trideset tri deset" (veličina 0,33 je dio naziva, količina je 10).
// Čiste funkcije (rade i u pregledniku i u Node testovima) + omotač za Web Speech API.
(function (root) {
  'use strict';
  const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd')
    .replace(/(\d),(\d)/g, '$1.$2').replace(/[^a-z0-9.\s]/g, ' ')
    .replace(/(\d)(l|dl|ml|cl|kg)\b/g, '$1 $2') // "0.33l" → "0.33 l"
    .replace(/\s+/g, ' ').trim();

  const ONES = { nula: 0, jedan: 1, jedna: 1, jedno: 1, jednu: 1, dva: 2, dvije: 2, dvi: 2, tri: 3, cetiri: 4, pet: 5, sest: 6, sedam: 7, osam: 8, devet: 9 };
  const TEENS = { deset: 10, jedanaest: 11, dvanaest: 12, trinaest: 13, cetrnaest: 14, petnaest: 15, sesnaest: 16, sedamnaest: 17, osamnaest: 18, devetnaest: 19 };
  const TENS = { dvadeset: 20, trideset: 30, cetrdeset: 40, pedeset: 50, sezdeset: 60, sedamdeset: 70, osamdeset: 80, devedeset: 90 };
  const HUND = { sto: 100, stotinu: 100, dvjesto: 200, dvjesta: 200, tristo: 300, cetiristo: 400, petsto: 500, sesto: 600, sesterosto: 600, sedamsto: 700, osamsto: 800, devetsto: 900 };
  const THOUS = { tisucu: 1000, tisuca: 1000, tisuce: 1000 };
  const isNumWord = w => w in ONES || w in TEENS || w in TENS || w in HUND || w in THOUS || w === 'i' || w === 'pol' || w === 'pola' || w === 'zarez' || /^\d+(\.\d+)?$/.test(w);
  // jedinice koje mogu stajati uz veličinu u nazivu ("0,33 l", "0,5 litre", "3 deci")
  const SIZE_UNIT = /^(l|lit|litr[aeu]?|litara|dl|deci|decilit(a)?r[aeu]?|cl|ml|mil)$/;

  // Jedinice / pakiranja koje se mogu izgovoriti nakon broja
  const UNIT_WORDS = [
    [/^(l|litr[aeu]?|litara)$/, { unit: 'l' }], [/^(dl|decilit(a)?r[aeu]?|decilitara|deci)$/, { unit: 'dl' }],
    [/^(ml|mililit(a)?r[aeu]?|mililitara|mil)$/, { unit: 'ml' }], [/^(kil[aeo]?|kilogram[aeu]?|kilograma|kg)$/, { unit: 'kg' }],
    [/^(gram[aeu]?|grama|deka|dag)$/, { unit: 'g' }], [/^(komad[aeu]?|komada|kom|kos)$/, { unit: 'kom' }],
    [/^(gajb[aeiu]?)$/, { pack: 'gajb' }], [/^(kutij[aeiu]?|kutija)$/, { pack: 'kutij' }], [/^(karton[aeu]?|kartona)$/, { pack: 'karton' }],
    [/^(boc[aeiu]?|boca|flas[aeiu]?)$/, { pack: 'boc' }], [/^(paket[aeu]?|paketa|pakiranj[aeu]?)$/, { pack: 'pak' }], [/^(bacv[aeiu]?|bacva)$/, { pack: 'bacv' }],
  ];
  const unitWord = w => { for (const [re, v] of UNIT_WORDS) if (re.test(w)) return w === 'deka' || w === 'dag' ? { unit: 'g', mult: 10 } : v; return null; };

  /** Pretvori riječi u broj: ["dvadeset","četiri"] → 24; ["jedan","i","pol"] → 1.5; ["dva","zarez","pet"] → 2.5 */
  function wordsToNumber(words) {
    let total = 0, cur = 0, any = false, frac = null, half = false;
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (frac !== null) { if (/^\d+$/.test(w)) frac += w; else if (w in ONES) frac += String(ONES[w]); else if (w in TEENS) frac += String(TEENS[w]); else if (w in TENS) frac += String(TENS[w] / 10); continue; }
      if (/^\d+(\.\d+)?$/.test(w)) { cur += Number(w); any = true; }
      else if (w in ONES) { cur += ONES[w]; any = true; }
      else if (w in TEENS) { cur += TEENS[w]; any = true; }
      else if (w in TENS) { cur += TENS[w]; any = true; }
      else if (w in HUND) { cur += HUND[w]; any = true; }
      else if (w in THOUS) { total += (cur || 1) * 1000; cur = 0; any = true; }
      else if (w === 'zarez') frac = '';
      else if (w === 'pol' || w === 'pola') { half = true; any = true; }
      else if (w === 'i') continue;
    }
    if (!any && frac === null) return null;
    let n = total + cur + (half ? 0.5 : 0);
    if (frac) n = Number(String(total + cur) + '.' + frac);
    return n;
  }

  // "033", "05" (vodeća nula bez decimalne točke) — to je veličina (0,33 / 0,5), nikad količina
  const leadingZero = w => /^0\d+$/.test(w);

  /** "coca cola 24" → { query: 'coca cola', qty: 24, unit?, pack? } ; broj je zadnja skupina brojčanih riječi */
  function parseUtterance(text) {
    const words = norm(text).split(' ').filter(Boolean);
    let unit = null;
    if (words.length && unitWord(words[words.length - 1])) unit = unitWord(words.pop());
    let i = words.length;
    while (i > 0 && isNumWord(words[i - 1])) i--;
    // "pola" na početku broja može biti dio naziva ("pola-pola") — zanemarujemo; "i" ne smije biti prva riječ broja
    while (i < words.length && words[i] === 'i') i++;
    // "coca cola 0.25 24": više brojeva zaredom → količina je zadnji broj, ostali pripadaju nazivu
    const digitIdx = words.map((w, k) => (k >= i && /^\d/.test(w) ? k : -1)).filter(k => k >= 0);
    if (digitIdx.length > 1) i = digitIdx[digitIdx.length - 1];
    const numWords = words.slice(i);
    let qty = wordsToNumber(numWords);
    // "ožujsko 033" / "ožujsko 0 33" / "ožujsko nula trideset tri" bez količine → to je veličina, količina nije izgovorena
    if (numWords.length && (leadingZero(numWords[0]) || (numWords.length > 1 && (numWords[0] === 'nula' || numWords[0] === '0')))) qty = null;
    if (qty != null && unit && unit.mult) qty *= unit.mult;
    return { query: words.slice(0, i).join(' '), qty, unit: unit?.unit || null, pack: unit?.pack || null };
  }

  /** Veličine iz naziva artikla: "OŽUJSKO PIVO 0,33l" → [0.33]; "Coca- Cola 1L" → [1]; "Amaro 18 lit" → [18] */
  function sizesOf(name) {
    const t = norm(name).split(' ').map(w => w.replace(/\.$/, ''));
    const out = [];
    t.forEach((w, k) => {
      if (/^\d+\.\d+$/.test(w)) out.push(Number(w));
      else if (/^\d+$/.test(w) && SIZE_UNIT.test(t[k + 1] || '')) out.push(Number(w));
    });
    return [...new Set(out)];
  }

  /** Pročitaj izgovorenu veličinu: ["0.33"], ["033"], ["0","33"], ["nula","trideset","tri"], ["nula","zarez","pet"], ["pola","litre"] */
  function readSize(toks) {
    const div = toks.some(w => /^(dl|deci|decilit)/.test(w)) ? 10 : toks.includes('cl') ? 100 : toks.some(w => /^(ml|mil)$/.test(w)) ? 1000 : 1;
    const t = toks.filter(w => !SIZE_UNIT.test(w));
    if (!t.length || t.length < toks.length - 1) return null;
    let v = null;
    if (t.every(w => /^\d+(\.\d+)?$/.test(w))) {
      if (t.length === 1) v = leadingZero(t[0]) ? Number('0.' + t[0].slice(1)) : Number(t[0]);
      else if (t.length === 2 && t[0] === '0' && /^\d+$/.test(t[1])) v = Number('0.' + t[1]);
      else return null;
    } else if (t[0] === 'nula' || t[0] === '0') {
      let rest = t.slice(1);
      if (rest[0] === 'zarez') rest = rest.slice(1);
      let zeros = '';
      while (rest[0] === 'nula' || rest[0] === '0') { zeros += '0'; rest = rest.slice(1); }
      if (!rest.length) return null;
      const n = rest.every(w => /^\d+$/.test(w)) ? Number(rest.join('')) : wordsToNumber(rest);
      if (n == null || !Number.isInteger(n)) return null;
      v = Number('0.' + zeros + n);
    } else {
      v = wordsToNumber(t);
    }
    return v == null ? null : v / div;
  }

  const same = (a, b) => Math.abs(a - b) < 1e-9;

  /**
   * Parsiranje uz popis artikala: veličina iz naziva (0,33 / 0,5 l) ne smije postati količina.
   * Vraća { query, qty, unit, pack, size, candidates:[{item,score}] }.
   */
  function parseForItems(text, items, nameOf = x => x.name) {
    const words = norm(text).split(' ').filter(Boolean);
    let unit = null;
    if (words.length && unitWord(words[words.length - 1])) unit = unitWord(words.pop());
    // brojčani rep: brojevi + jedinice veličine između njih ("0.33 l 10")
    let i = words.length;
    while (i > 0) {
      const w = words[i - 1];
      if (isNumWord(w) || (SIZE_UNIT.test(w) && i >= 2 && isNumWord(words[i - 2]))) i--; else break;
    }
    while (i < words.length && words[i] === 'i') i++;
    const name = words.slice(0, i), tail = words.slice(i);
    let cands = name.length ? matchArticles(name.join(' '), items, nameOf) : [];
    if (cands.length) { const best = cands[0].score; cands = cands.filter(c => c.score >= best - 1); }
    const sizes = [];
    for (const c of cands) for (const s of sizesOf(nameOf(c.item))) if (!sizes.some(x => same(x, s))) sizes.push(s);

    let size = null, qtyToks = null;
    if (tail.length && sizes.length) {
      // 1) najduži početak repa koji je točno veličina nekog artikla, ostatak je količina
      for (let k = tail.length; k >= 1 && size == null; k--) {
        const rest = tail.slice(k);
        const q = rest.length ? wordsToNumber(rest) : null;
        if (rest.length && q == null) continue;
        const v = readSize(tail.slice(0, k));
        if (v == null) continue;
        let hit = sizes.find(s => same(s, v));
        // "ožujsko trideset tri deset" (bez "nula") → 33 = 0,33; samo ako iza slijedi količina
        if (hit == null && rest.length && Number.isInteger(v) && k <= 3) hit = sizes.find(s => s < 1 && (same(s, v / 100) || (v < 10 && same(s, v / 10))));
        if (hit != null) { size = hit; qtyToks = rest; }
      }
      // 2) prepoznavanje spojilo veličinu i količinu: "0.3310" → 0,33 + 10
      if (size == null && tail.length === 1 && /^0\.\d+$/.test(tail[0])) {
        for (const s of sizes) {
          const str = String(s);
          if (s < 1 && tail[0].length > str.length && tail[0].startsWith(str)) { size = s; qtyToks = [tail[0].slice(str.length).replace(/^0+(?=\d)/, '')]; break; }
        }
      }
    }

    let qty, query;
    if (size != null) {
      qty = qtyToks.length ? wordsToNumber(qtyToks) : null;
      if (!qtyToks.length) unit = null; // "0,33 l" — jedinica je pripadala veličini
      query = name.join(' ');
      // artikli te veličine idu na vrh
      cands = cands.map(c => ({ item: c.item, score: c.score + (sizesOf(nameOf(c.item)).some(s => same(s, size)) ? 2 : sizesOf(nameOf(c.item)).length ? -1 : 0) }))
        .sort((a, b) => b.score - a.score);
    } else {
      const p = parseUtterance(text);
      return { ...p, size: null, candidates: matchArticles(p.query, items, nameOf) };
    }
    if (qty != null && unit && unit.mult) qty *= unit.mult;
    return { query, qty, unit: unit?.unit || null, pack: unit?.pack || null, size, candidates: cands };
  }

  /** Nađi najbolji artikl za izgovoreni naziv. Vraća [{item, score}] silazno. */
  function matchArticles(query, items, nameOf = x => x.name) {
    const q = norm(query).split(' ').filter(w => w.length >= 2 && !/^\d/.test(w) && !SIZE_UNIT.test(w));
    if (!q.length) return [];
    const out = [];
    for (const it of items) {
      const n = norm(nameOf(it)); const toks = n.split(' ');
      let score = 0;
      for (const w of q) {
        if (toks.includes(w)) score += 3;
        else if (toks.some(t => t.startsWith(w) || (w.length >= 4 && w.startsWith(t) && t.length >= 3))) score += 2;
        else if (w.length >= 4 && n.includes(w.slice(0, 4))) score += 1;
      }
      if (score > 0) out.push({ item: it, score: score / q.length + (n.startsWith(q[0]) ? 0.5 : 0) });
    }
    return out.sort((a, b) => b.score - a.score);
  }

  /** Iz {unit, pack} izgovora i artikla izvedi unos za API. */
  function resolveUnit(parsed, article) {
    if (parsed.pack) {
      const p = (article.packagings || []).find(x => norm(x.name).includes(parsed.pack));
      if (!p) return { error: `Artikl nema pakiranje „${parsed.pack}…”. Dodaj ga u Artiklima ili izgovori količinu u ${article.unit}.` };
      return { packagingId: p.id, label: p.name };
    }
    if (parsed.unit && parsed.unit !== article.unit) return { unit: parsed.unit, label: parsed.unit };
    return { label: article.unit };
  }

  // ---------- omotač za preglednik ----------
  function supported() { return !!(root.SpeechRecognition || root.webkitSpeechRecognition); }
  function listen({ onResult, onError, onEnd, continuous = false }) {
    const SR = root.SpeechRecognition || root.webkitSpeechRecognition;
    const r = new SR(); r.lang = 'hr-HR'; r.interimResults = false; r.maxAlternatives = 3; r.continuous = continuous;
    r.onresult = e => { const res = e.results[e.results.length - 1]; onResult([...res].map(a => a.transcript)); };
    r.onerror = e => onError && onError(e.error === 'not-allowed' ? 'Dopusti pristup mikrofonu u pregledniku.' : e.error === 'no-speech' ? 'Nisam ništa čuo.' : 'Glasovni unos: ' + e.error);
    r.onend = () => onEnd && onEnd();
    r.start();
    return r;
  }

  const api = { norm, wordsToNumber, parseUtterance, parseForItems, sizesOf, readSize, matchArticles, resolveUnit, supported, listen };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Voice = api;
})(typeof window !== 'undefined' ? window : globalThis);
