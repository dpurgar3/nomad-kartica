// Provjera fotografije računa: QR kod (JIR, vrijeme, iznos) + OIB izdavatelja otisnut na računu.
// QR kod fiskalnog računa ne sadrži OIB, zato se OIB čita s iste fotografije (OCR).
'use strict';
const os = require('os');
const path = require('path');
const Jimp = require('jimp');
const jsQR = require('jsqr');
const { createWorker } = require('tesseract.js');

const LANG_PATH = path.join(path.dirname(require.resolve('@tesseract.js-data/eng/package.json')), '4.0.0_best_int');

// OCR (Tesseract) zauzima puno memorije i ne vraća je dok radi. Zato se pokreće tek kad
// netko skenira račun i gasi se odmah nakon provjere — server ostaje ispod granice memorije.
let workerPromise = null;
function getWorker() {
  if (!workerPromise) {
    workerPromise = createWorker('eng', 1, { langPath: LANG_PATH, cachePath: os.tmpdir(), gzip: true })
      .catch(e => { workerPromise = null; throw e; });
  }
  return workerPromise;
}
async function shutdownWorker() {
  const p = workerPromise;
  workerPromise = null;
  if (!p) return;
  try { await (await p).terminate(); } catch { /* već ugašen */ }
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
  // Dugi računi: QR je malen na fotografiji. Uvećaj donji dio računa u preklapajućim pločicama
  // (s pojačanim kontrastom) da moduli QR koda budu dovoljno veliki za čitanje.
  const tile = Math.max(120, Math.round(Math.min(W, H * 0.35)));
  const step = Math.round(tile / 2);
  for (let y = H - tile; y >= Math.round(H * 0.3); y -= step) {
    for (let x = 0; x <= Math.max(0, W - tile); x += step) {
      const w = Math.min(tile, W - x), h = Math.min(tile, H - y);
      for (const contrast of [false, true]) {
        const img = base.clone().crop(x, y, w, h);
        if (contrast) img.greyscale().normalize().contrast(0.4);
        const up = Math.min(3, 900 / Math.max(w, h));
        if (up > 1.05) img.scale(up, Jimp.RESIZE_BICUBIC);
        const t = qrFrom(img);
        if (t) return t;
      }
      if (x + tile >= W) break;
    }
  }
  return null;
}

// ---------- OIB ----------
const CONFUSE = { O: '0', o: '0', D: '0', Q: '0', I: '1', l: '1', i: '1', '|': '1', '!': '1', Z: '2', z: '2', S: '5', s: '5', B: '8', G: '6', b: '6', g: '9', q: '9', T: '7' };
// Iz OCR teksta izvuci nizove od 11 znamenki (redak po redak, s ispravkom tipičnih zamjena slova i brojki).
// "Sigurni" kandidati: 11 znamenki u retku koji sadrži riječ OIB (za poruku "račun nije iz NOMAd-a").
function labelledOibs(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (!/[O0][I1l|]B/i.test(line)) continue;
    const after = line.split(/[O0][I1l|]B/i).slice(1).join(' ')
      .replace(/[A-Za-z|!]/g, c => CONFUSE[c] || c).replace(/[^0-9]/g, '');
    if (after.length >= 11) out.push(after.slice(0, 11));
  }
  return out;
}
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
  // drugi OIB: ispravan kontrolni broj I otisnut uz oznaku "OIB" (ne bilo koji niz znamenki s računa)
  const other = labelledOibs(text).find(o => validOib(o) && diff(o, own) > 1);
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
    // ograniči veličinu slike za OCR (najviše ~3 MP) zbog memorije servera
    const s = Math.min(target / w, 3, Math.sqrt(3e6 / (w * h)));
    if (Math.abs(s - 1) > 0.05) img.scale(s);
    return img;
  };
  // OIB je u zaglavlju računa: 1) gornja trećina, 2) gornjih 60 % (dugi računi i nakošene fotografije)
  const top = (f) => Math.min(H, Math.max(Math.round(H * f), Math.round(W * 0.9)));
  const passes = [() => prep(0, 0, W, top(0.33), 1400), () => prep(0, 0, W, top(0.6), 1400)];
  let last = { ours: false, other: null, anyDigits: false };
  for (const make of passes) {
    const r = findOib(await ocr(make()), own);
    if (r.ours) return r;
    if (r.other) return r; // jasno tuđi OIB: nema potrebe čitati dalje
    if (r.anyDigits) last = r;
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
  const max = 3000, big = Math.max(base.bitmap.width, base.bitmap.height);
  if (big > max) base.scale(max / big);
  const qr = decodeQr(base);
  let oib;
  try { oib = await readOib(base, ownOib); } finally { await shutdownWorker(); }
  if (oib.other && !oib.ours) return { error: 'Ovaj račun nije iz NOMAd-a. Bodove donose samo računi iz NOMAd Caffe Bara.', code: 'foreign' };
  if (!qr) return { error: 'Na fotografiji nisam pronašao QR kod. Slikaj račun izbliza, da QR kod bude oštar. Ako je račun dugačak, presavij srednji dio tako da se vide vrh i QR kod.', code: 'noqr' };
  if (oib.ours) return { qr };
  if (oib.other) return { error: 'Ovaj račun nije iz NOMAd-a. Bodove donose samo računi iz NOMAd Caffe Bara.', code: 'foreign' };
  return { error: 'Ne vidim OIB na vrhu računa. Slikaj cijeli račun, od naziva lokala do QR koda, da sve bude oštro.', code: 'nooib' };
}

