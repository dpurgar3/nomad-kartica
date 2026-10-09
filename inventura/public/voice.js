// Glasovni unos (hrvatski): "coca cola dvadeset četiri", "jamnica dvije gajbe", "limun jedan i pol kila".
// Čiste funkcije (rade i u pregledniku i u Node testovima) + omotač za Web Speech API.
(function (root) {
  'use strict';
  const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd')
    .replace(/(\d),(\d)/g, '$1.$2').replace(/[^a-z0-9.\s]/g, ' ').replace(/\s+/g, ' ').trim();

  const ONES = { nula: 0, jedan: 1, jedna: 1, jedno: 1, jednu: 1, dva: 2, dvije: 2, dvi: 2, tri: 3, cetiri: 4, pet: 5, sest: 6, sedam: 7, osam: 8, devet: 9 };
  const TEENS = { deset: 10, jedanaest: 11, dvanaest: 12, trinaest: 13, cetrnaest: 14, petnaest: 15, sesnaest: 16, sedamnaest: 17, osamnaest: 18, devetnaest: 19 };
  const TENS = { dvadeset: 20, trideset: 30, cetrdeset: 40, pedeset: 50, sezdeset: 60, sedamdeset: 70, osamdeset: 80, devedeset: 90 };
  const HUND = { sto: 100, stotinu: 100, dvjesto: 200, dvjesta: 200, tristo: 300, cetiristo: 400, petsto: 500, sesto: 600, sesterosto: 600, sedamsto: 700, osamsto: 800, devetsto: 900 };
  const THOUS = { tisucu: 1000, tisuca: 1000, tisuce: 1000 };
  const isNumWord = w => w in ONES || w in TEENS || w in TENS || w in HUND || w in THOUS || w === 'i' || w === 'pol' || w === 'pola' || w === 'zarez' || /^\d+(\.\d+)?$/.test(w);

  // Jedinice / pakiranja koje se mogu izgovoriti nakon broja
  const UNIT_WORDS = [
    [/^(litr[aeu]?|litara)$/, { unit: 'l' }], [/^(decilit(a)?r[aeu]?|decilitara|deci)$/, { unit: 'dl' }],
    [/^(mililit(a)?r[aeu]?|mililitara|mil)$/, { unit: 'ml' }], [/^(kil[aeo]?|kilogram[aeu]?|kilograma|kg)$/, { unit: 'kg' }],
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
    if (qty != null && unit && unit.mult) qty *= unit.mult;
    return { query: words.slice(0, i).join(' '), qty, unit: unit?.unit || null, pack: unit?.pack || null };
  }

  /** Nađi najbolji artikl za izgovoreni naziv. Vraća [{item, score}] silazno. */
  function matchArticles(query, items, nameOf = x => x.name) {
    const q = norm(query).split(' ').filter(w => w.length >= 2 && !/^\d/.test(w));
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

  const api = { norm, wordsToNumber, parseUtterance, matchArticles, resolveUnit, supported, listen };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Voice = api;
})(typeof window !== 'undefined' ? window : globalThis);
