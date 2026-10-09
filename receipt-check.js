// Provjera fotografije računa: QR kod (JIR, vrijeme, iznos) + OIB izdavatelja otisnut na računu.
// QR kod fiskalnog računa ne sadrži OIB, zato se OIB čita s iste fotografije (OCR).
'use strict';
const os = require('os');
const path = require('path');
const Jimp = require('jimp');
const jsQR = require('jsqr');
const { createWorker } = require('tesseract.js');

const LANG_PATH = path.join(path.dirname(require.resolve('@tesseract.js-data/eng/package.json')), '4.0.0_best_int');

let workerPromise = null;
function getWorker() {
  if (!workerPromise) {
    workerPromise = createWorker('eng', 1, { langPath: LANG_PATH, cachePath: os.tmpdir(), gzip: true })
      .catch(e => { workerPromise = null; throw e; });
  }
  return workerPromise;
}

// ---------- QR ----------
function qrFrom(img) {
  const { data, width, height } = img.bitmap;
  const r = jsQR(new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), width, height, { inversionAttempts: 'attemptBoth' });
  return r ? r.data : null;
}
function decodeQr(base) {
  const W = base.bitmap.width, H = base.bitmap.height;
  const tries = [];
  for (const max of [1600, 1100, 800]) tries.push([0, 0, W, H, max]);
  // izresci: donja polovica, donja trećina, sredina (QR je obično pri dnu računa)
  tries.push([0, Math.round(H * 0.4), W, Math.round(H * 0.6), 1200]);
  tries.push([0, Math.round(H * 0.55), W, Math.round(H * 0.45), 1000]);
  tries.push([0, Math.round(H * 0.25), W, Math.round(H * 0.5), 1000]);
  for (const f of [0.6, 0.45]) {
    const w = Math.round(W * f), h = Math.round(H * f);
    for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) tries.push([Math.round((W - w) * i / 2), Math.round((H - h) * j / 2), w, h, 900]);
  }
  for (const [x, y, w, h, max] of tries) {
    const img = base.clone().crop(x, y, w, h);
    const s = Math.min(1, max / Math.max(w, h));
    if (s < 1) img.scale(s);
    const t = qrFrom(img);
    if (t) return t;
  }
  return null;
}

// ---------- OIB ----------
const CONFUSE = { O: '0', o: '0', D: '0', Q: '0', I: '1', l: '1', i: '1', '|': '1', '!': '1', Z: '2', z: '2', S: '5', s: '5', B: '8', G: '6', b: '6', g: '9', q: '9', T: '7' };
// Iz OCR teksta izvuci nizove od 11 znamenki (redak po redak, s ispravkom tipičnih zamjena slova i brojki).
function oibCandidates(text) {
  const out = new Set();
  for (const line of String(text).split(/\r?\n/)) {
    // dio retka nakon "OIB" ima prednost, ali gledamo cijeli redak
    const fixed = line.replace(/[A-Za-z|!]/g, (c, i, s) => {
      const prev = s[i - 1] || '', next = s[i + 1] || '';
      return (/[0-9]/.test(prev) || /[0-9]/.test(next)) && CONFUSE[c] ? CONFUSE[c] : c;
    });
    const digits = fixed.replace(/[^0-9]/g, '');
    for (let k = 0; k + 11 <= digits.length; k++) out.add(digits.slice(k, k + 11));
    for (const m of fixed.matchAll(/\d[\d .,\-]{9,20}\d/g)) {
      const d = m[0].replace(/\D/g, '');
      if (d.length === 11) out.add(d);
    }
  }
  return [...out];
}
function validOib(o) { // ISO 7064 MOD 11,10
  if (!/^\d{11}$/.test(o)) return false;
  let a = 10;
  for (let i = 0; i < 10; i++) { a = (a + +o[i]) % 10; if (a === 0) a = 10; a = (a * 2) % 11; }
  const k = (11 - a) % 10;
  return k === +o[10];
}
function diff(a, b) { let n = 0; for (let i = 0; i < 11; i++) if (a[i] !== b[i]) n++; return n; }
function findOib(text, own) {
  const cands = oibCandidates(text);
  if (cands.some(c => diff(c, own) <= 1)) return { ours: true };
  const other = cands.find(validOib);
  return { ours: false, other: other || null, anyDigits: cands.length > 0 };
}

async function ocr(img) {
  const w = await getWorker();
  const buf = await img.getBufferAsync(Jimp.MIME_PNG);
  const { data } = await w.recognize(buf);
  return data.text || '';
}
async function readOib(base, own) {
  const W = base.bitmap.width, H = base.bitmap.height;
  const prep = (x, y, w, h, target) => {
    const img = base.clone().crop(x, y, w, h).greyscale().normalize();
    const s = target / w; if (Math.abs(s - 1) > 0.05) img.scale(Math.min(s, 3));
    return img;
  };
  // 1) gornja polovica (OIB je na vrhu), 2) cijeli račun
  const passes = [prep(0, 0, W, Math.round(H * 0.55), 1600), prep(0, 0, W, H, 1600)];
  let last = { ours: false, other: null, anyDigits: false };
  for (const img of passes) {
    const r = findOib(await ocr(img), own);
    if (r.ours) return r;
    if (r.other) last = r; else if (r.anyDigits && !last.other) last = r;
  }
  return last;
}

/**
 * Provjeri fotografiju računa.
 * @returns {Promise<{qr:string}|{error:string,code:string}>}
 */
async function checkReceiptPhoto(buffer, ownOib) {
  let base;
  try { base = await Jimp.read(buffer); } catch { return { error: 'Fotografija se ne može otvoriti. Pokušaj ponovno.', code: 'image' }; }
  const max = 2200, big = Math.max(base.bitmap.width, base.bitmap.height);
  if (big > max) base.scale(max / big);
  const qr = decodeQr(base);
  if (!qr) return { error: 'Na fotografiji nisam pronašao QR kod. Slikaj cijeli račun izbliza, da bude oštar.', code: 'noqr' };
  const oib = await readOib(base, ownOib);
  if (oib.ours) return { qr };
  if (oib.other) return { error: 'Ovaj račun nije iz NOMAd-a. Bodove donose samo računi iz NOMAd Caffe Bara.', code: 'foreign' };
  return { error: 'Ne vidim OIB na vrhu računa. Slikaj cijeli račun, od naziva lokala do QR koda, da sve bude oštro.', code: 'nooib' };
}

module.exports = { checkReceiptPhoto, findOib, validOib, getWorker };
