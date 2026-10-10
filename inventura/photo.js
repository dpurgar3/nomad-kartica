// Brojanje sa slike: fotografija police ili hladnjaka -> Claude (Anthropic API) prepozna artikle
// s popisa ove inventure i izbroji ih. Rezultat se ne upisuje sam: korisnik ga pregleda i potvrdi.
// Potrebna varijabla okruženja ANTHROPIC_API_KEY (Render -> Environment). Model: INVENTURA_AI_MODEL.
'use strict';

const API_URL = 'https://api.anthropic.com/v1/messages';
const MEDIA = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const SURE = ['visoka', 'srednja', 'niska'];

class PhotoError extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }

const fmt = e4 => String(Number(e4) / 10000).replace('.', ',');

/** Popis artikala koji se šalje modelu: id | naziv | jedinica | pakiranja */
function catalog(items) {
  return items.map(i => {
    const pk = (i.packagings || []).map(p => `${p.name} = ${fmt(p.qty_e4)} ${i.unit} [pakiranje ${p.id}]`).join('; ');
    return `${i.id} | ${i.name}${i.code ? ' (' + i.code + ')' : ''} | ${i.unit}${i.category ? ' | ' + i.category : ''}${pk ? ' | ' + pk : ''}`;
  }).join('\n');
}

function buildPrompt(items, hint = '') {
  return `Ti si pomoćnik za inventuru u caffe baru NOMAd. Na fotografiji je polica, hladnjak, skladište ili šank.
Prepoznaj artikle koji se nalaze na POPISU ispod i izbroji ih.

Pravila:
- Koristi samo artikle s popisa. Ono što ne možeš povezati s popisom navedi u "nepoznato" (kratki opis, npr. "3 boce nepoznatog vina").
- Broji samo ono što se stvarno vidi. Ne pretpostavljaj što je iza ili ispod drugih predmeta; ako sumnjaš da ima skrivenih, napiši to u "napomena" i stavi sigurnost "niska".
- Ako se vidi zatvoreno pakiranje koje postoji na popisu (npr. gajba ili karton), smiješ upisati broj pakiranja i "pakiranje_id". Inače upiši količinu u osnovnoj jedinici artikla (kom, l, kg...).
- Za otvorene boce žestice (jedinica l) procijeni koliko je tekućine ostalo, u litrama, i stavi sigurnost "srednja" ili "niska".
- Isti artikl navedi samo jednom (zbroji sve što vidiš).
- Sigurnost: "visoka" = jasno vidljivo i lako prebrojivo, "srednja" = djelomično zaklonjeno ili procjena, "niska" = nesigurno.
${hint ? `\nNapomena korisnika uz sliku: ${hint}\n` : ''}
POPIS (id | naziv | jedinica | kategorija | pakiranja):
${catalog(items)}

Odgovori ISKLJUČIVO JSON-om, bez ikakvog drugog teksta, u obliku:
{"stavke":[{"id":12,"kolicina":24,"pakiranje_id":null,"sigurnost":"visoka","napomena":""}],"nepoznato":[]}`;
}

/** Iz odgovora modela izvuci provjerene stavke. Neispravne stavke se preskaču. */
function parseReply(text, items) {
  const s = String(text || '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b < a) throw new PhotoError('AI nije vratio ispravan odgovor. Pokušaj ponovno.', 502);
  let j; try { j = JSON.parse(s.slice(a, b + 1)); } catch { throw new PhotoError('AI nije vratio ispravan odgovor. Pokušaj ponovno.', 502); }
  const byId = new Map(items.map(i => [Number(i.id), i]));
  const merged = new Map();
  for (const x of Array.isArray(j.stavke) ? j.stavke : []) {
    const it = byId.get(Number(x && x.id)); if (!it) continue;
    const qty = Number(String(x.kolicina ?? '').replace(',', '.'));
    if (!Number.isFinite(qty) || qty < 0) continue;
    let packagingId = x.pakiranje_id == null || x.pakiranje_id === '' ? null : Number(x.pakiranje_id);
    if (packagingId != null && !(it.packagings || []).some(p => Number(p.id) === packagingId)) packagingId = null;
    const sure = SURE.includes(x.sigurnost) ? x.sigurnost : 'srednja';
    const note = String(x.napomena || '').slice(0, 200);
    const key = it.id + '|' + (packagingId ?? '');
    const prev = merged.get(key);
    if (prev) { prev.qty = Math.round((prev.qty + qty) * 10000) / 10000; if (SURE.indexOf(sure) > SURE.indexOf(prev.sure)) prev.sure = sure; if (note) prev.note = [prev.note, note].filter(Boolean).join('; '); }
    else merged.set(key, { itemId: it.id, name: it.name, unit: it.unit, qty: Math.round(qty * 10000) / 10000, packagingId, sure, note });
  }
  const unknown = (Array.isArray(j.nepoznato) ? j.nepoznato : []).map(v => String(v).slice(0, 120)).filter(Boolean).slice(0, 20);
  return { items: [...merged.values()], unknown };
}

async function countFromPhoto({ image, mediaType, items, hint = '', apiKey = process.env.ANTHROPIC_API_KEY,
  model = process.env.INVENTURA_AI_MODEL || 'claude-sonnet-5-5', fetchImpl = globalThis.fetch }) {
  if (!apiKey) throw new PhotoError('Brojanje sa slike nije uključeno: na Renderu nedostaje ANTHROPIC_API_KEY.', 503);
  if (!MEDIA.includes(mediaType)) throw new PhotoError('Pošalji sliku (JPG, PNG ili WEBP).');
  if (!image) throw new PhotoError('Slika nije stigla.');
  if (!items.length) throw new PhotoError('Inventura nema artikala.');
  let r;
  try {
    r = await fetchImpl(API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model, max_tokens: 4000,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: image } },
          { type: 'text', text: buildPrompt(items, String(hint || '').slice(0, 200)) },
        ] }],
      }),
      signal: AbortSignal.timeout(90e3),
    });
  } catch { throw new PhotoError('AI servis se ne javlja. Pokušaj ponovno.', 502); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const m = String(data?.error?.message || '');
    if (r.status === 401) throw new PhotoError('API ključ nije ispravan (ANTHROPIC_API_KEY na Renderu).', 502);
    if (/credit|billing/i.test(m)) throw new PhotoError('Na Anthropic računu nema kredita. Uplati ga na console.anthropic.com.', 502);
    if (r.status === 429 || r.status === 529) throw new PhotoError('AI je trenutno zauzet. Pokušaj za minutu.', 503);
    console.error('[inventura foto]', r.status, m);
    throw new PhotoError('AI greška: ' + (m || r.status), 502);
  }
  const text = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
  return { ...parseReply(text, items), model };
}

module.exports = { catalog, buildPrompt, parseReply, countFromPhoto, PhotoError };
