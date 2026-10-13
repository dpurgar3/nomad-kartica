// Agent NOMAd – AI chat za web nomadinfo.space
// Rute: GET /agent-nomad.js (widget), GET /agent/ping, POST /agent/chat, GET /agent/fb-test
// Varijable okruženja (Render -> Environment):
//   ANTHROPIC_API_KEY  (obavezno – isti ključ kao za inventuru)
//   AGENT_MODEL        (neobavezno, zadano claude-haiku-5-5)
//   FB_PAGE_TOKEN      (neobavezno – token Facebook stranice za čitanje objava)
//   FB_PAGE_ID         (neobavezno, zadano "me")
'use strict';
const fs = require('fs');
const path = require('path');
const express = require('express');

const API_URL = 'https://api.anthropic.com/v1/messages';
const ALLOWED = [/^https:\/\/(www\.)?nomadinfo\.space$/, /^https:\/\/[a-z0-9-]+\.netlify\.app$/, /^http:\/\/localhost(:\d+)?$/,
  /^https:\/\/nomad-kartica\.onrender\.com$/];

// ---------- Podaci ----------
function loadPodaci() {
  try { const p = JSON.parse(fs.readFileSync(path.join(__dirname, 'podaci.json'), 'utf8')); delete p._upute; return p; }
  catch (e) { console.error('agent: podaci.json', e.message); return {}; }
}
// Cjenik se čita iz TV menija (public/meni.html) da cijene budu uvijek iste
function loadCjenik() {
  try {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'meni.html'), 'utf8');
    const m = html.match(/const MENI = (\[[\s\S]*?\n\]);/);
    if (!m) return '';
    const meni = Function('"use strict";return ' + m[1])();
    return meni.map(([kat, nap, , st]) => `${kat}${nap ? ' (' + nap + ')' : ''}:\n` +
      st.map(([n, k, c]) => `- ${n}${k ? ' ' + k : ''}: ${c} €`).join('\n')).join('\n');
  } catch (e) { console.error('agent: cjenik', e.message); return ''; }
}

// ---------- Normativi (sastav pića i jela) iz aplikacije Inventura ----------
function cistiNaziv(n) {
  return String(n || '')
    .replace(/\bzadu[žz]n\w*\b/gi, '')
    .replace(/\s+\d+\/\d+\s*l\.?/gi, '')
    .replace(/\s+(kg|lit|l\.|ml\.|kom)\s*$/i, '')
    .replace(/\s{2,}/g, ' ').trim();
}
function kolicina(q, unit) {
  const n = Number(q);
  if (!Number.isFinite(n)) return '';
  const r = x => String(x >= 1 ? Math.round(x * 10) / 10 : Number(x.toPrecision(2))).replace('.', ',');
  if (unit === 'kg') return r(n * 1000) + ' g';
  if (unit === 'l') return r(n * 1000) + ' ml';
  if (unit === 'dl') return r(n * 100) + ' ml';
  if (unit === 'porcija') return r(n) + ' porcija';
  return r(n) + ' ' + unit;
}
let norm = { at: 0, text: '' };
function loadNormativi(db) {
  if (Date.now() - norm.at < 10 * 60e3 && norm.text) return norm.text;
  let list = [];
  try {
    if (db) {
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zagreb' }).format(new Date());
      const recs = db.prepare('SELECT id, name FROM recipes WHERE active=1 ORDER BY name').all();
      const ver = db.prepare('SELECT id FROM recipe_versions WHERE recipe_id=? AND valid_from<=? ORDER BY valid_from DESC, version DESC LIMIT 1');
      const lines = db.prepare(`SELECT l.qty_e4, a.name AS a_name, a.unit AS a_unit, r.name AS r_name FROM recipe_lines l
        LEFT JOIN articles a ON a.id=l.article_id LEFT JOIN recipes r ON r.id=l.sub_recipe_id WHERE l.version_id=? ORDER BY l.id`);
      for (const r of recs) {
        const v = ver.get(r.id, today); if (!v) continue;
        list.push({ naziv: r.name, sastojci: lines.all(v.id).map(x => x.a_name
          ? { naziv: x.a_name, kolicina: x.qty_e4 / 1e4, jedinica: x.a_unit }
          : { naziv: x.r_name, kolicina: x.qty_e4 / 1e4, jedinica: 'porcija' }) });
      }
    }
  } catch (e) { console.error('agent: normativi iz baze', e.message); list = []; }
  if (!list.length) {
    try { list = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'inventura', 'seed', 'normativi-remaris.json'), 'utf8')).normativi || []; }
    catch (e) { console.error('agent: normativi seed', e.message); }
  }
  norm = { at: Date.now(), text: list.filter(n => !/\(STARI\)/i.test(n.naziv) && (n.sastojci || []).length)
    .map(n => `${n.naziv}: ` + n.sastojci.filter(x => Number(x.kolicina) > 0).map(x => `${cistiNaziv(x.naziv)} ${kolicina(x.kolicina, x.jedinica)}`.trim()).join(', ')).join('\n') };
  return norm.text;
}