/**
 * Lagana provjera (QR kod pročita mobitel): samo OIB s fotografije.
 * Radi u ovom procesu — koristi je receipt-worker.js.
 */
async function checkOibPhotoLocal(buffer, ownOib) {
  let base;
  try { base = await Jimp.read(buffer); } catch { return { error: 'Fotografija se ne može otvoriti. Pokušaj ponovno.', code: 'image' }; }
  const max = 2000, big = Math.max(base.bitmap.width, base.bitmap.height);
  if (big > max) base.scale(max / big);
  let oib;
  try { oib = await readOib(base, ownOib); } finally { base = null; await shutdownWorker(); }
  if (oib.ours) return { ok: true };
  if (oib.other) return { error: 'Ovaj račun nije iz NOMAd-a. Bodove donose samo računi iz NOMAd Caffe Bara.', code: 'foreign' };
  return { error: 'Ne vidim OIB na vrhu računa. Slikaj cijeli račun, od naziva lokala do QR koda, da sve bude oštro.', code: 'nooib' };
}

/**
 * Provjera OIB-a u zasebnom, kratkotrajnom procesu. OCR troši 300–400 MB, a Node tu memoriju
 * ne vraća dok proces radi; kad se pomoćni proces ugasi, sva se memorija oslobodi.
 * Jedna provjera u isto vrijeme; nakon 40 s proces se prekida.
 * @returns {Promise<{ok:true}|{error:string,code:string}>}
 */
const { fork } = require('child_process');
const WORKER_FILE = path.join(__dirname, 'receipt-worker.js');
const TIMEOUT_MS = 40000;
let busy = Promise.resolve();
function runInChild(buffer, ownOib) {
  return new Promise(resolve => {
    let done = false;
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); try { child.kill('SIGKILL'); } catch {} resolve(r); };
    const child = fork(WORKER_FILE, [], { execArgv: ['--max-old-space-size=200'], env: { ...process.env, MALLOC_ARENA_MAX: '2' }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    const timer = setTimeout(() => finish({ error: 'Provjera traje predugo. Pokušaj ponovno.', code: 'timeout' }), TIMEOUT_MS);
    child.on('message', m => finish(m && typeof m === 'object' ? m : { error: 'Greška pri provjeri računa. Pokušaj ponovno.', code: 'worker' }));
    child.on('error', () => finish({ error: 'Greška pri provjeri računa. Pokušaj ponovno.', code: 'worker' }));
    child.on('exit', () => finish({ error: 'Greška pri provjeri računa. Pokušaj ponovno.', code: 'worker' }));
    child.send({ image: buffer.toString('base64'), oib: ownOib });
  });
}
function checkOibPhoto(buffer, ownOib) {
  const run = busy.then(() => runInChild(buffer, ownOib));
  busy = run.catch(() => {});
  return run;
}

module.exports = { checkReceiptPhoto, checkOibPhoto, checkOibPhotoLocal, findOib, validOib, getWorker, shutdownWorker, decodeQr };
