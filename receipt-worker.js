// Pomoćni proces za provjeru fotografije računa (OCR). Pokreće ga receipt-check.js za svaku
// provjeru i gasi ga odmah nakon nje, tako da memorija koju OCR zauzme ne ostaje na serveru.
'use strict';
const { checkOibPhotoLocal } = require('./receipt-check');

process.once('message', async ({ image, oib }) => {
  let result;
  try { result = await checkOibPhotoLocal(Buffer.from(image, 'base64'), oib); }
  catch (e) { console.error('Provjera računa nije uspjela:', e && e.message); result = { error: 'Greška pri provjeri računa. Pokušaj ponovno.', code: 'worker' }; }
  process.send(result, () => process.exit(0));
});