// ---------- Vrijeme (Open-Meteo, Novi Marof) ----------
const WMO = { 0: 'vedro', 1: 'pretežno vedro', 2: 'djelomično oblačno', 3: 'oblačno', 45: 'magla', 48: 'magla s injem',
  51: 'slaba rosulja', 53: 'rosulja', 55: 'jaka rosulja', 61: 'slaba kiša', 63: 'kiša', 65: 'jaka kiša', 66: 'ledena kiša',
  67: 'jaka ledena kiša', 71: 'slab snijeg', 73: 'snijeg', 75: 'jak snijeg', 77: 'snježna zrnca', 80: 'pljuskovi',
  81: 'pljuskovi', 82: 'jaki pljuskovi', 85: 'snježni pljuskovi', 86: 'jaki snježni pljuskovi', 95: 'grmljavina',
  96: 'grmljavina s tučom', 99: 'jaka grmljavina s tučom' };
let wx = { at: 0, text: '' };
async function vrijeme(fetchImpl) {
  if (Date.now() - wx.at < 30 * 60e3 && wx.text) return wx.text;
  try {
    const u = 'https://api.open-meteo.com/v1/forecast?latitude=46.1667&longitude=16.3333&timezone=Europe%2FZagreb&forecast_days=3' +
      '&current=temperature_2m,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max';
    const r = await fetchImpl(u, { signal: AbortSignal.timeout(6000) });
    const j = await r.json();
    const c = j.current, d = j.daily;
    const dani = d.time.map((t, i) => `${t}: ${WMO[d.weather_code[i]] || '—'}, ${Math.round(d.temperature_2m_min[i])}–${Math.round(d.temperature_2m_max[i])} °C, kiša ${d.precipitation_probability_max[i] ?? 0} %`);
    wx = { at: Date.now(), text: `Sada: ${Math.round(c.temperature_2m)} °C, ${WMO[c.weather_code] || ''}, vjetar ${Math.round(c.wind_speed_10m)} km/h\n` + dani.join('\n') };
  } catch (e) { console.error('agent: vrijeme', e.message); }
  return wx.text;
}

// ---------- Facebook objave ----------
let fb = { at: 0, posts: [] };
async function fbObjave(fetchImpl) {
  const token = process.env.FB_PAGE_TOKEN;
  if (!token) return [];
  if (Date.now() - fb.at < 15 * 60e3) return fb.posts;
  try {
    const since = Math.floor((Date.now() - 90 * 864e5) / 1000);
    const u = `https://graph.facebook.com/v21.0/${process.env.FB_PAGE_ID || 'me'}/posts?fields=message,created_time,permalink_url&limit=25&since=${since}&access_token=${encodeURIComponent(token)}`;
    const j = await (await fetchImpl(u, { signal: AbortSignal.timeout(8000) })).json();
    if (j.error) throw new Error(j.error.message);
    fb = { at: Date.now(), posts: (j.data || []).filter(p => p.message).map(p => ({
      datum: p.created_time.slice(0, 10), tekst: p.message.slice(0, 700), link: p.permalink_url })) };
  } catch (e) { console.error('agent: facebook', e.message); fb.at = Date.now() - 10 * 60e3; }
  return fb.posts;
}

