// Brojanje sa slike: smanji fotografiju u pregledniku i pošalji je serveru na prepoznavanje.
(function (root) {
  'use strict';
  const MAX = 1568; // najveća stranica slike koju AI koristi bez dodatnog smanjivanja

  async function load(file) {
    if (root.createImageBitmap) { try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch {} }
    return await new Promise((res, rej) => {
      const i = new Image(); const u = URL.createObjectURL(file);
      i.onload = () => { URL.revokeObjectURL(u); res(i); };
      i.onerror = () => { URL.revokeObjectURL(u); rej(new Error('Slika se ne može učitati. Pokušaj JPG fotografiju.')); };
      i.src = u;
    });
  }

  async function shrink(file) {
    const img = await load(file);
    const w = img.width || img.naturalWidth, h = img.height || img.naturalHeight;
    const s = Math.min(1, MAX / Math.max(w, h));
    const c = document.createElement('canvas'); c.width = Math.round(w * s); c.height = Math.round(h * s);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    if (img.close) img.close();
    const blob = await new Promise(res => c.toBlob(res, 'image/jpeg', 0.85));
    if (!blob) throw new Error('Slika se ne može pripremiti.');
    return blob;
  }

  async function recognize(invId, file, hint) {
    const blob = await shrink(file);
    let r;
    try {
      r = await fetch('/inventura/api/inventories/' + invId + '/photo' + (hint ? '?hint=' + encodeURIComponent(hint) : ''), {
        method: 'POST', credentials: 'same-origin', body: blob,
        headers: { 'X-Inventura': '1', 'Content-Type': 'image/jpeg' },
      });
    } catch { throw new Error('Nema veze sa serverom. Provjeri internet.'); }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Greška.');
    return data;
  }

  root.Photo = { shrink, recognize };
})(window);