function danas() {
  const f = new Intl.DateTimeFormat('hr-HR', { timeZone: 'Europe/Zagreb', weekday: 'long', day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const iso = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zagreb' }).format(new Date());
  return { text: f.format(new Date()), iso };
}

function sustav({ podaci, cjenik, prognoza, objave, normativi = '', obavijesti = [] }) {
  const d = danas();
  return `Ti si Agent NOMAd, veseli kauboj-domaćin NOMAd Caffe Bara u Novom Marofu. Odgovaraš gostima na web stranici.
Danas je ${d.text} (${d.iso}).

PRAVILA
- Odgovaraj na jeziku na kojem gost piše (zadano hrvatski). Kratko: 1–4 rečenice ili kratka lista. Topao, malo šaljiv kauboj ton (rijetko "jiha!" ili 🤠), ali uvijek točan.
- Koristi ISKLJUČIVO podatke ispod. Nikad ne izmišljaj cijene, artikle, radno vrijeme ni događanja. Ako nešto ne znaš, reci to i uputi na telefon ${podaci.telefon || ''}.
- Narudžbe, rezervacije i proslave ne primaš: uputi na telefon.
- Cijene piši u eurima kao u cjeniku (npr. 2,40 €).
- Alkohol ne nudi maloljetnicima.
- Prognozu daj samo iz podataka o vremenu, za Novi Marof.
- NAŠE OBAVIJESTI upisuje vlasnik i imaju PREDNOST pred svim ostalim podacima (akcije, događanja, promjene radnog vremena, zatvoreno, novi artikli). Ako obavijest za neki datum mijenja redovno stanje, za taj datum vrijedi obavijest. Ne spominji obavijesti za datume koji su prošli.
- NOVOSTI S FACEBOOKA su naše objave (najnovije prve): koristi ih za akcije, događanja i promjene radnog vremena. Ako objava za neki datum mijenja redovno stanje, za taj datum vrijedi objava. Ne najavljuj događanja koja su prošla. Smiješ dati link objave. Ako nema ničeg aktualnog, reci to i uputi na ${podaci.facebook || 'naš Facebook'}.
- SASTAV (normativi): kad gost pita od čega se nešto sastoji ili što je unutra, odgovori iz popisa SASTAV PIĆA I JELA. Naziv u popisu može biti malo drugačiji od cjenika (npr. "MALA KAVA S MLIJEKOM" = "Kava s mlijekom mala") – poveži ih razumno. Sastojke navedi prirodnim jezikom (npr. "espresso od 8 g kave i 50 ml mlijeka"). Ne spominji interne šifre ni skladišne oznake. Ako artikla nema u popisu, reci da sastav nemaš i uputi na osoblje.
- Za alergene i posebne prehrane nemaš potpune podatke: navedi sastojke koje znaš i obavezno savjetuj da gost provjeri s osobljem.
- Ne odgovaraj na teme koje nemaju veze s kafićem, Novim Marofom ili posjetom; ljubazno vrati razgovor na NOMAd.

PODACI O KAFIĆU
${JSON.stringify(podaci, null, 1)}

CJENIK
${cjenik || 'Cjenik trenutno nije dostupan – uputi na QR cjenik u kafiću.'}

VRIJEME (Novi Marof)
${prognoza || 'Prognoza trenutno nije dostupna.'}

SASTAV PIĆA I JELA (normativi, količine za jednu porciju)
${normativi || 'Normativi trenutno nisu dostupni.'}

NAŠE OBAVIJESTI (najnovije prve)
${obavijesti.length ? obavijesti.map(o => `[upisano ${String(o.created_at).slice(0, 10)}${o.vrijedi_do ? ', vrijedi do ' + o.vrijedi_do : ''}] ${o.tekst}`).join('\n') : 'Trenutno nema posebnih obavijesti.'}

NOVOSTI S FACEBOOKA
${objave.length ? objave.map(o => `[${o.datum}] ${o.tekst} (${o.link})`).join('\n\n') : 'Nema učitanih objava.'}`;
}

// ---------- Ograničenje: 20 poruka / 10 min po IP ----------
const hits = new Map();
function rate(ip) {
  const now = Date.now(), arr = (hits.get(ip) || []).filter(t => now - t < 10 * 60e3);
  arr.push(now); hits.set(ip, arr);
  return arr.length <= 20;
}
setInterval(() => { const now = Date.now(); for (const [k, a] of hits) if (!a.some(t => now - t < 10 * 60e3)) hits.delete(k); }, 600e3).unref();

function cors(req, res) {
  const o = req.get('Origin');
  if (o && ALLOWED.some(r => r.test(o))) {
    res.set('Access-Control-Allow-Origin', o);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    res.set('Access-Control-Max-Age', '86400');
    return true;
  }
  return !o;
}

function cleanMessages(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const m of list.slice(-12)) {
    const role = m && (m.role === 'assistant' ? 'assistant' : m.role === 'user' ? 'user' : null);
    const content = m && typeof m.content === 'string' ? m.content.trim().slice(0, 800) : '';
    if (!role || !content) continue;
    if (out.length && out[out.length - 1].role === role) out[out.length - 1].content += '\n' + content;
    else out.push({ role, content });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  if (!out.length || out[out.length - 1].role !== 'user') return null;
  return out;
}

function mount(app, { fetchImpl = globalThis.fetch, inventuraDb = null, obavijesti = () => [] } = {}) {
  const widget = path.join(__dirname, 'widget.js');
  app.get('/agent-nomad.js', (req, res) => {
    res.set('Cache-Control', 'public, max-age=600');
    res.set('Access-Control-Allow-Origin', '*');
    res.type('application/javascript').sendFile(widget);
  });
  app.get('/agent/ping', (req, res) => res.json({ ok: true, ai: !!process.env.ANTHROPIC_API_KEY, facebook: !!process.env.FB_PAGE_TOKEN }));
  app.get('/agent/fb-test', async (req, res) => {
    if (!process.env.FB_PAGE_TOKEN) return res.json({ ok: false, error: 'FB_PAGE_TOKEN nije postavljen na Renderu.' });
    fb.at = 0; const posts = await fbObjave(fetchImpl);
    res.json({ ok: posts.length > 0, broj: posts.length, posts: posts.slice(0, 5) });
  });
  app.options('/agent/chat', (req, res) => { cors(req, res); res.sendStatus(204); });
  app.post('/agent/chat', express.json({ limit: '40kb' }), async (req, res) => {
    if (!cors(req, res)) return res.status(403).json({ error: 'Nije dopušteno.' });
    if (!rate(req.ip)) return res.status(429).json({ error: 'Puno pitanja zaredom, kauboju! Pričekaj par minuta ili nas nazovi.' });
    const messages = cleanMessages(req.body && req.body.messages);
    if (!messages) return res.status(400).json({ error: 'Prazna poruka.' });
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) return res.status(503).json({ error: 'Agent se upravo sedla. Za sva pitanja nazovi +385 91 934 5741.' });
    try {
      const [prognoza, objave] = await Promise.all([vrijeme(fetchImpl), fbObjave(fetchImpl)]);
      const system = sustav({ podaci: loadPodaci(), cjenik: loadCjenik(), prognoza, objave, normativi: loadNormativi(inventuraDb), obavijesti: (() => { try { return obavijesti(); } catch (e) { console.error('agent: obavijesti', e.message); return []; } })() });
      const r = await fetchImpl(API_URL, {
        method: 'POST', signal: AbortSignal.timeout(30000),
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: process.env.AGENT_MODEL || 'claude-haiku-5-5', max_tokens: 600, system, messages }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { console.error('agent: API', r.status, j && j.error && j.error.message); throw new Error('api'); }
      const text = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
      res.json({ reply: text || 'Hmm, zapelo mi je laso. Pitaj me ponovno!' });
    } catch (e) {
      res.status(502).json({ error: 'Trenutno ne mogu odgovoriti. Nazovi nas na +385 91 934 5741.' });
    }
  });
}

module.exports = { mount, loadCjenik, cleanMessages, sustav, loadPodaci, loadNormativi };
