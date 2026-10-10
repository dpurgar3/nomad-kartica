// NOMAd Inventura — sučelje (bez vanjskih biblioteka)
'use strict';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const view = $('#view');
const S = { meta: null, loc: null };

// ---------- formatiranje (hrvatski) ----------
function fq(e4, max = 4) { // količina ×10000 → "1.234,5"
  if (e4 == null) return '';
  const neg = e4 < 0, a = Math.abs(e4), i = Math.floor(a / 10000);
  let f = String(a % 10000).padStart(4, '0').slice(0, max).replace(/0+$/, '');
  return (neg ? '−' : '') + String(i).replace(/\B(?=(\d{3})+(?!\d))/g, '.') + (f ? ',' + f : '');
}
function fe(c, sign = false) { // centi → "1.234,56 €"
  if (c == null) return '—';
  const neg = c < 0, a = Math.abs(c);
  return (neg ? '−' : sign && c > 0 ? '+' : '') + String(Math.floor(a / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ',' + String(a % 100).padStart(2, '0') + ' €';
}
const fp = e4 => (e4 == null ? '—' : fq(e4, 4) + ' €'); // cijena
const fd = d => (d ? String(d).slice(0, 10).split('-').reverse().join('.') + '.' : '');
const fdt = d => (d ? fd(d) + ' ' + String(d).slice(11, 16) : '');
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zagreb' }).format(new Date());
const sgn = v => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
const KIND = { visak: 'višak', manjak: 'manjak', slaze_se: 'slaže se', neprebrojano: 'neprebrojano' };

// ---------- API ----------
async function api(path, { method = 'GET', body, raw } = {}) {
  const opt = { method, headers: { 'X-Inventura': '1' }, credentials: 'same-origin' };
  if (raw) { opt.body = raw; opt.headers['Content-Type'] = 'application/pdf'; }
  else if (body !== undefined) { opt.body = JSON.stringify(body); opt.headers['Content-Type'] = 'application/json'; }
  let r;
  try { r = await fetch('/inventura/api' + path, opt); } catch { throw new Error('Nema veze sa serverom. Provjeri internet.'); }
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && data.login) { showLogin(); throw new Error('Prijavi se.'); }
  if (!r.ok) { const e = new Error(data.error || 'Greška.'); e.status = r.status; throw e; }
  return data;
}
function toast(msg, bad = false) {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast show' + (bad ? ' bad' : '');
  clearTimeout(t._t); t._t = setTimeout(() => (t.className = 'toast'), bad ? 5000 : 2500);
}
const fail = e => toast(e.message, true);
const csvUrl = (p, q = {}) => '/inventura/api/csv/' + p + '?' + new URLSearchParams({ location: S.loc || '', ...q });

// ---------- glasovni unos ----------
const VOICE = typeof Voice !== 'undefined' && Voice.supported();
const micHtml = (id, title = 'Glasovni unos') => (VOICE ? `<button type="button" class="btn mic" id="${id}" title="${title}" aria-label="${title}">🎤</button>` : '');
let activeRec = null;
function startVoice(btn, onTexts) {
  if (activeRec) { activeRec.stop(); return; }
  btn.classList.add('on');
  activeRec = Voice.listen({
    onResult: t => onTexts(t),
    onError: m => toast(m, true),
    onEnd: () => { btn.classList.remove('on'); activeRec = null; },
  });
}
// diktiranje u polje za pretragu
function bindDictation(btnId, input) {
  const b = document.getElementById(btnId); if (!b) return;
  b.onclick = () => startVoice(b, t => { input.value = t[0]; input.dispatchEvent(new Event('input')); });
}

// ---------- dijalog ----------
function dialog(html, onSubmit, { wide } = {}) {
  const d = $('#dlg'), f = $('#dlgForm');
  f.innerHTML = html + `<p class="err" id="dlgErr"></p>`;
  d.style.width = wide ? 'min(900px, calc(100vw - 24px))' : '';
  f.onsubmit = async ev => {
    const btn = ev.submitter;
    if (btn && btn.value === 'cancel') return;
    ev.preventDefault();
    if (!onSubmit) return d.close();
    try { if (btn) btn.disabled = true; const keep = await onSubmit(new FormData(f), btn?.value); if (keep !== true) d.close(); }
    catch (e) { $('#dlgErr').textContent = e.message; }
    finally { if (btn) btn.disabled = false; }
  };
  d.showModal();
  const first = f.querySelector('input:not([type=hidden]),select,textarea'); if (first) first.focus();
  return f;
}
const cancelBtn = (t = 'Odustani') => `<button class="btn" value="cancel" formnovalidate>${t}</button>`;
function confirmDlg(text, okText = 'Potvrdi', danger = false) {
  return new Promise(res => {
    dialog(`<h2>Potvrda</h2><p>${text}</p><div class="row end">${cancelBtn()}<button class="btn ${danger ? 'danger' : 'primary'}" value="ok">${esc(okText)}</button></div>`, async () => res(true));
    $('#dlg').addEventListener('close', () => res(false), { once: true });
  });
}

// ---------- prijava ----------
let loginMode = 'pin';
function showLogin(mode) {
  $('#app').classList.add('hidden'); $('#login').classList.remove('hidden');
  loginMode = mode === 'setup' ? 'setup' : 'pin';
  $('#setupFields').classList.toggle('hidden', loginMode !== 'setup');
  $('#pinField').classList.toggle('hidden', loginMode === 'setup');
  $('#loginHint').textContent = loginMode === 'setup'
    ? 'Prvo pokretanje: postavi svoj PIN za inventuru. Za potvrdu upiši PIN osoblja koji već koristiš u aplikaciji kartice.'
    : 'Upiši svoj PIN.';
  $('#loginBtn').textContent = loginMode === 'setup' ? 'Postavi PIN i uđi' : 'Prijava';
}
$('#loginForm').addEventListener('submit', async e => {
  e.preventDefault(); $('#loginErr').textContent = '';
  const f = new FormData(e.target);
  try {
    if (loginMode === 'setup') await api('/setup', { method: 'POST', body: { adminPin: f.get('adminPin'), newPin: f.get('newPin'), name: f.get('name') } });
    else await api('/login', { method: 'POST', body: { pin: f.get('pin') } });
    e.target.reset(); start();
  } catch (err) { $('#loginErr').textContent = err.message; }
});
$('#logoutBtn').onclick = async () => { await api('/logout', { method: 'POST' }).catch(() => {}); showLogin(); };
$('#menuBtn').onclick = () => $('#side').classList.toggle('open');

async function start() {
  const st = await fetch('/inventura/api/status').then(r => r.json());
  if (!st.user) return showLogin(st.mode);
  S.meta = await api('/meta');
  S.loc = S.meta.locations[0]?.id;
  $('#locName').textContent = 'Lokacija: ' + (S.meta.locations[0]?.name || '');
  $('#login').classList.add('hidden'); $('#app').classList.remove('hidden');
  route();
}
async function reloadMeta() { S.meta = await api('/meta'); }

// ---------- usmjeravanje ----------
const ROUTES = {};
async function route() {
  const [r, arg] = location.hash.replace(/^#\/?/, '').split('?')[0].split('/');
  $$('#side a').forEach(a => a.classList.toggle('on', a.dataset.r === ({ inventura: 'povijest', normativ: 'normativi' }[r] || r)));
  $('#side').classList.remove('open');
  view.innerHTML = '<p class="muted">Učitavam…</p>';
  try { await (ROUTES[r] || ROUTES[''])(arg); } catch (e) { if (e.message !== 'Prijavi se.') view.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
  view.focus({ preventScroll: true });
}
window.addEventListener('hashchange', route);

// ---------- sortiranje tablica ----------
function sortable(table, rows, render, initial) {
  let key = initial?.key, dir = initial?.dir || 1;
  const draw = () => {
    const sorted = key ? [...rows].sort((a, b) => {
      const x = a[key], y = b[key];
      if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1;
      return (typeof x === 'number' ? x - y : String(x).localeCompare(String(y), 'hr')) * dir;
    }) : rows;
    render(sorted);
    $$('th.sort', table).forEach(th => th.className = 'sort' + (th.dataset.k === key ? (dir > 0 ? ' asc' : ' desc') : '') + (th.classList.contains('num') ? ' num' : ''));
  };
  $$('th.sort', table).forEach(th => th.onclick = () => { if (key === th.dataset.k) dir = -dir; else { key = th.dataset.k; dir = 1; } draw(); });
  draw();
}

// ======================= NADZORNA PLOČA =======================
ROUTES[''] = async () => {
  const d = await api('/dashboard?location=' + S.loc);
  const open = d.open, last = d.last_closed;
  view.innerHTML = `
    <div class="head"><h1>Nadzorna ploča</h1><a class="btn primary" href="#/nova-inventura">${open ? 'Nastavi inventuru' : 'Nova inventura'}</a></div>
    ${open ? `<div class="banner"><div><b>Inventura u tijeku:</b> ${esc(open.name)} · ${fd(open.inv_date)} · prebrojano ${open.summary.counted}/${open.summary.total}</div><a class="btn" href="#/inventura/${open.id}">Otvori</a></div>` : ''}
    <div class="grid">
      <div class="card stat"><div class="v">${fe(d.total_cents)}</div><div class="l">Vrijednost zaliha (nabavne cijene bez PDV-a)</div></div>
      <div class="card stat"><div class="v">${d.articles}</div><div class="l">Aktivnih artikala</div></div>
      <a class="card stat ${d.below_min ? 'warn' : ''}" href="#/izvjestaji" style="text-decoration:none"><div class="v">${d.below_min}</div><div class="l">Ispod minimalne zalihe</div></a>
      <div class="card stat ${d.negative ? 'warn' : ''}"><div class="v">${d.negative}</div><div class="l">S negativnim knjižnim stanjem</div></div>
      <div class="card stat ${d.unpriced ? 'warn' : ''}"><div class="v">${d.unpriced}</div><div class="l">Bez nabavne cijene (nisu u vrijednosti)</div></div>
    </div>
    ${last ? `<div class="card section"><h2>Zadnja zaključena inventura</h2>
      <div class="row"><a href="#/inventura/${last.id}">${esc(last.name)}</a><span class="muted">${fd(last.inv_date)}</span>
      <span class="chip manjak">manjak ${fe(last.summary.shortageCents)}</span><span class="chip visak">višak ${fe(last.summary.surplusCents, true)}</span>
      <b class="${sgn(last.summary.netCents)}">neto ${fe(last.summary.netCents, true)}</b></div></div>` : ''}
    <div class="card section"><h2>Vrijednost po kategorijama</h2><div class="tbl-wrap"><table>
      <thead><tr><th>Kategorija</th><th class="num">Artikala</th><th class="num">Vrijednost</th></tr></thead>
      <tbody>${d.categories.map(c => `<tr><td>${esc(c.category)}</td><td class="num">${c.articles}${c.unpriced ? ` <span class="muted small">(${c.unpriced} bez cijene)</span>` : ''}</td><td class="num">${fe(c.value_cents)}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td>Ukupno</td><td class="num">${d.articles}</td><td class="num">${fe(d.total_cents)}</td></tr></tfoot></table></div></div>
    <div class="card section"><h2>Zadnje promjene</h2>${movTable(d.recent)}</div>
    <p class="note section">Knjižno stanje = početno stanje iz Remarisa (${esc(d.pocetno?.datum ? fd(d.pocetno.datum) : '—')})
      ${d.lastRemaris ? ` + usklađenje s Remarisom ${fd(d.lastRemaris.datum)}` : ''} + promjene upisane ovdje + inventurne razlike.
      Prodaja se bilježi u Remarisu — prije inventure uvezi svježi izvještaj „Skladišna stanja” (Postavke → Uvoz iz Remarisa).</p>`;
};

function movTable(rows) {
  if (!rows.length) return '<p class="muted">Nema promjena.</p>';
  const T = S.meta.movementTypes;
  return `<div class="tbl-wrap"><table><thead><tr><th>Datum</th><th>Vrsta</th><th>Artikl</th><th class="num">Količina</th><th>Razlog</th><th>Korisnik</th></tr></thead><tbody>
    ${rows.map(m => `<tr><td>${fd(m.movement_date)}</td><td>${esc(T[m.type]?.label || m.type)}</td><td>${esc(m.article)} <span class="muted small">${esc(m.code)}</span></td>
      <td class="num ${sgn(m.qty_e4)}">${m.qty_e4 > 0 ? '+' : ''}${fq(m.qty_e4)} ${esc(m.unit)}</td><td class="small">${esc(m.reason)}</td><td class="small muted">${esc(m.user || 'sustav')}</td></tr>`).join('')}
  </tbody></table></div>`;
}

// ======================= ARTIKLI =======================
const AF = { q: '', category: '', active: '1', belowMin: false };
ROUTES.artikli = async () => {
  view.innerHTML = `<div class="head"><h1>Artikli</h1><div class="row"><a class="btn" href="${csvUrl('stock')}">CSV</a><button class="btn primary" id="newArt">+ Novi artikl</button></div></div>
    <div class="row" style="margin-bottom:12px">
      <input type="search" id="q" class="grow" placeholder="Traži po nazivu, šifri, dobavljaču…" value="${esc(AF.q)}">${micHtml('qMic', 'Izgovori naziv')}
      <select id="fc"><option value="">Sve kategorije</option>${S.meta.categories.map(c => `<option value="${c.id}" ${String(c.id) === AF.category ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
      <select id="fa"><option value="1">Aktivni</option><option value="0">Neaktivni</option><option value="">Svi</option></select>
      <label class="c"><input type="checkbox" id="fm" ${AF.belowMin ? 'checked' : ''}> Ispod minimuma</label>
    </div><div id="artList"></div>`;
  $('#fa').value = AF.active;
  const load = async () => {
    const rows = await api('/articles?' + new URLSearchParams({ location: S.loc, q: AF.q, category: AF.category, active: AF.active, belowMin: AF.belowMin ? '1' : '' }));
    $('#artList').innerHTML = `<p class="muted small">${rows.length} artikala</p><div class="tbl-wrap"><table id="artT"><thead><tr>
      <th class="sort" data-k="code">Šifra</th><th class="sort" data-k="name">Naziv</th><th class="sort" data-k="category">Kategorija</th><th>Jed.</th>
      <th class="sort num" data-k="stock_e4">Knjižno stanje</th><th class="sort num" data-k="purchase_price_e4">Nab. cijena</th><th class="sort num" data-k="value_cents">Vrijednost</th><th class="num">Min.</th></tr></thead><tbody></tbody></table></div>`;
    sortable($('#artT'), rows, list => {
      $('#artT tbody').innerHTML = list.map(a => `<tr class="click ${a.active ? '' : 'inactive'}" data-id="${a.id}">
        <td class="muted small">${esc(a.code)}</td><td>${esc(a.name)}${a.packagings.length ? ` <span class="chip">${a.packagings.map(p => esc(p.name)).join(', ')}</span>` : ''}</td>
        <td class="small">${esc(a.category || '')}</td><td>${esc(a.unit)}</td>
        <td class="num ${a.stock_e4 < 0 ? 'neg' : ''}">${fq(a.stock_e4)}${a.below_min ? ' <span class="chip manjak">min</span>' : ''}</td>
        <td class="num">${fp(a.purchase_price_e4)}</td><td class="num">${a.purchase_price_e4 == null ? '<span class="muted">bez cijene</span>' : fe(a.value_cents)}</td><td class="num muted">${fq(a.min_qty_e4)}</td></tr>`).join('');
      $$('#artT tbody tr').forEach(tr => tr.onclick = () => editArticle(rows.find(a => a.id === Number(tr.dataset.id)), load));
    });
  };
  let t; $('#q').oninput = e => { AF.q = e.target.value; clearTimeout(t); t = setTimeout(load, 200); };
  $('#fc').onchange = e => { AF.category = e.target.value; load(); };
  $('#fa').onchange = e => { AF.active = e.target.value; load(); };
  $('#fm').onchange = e => { AF.belowMin = e.target.checked; load(); };
  $('#newArt').onclick = () => editArticle(null, load);
  bindDictation('qMic', $('#q'));
  await load();
};

function articleForm(a) {
  const U = S.meta.units;
  return `<div class="form">
    <label class="f">Šifra<input name="code" value="${esc(a?.code || '')}" placeholder="automatski" maxlength="30"></label>
    <label class="f" style="grid-column:span 2">Naziv *<input name="name" required maxlength="120" value="${esc(a?.name || '')}"></label>
    <label class="f">Kategorija<input name="category" list="catList" value="${esc(a?.category || '')}"></label>
    <label class="f">Dobavljač<input name="supplier" value="${esc(a?.supplier || '')}" maxlength="120"></label>
    <label class="f">Osnovna jedinica *<select name="unit" required ${a && a.stock_e4 !== undefined && a.id ? 'title="Ne može se mijenjati ako artikl ima knjižene količine"' : ''}>
      ${Object.entries(U).map(([k, u]) => `<option value="${k}" ${a?.unit === k ? 'selected' : ''}>${k} — ${u.name}</option>`).join('')}</select></label>
    <label class="f">Nabavna cijena bez PDV-a (€ / jed.)<input name="purchase_price" inputmode="decimal" value="${a?.purchase_price_e4 != null ? fq(a.purchase_price_e4).replace(/\./g, '') : ''}"></label>
    <label class="f">Stopa PDV-a<select name="vat_rate"><option value="">—</option>${[25, 13, 5, 0].map(v => `<option value="${v}" ${a?.vat_rate === v ? 'selected' : ''}>${v} %</option>`).join('')}</select></label>
    <label class="f">Minimalna zaliha<input name="min_qty" inputmode="decimal" value="${a?.min_qty_e4 != null ? fq(a.min_qty_e4).replace(/\./g, '') : ''}"></label>
    <label class="c"><input type="checkbox" name="active" ${!a || a.active ? 'checked' : ''}> Aktivan</label>
  </div>
  <datalist id="catList">${S.meta.categories.map(c => `<option value="${esc(c.name)}">`).join('')}</datalist>
  ${a?.price_source ? `<p class="muted small">Izvor cijene: ${esc(a.price_source)}</p>` : ''}`;
}
function editArticle(a, reload) {
  const pk = a ? `<div class="card"><h3>Pakiranja</h3>
      <p class="muted small">Npr. „Gajba 24” = 24 ${esc(a.unit)}, „Boca 0,7 l” = 0,7 ${esc(a.unit)}. Pri brojanju upisuješ broj pakiranja, a aplikacija preračuna u ${esc(a.unit)}.</p>
      <div id="pkList">${a.packagings.map(p => `<div class="row" style="justify-content:space-between;padding:4px 0"><span>${esc(p.name)} = ${fq(p.qty_e4)} ${esc(a.unit)}</span><button type="button" class="btn sm danger" data-del="${p.id}">Ukloni</button></div>`).join('') || '<p class="muted small">Nema pakiranja.</p>'}</div>
      <div class="row"><input id="pkName" placeholder="Naziv (npr. Gajba 24)" class="grow"><input id="pkQty" placeholder="${esc(a.unit)} u pakiranju" inputmode="decimal" style="width:130px"><button type="button" class="btn sm" id="pkAdd">Dodaj</button></div></div>` : '';
  const f = dialog(`<h2>${a ? 'Uredi artikl' : 'Novi artikl'}</h2>${articleForm(a)}${pk}
    <div class="row end">${a ? `<a class="btn" href="#/promjene?a=${a.id}" onclick="document.getElementById('dlg').close()">Promjene</a>` : ''}${cancelBtn()}<button class="btn primary" value="save">Spremi</button></div>`,
  async fd => {
    const body = Object.fromEntries(fd); body.active = fd.get('active') === 'on';
    if (a) await api('/articles/' + a.id, { method: 'PUT', body }); else await api('/articles', { method: 'POST', body });
    toast('Spremljeno.'); await reloadMeta(); reload();
  }, { wide: true });
  if (a) {
    $('#pkAdd', f).onclick = async () => {
      try { await api(`/articles/${a.id}/packagings`, { method: 'POST', body: { name: $('#pkName').value, qty: $('#pkQty').value } }); $('#dlg').close(); toast('Pakiranje dodano.'); await reload(); }
      catch (e) { $('#dlgErr').textContent = e.message; }
    };
    $$('[data-del]', f).forEach(b => b.onclick = async () => { try { await api('/packagings/' + b.dataset.del, { method: 'DELETE' }); $('#dlg').close(); toast('Uklonjeno.'); reload(); } catch (e) { $('#dlgErr').textContent = e.message; } });
  }
}

// ======================= KATEGORIJE =======================
ROUTES.kategorije = async () => {
  await reloadMeta();
  view.innerHTML = `<div class="head"><h1>Kategorije</h1><button class="btn primary" id="newCat">+ Nova kategorija</button></div>
    <div class="tbl-wrap"><table><thead><tr><th>Redoslijed</th><th>Naziv</th><th class="num">Artikala</th><th></th></tr></thead><tbody>
    ${S.meta.categories.map(c => `<tr><td class="muted">${c.sort}</td><td>${esc(c.name)}</td><td class="num">${c.article_count}</td>
      <td class="num"><button class="btn sm" data-ed="${c.id}">Uredi</button> <button class="btn sm danger" data-del="${c.id}" ${c.article_count ? 'disabled title="Kategorija ima artikle"' : ''}>Obriši</button></td></tr>`).join('')}
    </tbody></table></div><p class="note section">Redoslijed kategorija koristi se i na listi za brojanje (kao u Remarisu).</p>`;
  const edit = c => dialog(`<h2>${c ? 'Uredi' : 'Nova'} kategorija</h2><div class="form"><label class="f">Naziv<input name="name" required value="${esc(c?.name || '')}"></label>
    <label class="f">Redoslijed<input name="sort" type="number" min="0" value="${c?.sort ?? ''}"></label></div><div class="row end">${cancelBtn()}<button class="btn primary" value="ok">Spremi</button></div>`,
  async fd => { const body = { name: fd.get('name'), sort: fd.get('sort') === '' ? undefined : Number(fd.get('sort')) };
    await api('/categories' + (c ? '/' + c.id : ''), { method: c ? 'PUT' : 'POST', body }); toast('Spremljeno.'); ROUTES.kategorije(); });
  $('#newCat').onclick = () => edit(null);
  $$('[data-ed]').forEach(b => b.onclick = () => edit(S.meta.categories.find(c => c.id === Number(b.dataset.ed))));
  $$('[data-del]').forEach(b => b.onclick = async () => { if (!await confirmDlg('Obrisati kategoriju?', 'Obriši', true)) return; api('/categories/' + b.dataset.del, { method: 'DELETE' }).then(() => { toast('Obrisano.'); ROUTES.kategorije(); }, fail); });
};

// ======================= PROMJENE ZALIHA =======================
const MF = { type: '', from: '', to: '' };
ROUTES.promjene = async () => {
  const pre = new URLSearchParams(location.hash.split('?')[1] || '').get('a');
  const arts = await api('/articles?active=1&location=' + S.loc);
  const T = S.meta.movementTypes;
  const manual = Object.entries(T).filter(([, t]) => t.manual);
  view.innerHTML = `<div class="head"><h1>Promjene zaliha</h1><a class="btn" id="mcsv" href="#">CSV</a></div>
    <form class="card" id="mvForm"><h2>Nova promjena</h2><div class="form">
      <label class="f" style="grid-column:span 2">Artikl *<span class="row" style="flex-wrap:nowrap"><input name="art" list="artList" required placeholder="Počni tipkati naziv ili šifru (ili 🎤 „jamnica dvije gajbe”)" autocomplete="off" class="grow">${micHtml('mvMic', 'Izgovori artikl i količinu')}</span></label>
      <label class="f">Vrsta *<select name="type">${manual.map(([k, t]) => `<option value="${k}">${esc(t.label)}</option>`).join('')}</select></label>
      <label class="f">Datum *<input name="date" type="date" required value="${today()}" max="${today()}"></label>
      <label class="f">Količina *<input name="qty" required inputmode="decimal" placeholder="npr. 24 ili 1,5"></label>
      <label class="f">U jedinici / pakiranju<select name="unitSel"><option value="">— osnovna jedinica —</option></select></label>
      <label class="f" id="priceF">Nabavna cijena bez PDV-a (€ / osn. jed.)<input name="price" inputmode="decimal" placeholder="neobavezno"></label>
      <label class="f" style="grid-column:span 2">Razlog / napomena<input name="reason" maxlength="200" placeholder="obavezno za otpis i korekciju"></label>
    </div><p class="muted small" id="mvHint"></p><div class="row end"><button class="btn primary">Knjiži</button></div></form>
    <datalist id="artList">${arts.map(a => `<option value="${esc(a.code)} · ${esc(a.name)}">`).join('')}</datalist>
    <div class="card section"><div class="head"><h2>Popis promjena</h2><div class="row">
      <select id="mt"><option value="">Sve vrste</option>${Object.entries(T).map(([k, t]) => `<option value="${k}">${esc(t.label)}</option>`).join('')}</select>
      <input type="date" id="mfrom" title="Od"><input type="date" id="mto" title="Do"></div></div><div id="mvList"></div></div>`;
  const form = $('#mvForm');
  const findArt = v => arts.find(a => `${a.code} · ${a.name}` === v) || arts.find(a => a.code === v.trim());
  let cur = null;
  const upd = () => {
    cur = findArt(form.art.value);
    const sel = form.unitSel; const t = form.type.value;
    sel.innerHTML = '<option value="">— osnovna jedinica —</option>';
    if (cur) {
      const dim = S.meta.units[cur.unit].dim;
      Object.entries(S.meta.units).filter(([k, u]) => u.dim === dim && k !== cur.unit).forEach(([k]) => sel.add(new Option(k, 'u:' + k)));
      cur.packagings.forEach(p => sel.add(new Option(`${p.name} (${fq(p.qty_e4)} ${cur.unit})`, 'p:' + p.id)));
      $('#mvHint').textContent = `Knjižno stanje: ${fq(cur.stock_e4)} ${cur.unit} · osnovna jedinica: ${cur.unit}` + (t === 'korekcija' ? ' · za korekciju upiši + ili − (npr. −2)' : '');
    } else $('#mvHint').textContent = t === 'korekcija' ? 'Za korekciju upiši + ili − (npr. −2).' : '';
    $('#priceF').classList.toggle('hidden', t !== 'nabava');
  };
  form.art.oninput = upd; form.type.onchange = upd;
  const mvMic = $('#mvMic');
  if (mvMic) mvMic.onclick = () => startVoice(mvMic, texts => {
    for (const t of texts) {
      const p = Voice.parseUtterance(t); const m = Voice.matchArticles(p.query, arts)[0];
      if (!m) continue;
      form.art.value = `${m.item.code} · ${m.item.name}`; upd();
      if (p.qty != null) form.qty.value = String(p.qty).replace('.', ',');
      const r = Voice.resolveUnit(p, m.item);
      if (r.packagingId) form.unitSel.value = 'p:' + r.packagingId; else if (r.unit) form.unitSel.value = 'u:' + r.unit;
      if (r.error) toast(r.error, true); else toast(`Čuo sam: „${t}”`);
      return;
    }
    toast(`Nisam prepoznao artikl: „${texts[0]}”`, true);
  });
  if (pre) { const a = arts.find(x => x.id === Number(pre)); if (a) form.art.value = `${a.code} · ${a.name}`; MF.article = pre; } else MF.article = '';
  upd();
  form.onsubmit = async e => {
    e.preventDefault();
    if (!cur) return toast('Odaberi artikl s popisa.', true);
    const u = form.unitSel.value;
    try {
      await api('/movements', { method: 'POST', body: { articleId: cur.id, locationId: S.loc, type: form.type.value, qty: form.qty.value.replace('−', '-'), date: form.date.value, reason: form.reason.value,
        unit: u.startsWith('u:') ? u.slice(2) : undefined, packagingId: u.startsWith('p:') ? Number(u.slice(2)) : undefined, unitPrice: form.type.value === 'nabava' ? form.price.value : undefined } });
      toast('Knjiženo.'); form.qty.value = ''; form.reason.value = ''; form.price.value = '';
      const fresh = await api('/articles?active=1&location=' + S.loc); arts.splice(0, arts.length, ...fresh); upd(); loadList();
    } catch (err) { fail(err); }
  };
  const loadList = async () => {
    const q = { location: S.loc, type: MF.type, from: MF.from, to: MF.to, article: MF.article || '' };
    $('#mcsv').href = csvUrl('movements', { type: MF.type, from: MF.from, to: MF.to });
    const rows = await api('/movements?' + new URLSearchParams(q));
    $('#mvList').innerHTML = (MF.article ? `<p class="small">Prikaz za jedan artikl · <a href="#/promjene">prikaži sve</a></p>` : '') + movTable(rows);
  };
  $('#mt').value = MF.type; $('#mfrom').value = MF.from; $('#mto').value = MF.to;
  $('#mt').onchange = e => { MF.type = e.target.value; loadList(); };
  $('#mfrom').onchange = e => { MF.from = e.target.value; loadList(); };
  $('#mto').onchange = e => { MF.to = e.target.value; loadList(); };
  await loadList();
};

// ======================= NOVA INVENTURA =======================
ROUTES['nova-inventura'] = async () => {
  const invs = await api('/inventories');
  const open = invs.find(i => i.status === 'u_tijeku');
  if (open) { location.replace('#/inventura/' + open.id); return; }
  const lr = S.meta.lastRemaris, ps = S.meta.pocetno;
  view.innerHTML = `<h1>Nova inventura</h1>
    <div class="note" style="margin-bottom:16px">Očekivano (knjižno) stanje uzima se iz aplikacije u trenutku otvaranja.
      Zadnji podaci iz Remarisa: <b>${lr ? fd(lr.datum) : ps ? fd(ps.datum) + ' (početno stanje)' : '—'}</b>.
      Ako je od tada bilo prodaje, prvo <a href="#/postavke">uvezi svježi izvještaj „Skladišna stanja”</a> iz Remarisa.</div>
    <form class="card" id="niForm"><div class="form">
      <label class="f">Naziv<input name="name" placeholder="npr. Mjesečna inventura listopad"></label>
      <label class="f">Datum inventure *<input name="date" type="date" required value="${today()}"></label>
      <label class="f">Lokacija<select name="loc">${S.meta.locations.map(l => `<option value="${l.id}">${esc(l.name)}</option>`).join('')}</select></label>
      <label class="f" style="grid-column:1/-1">Napomena<input name="note" maxlength="300"></label>
    </div><div class="row end" style="margin-top:12px"><button class="btn primary">Otvori inventuru</button></div></form>`;
  $('#niForm').onsubmit = async e => {
    e.preventDefault(); const f = e.target;
    try { const r = await api('/inventories', { method: 'POST', body: { name: f.name.value, date: f.date.value, locationId: Number(f.loc.value), note: f.note.value } }); location.hash = '#/inventura/' + r.id; }
    catch (err) { fail(err); }
  };
};

// ======================= BROJANJE / PREGLED INVENTURE =======================
const IF = { q: '', show: 'sve' };
ROUTES.inventura = async id => {
  const d = await api('/inventories/' + id);
  const inv = d.inventory, open = inv.status === 'u_tijeku';
  const s = d.summary;
  view.innerHTML = `
    <div class="head"><div><h1>${esc(inv.name)}</h1><div class="muted small">${fd(inv.inv_date)} · ${esc(inv.location)} · ${open ? '<span class="chip open">u tijeku</span>' : `<span class="chip">zaključena ${fdt(inv.closed_at)}</span>`}${inv.note ? ' · ' + esc(inv.note) : ''}</div></div>
      <div class="row no-print">
        <a class="btn" href="${csvUrl('inventory/' + inv.id)}">CSV</a>
        ${open ? `<button class="btn" id="refresh" title="Postavi očekivano na trenutno knjižno stanje">Osvježi očekivano</button>
        <button class="btn danger" id="delInv">Obriši</button><button class="btn primary" id="review">Pregled i zaključivanje</button>` : '<button class="btn" onclick="print()">Ispis</button>'}
      </div></div>
    <div class="sticky-sum"><div class="grid">
      <div class="card stat"><div class="v">${s.counted} / ${s.total}</div><div class="l">Prebrojano</div></div>
      <div class="card stat"><div class="v neg">${fe(s.shortageCents)}</div><div class="l">Manjak (${s.shortageCount})</div></div>
      <div class="card stat"><div class="v pos">${fe(s.surplusCents, true)}</div><div class="l">Višak (${s.surplusCount})</div></div>
      <div class="card stat"><div class="v ${sgn(s.netCents)}">${fe(s.netCents, true)}</div><div class="l">Neto razlika</div></div>
    </div>
    <div class="row no-print" style="margin-top:10px">
      <input type="search" id="iq" class="grow" placeholder="Traži artikl…" value="${esc(IF.q)}">
      ${open && VOICE ? `<button type="button" class="btn primary mic" id="cntMic" title="Glasovno brojanje">🎤 Izgovori</button>` : ''}
      ${open ? `<label class="btn primary mic" id="cntCam" title="Brojanje sa slike">📷 Slikaj<input type="file" id="cntCamFile" accept="image/*" capture="environment" hidden></label>` : ''}
      <select id="ishow"><option value="sve">Svi</option><option value="neprebrojano">Neprebrojani</option><option value="razlike">Samo razlike</option><option value="prebrojano">Prebrojani</option></select>
    </div></div>
    ${open && VOICE ? `<p class="muted small no-print">Glasovno brojanje: pritisni 🎤 i reci naziv i količinu, npr. „coca cola dvadeset četiri”, „jamnica dvije gajbe”, „limun jedan i pol kila”. Prije upisa potvrđuješ.</p>` : ''}
    ${open && !VOICE ? `<p class="muted small no-print">Glasovni unos nije podržan u ovom pregledniku (koristi Chrome ili Safari).</p>` : ''}
    ${open ? `<p class="muted small no-print">Brojanje sa slike: pritisni 📷 i uslikaj policu ili hladnjak. AI prepozna artikle s popisa i predloži količine, a ti ih prije upisa provjeriš.</p>` : ''}
    ${s.unpricedDiffs ? `<p class="note">${s.unpricedDiffs} razlika nema nabavnu cijenu pa nisu uključene u vrijednost. Dodaj cijenu u Artiklima.</p>` : ''}
    <div class="tbl-wrap"><table id="cntT"><thead><tr><th>Artikl</th><th class="num">Očekivano</th><th>${open ? 'Unos' : ''}</th><th class="num">Prebrojano</th><th class="num">Razlika</th><th class="num">Vrijednost</th></tr></thead><tbody></tbody></table></div>`;
  $('#ishow').value = IF.show;
  const draw = () => {
    const t = IF.q.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
    let rows = d.items.filter(i => !t || (i.name + ' ' + i.code).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').includes(t));
    if (IF.show === 'neprebrojano') rows = rows.filter(i => i.kind === 'neprebrojano');
    if (IF.show === 'prebrojano') rows = rows.filter(i => i.kind !== 'neprebrojano');
    if (IF.show === 'razlike') rows = rows.filter(i => i.kind === 'visak' || i.kind === 'manjak');
    let lastCat = null; const out = [];
    for (const i of rows) {
      if (i.category !== lastCat) { lastCat = i.category; out.push(`<tr class="cat"><td colspan="6">${esc(i.category || 'Bez kategorije')}</td></tr>`); }
      const units = Object.entries(S.meta.units).filter(([k, u]) => u.dim === S.meta.units[i.unit].dim && k !== i.unit);
      out.push(`<tr class="count-row" data-id="${i.id}">
        <td>${esc(i.name)} <span class="muted small">${esc(i.code)}</span>${i.note ? `<div class="small muted">📝 ${esc(i.note)}</div>` : ''}
          ${i.counts.length > 1 || (i.counts.length === 1 && i.counts[0].input_label !== fq(i.counts[0].qty_e4) + ' ' + i.unit) ? `<div class="entries">${i.counts.map(c => `${esc(c.input_label)}${open ? `<button title="Ukloni unos" data-dc="${c.id}">×</button>` : ''}`).join(' + ')}</div>` : ''}
          ${i.corrections.length ? `<div class="entries">Ispravci: ${i.corrections.map(c => `${fq(c.old_qty_e4)} → ${fq(c.new_qty_e4)} (${esc(c.reason)}, ${fdt(c.created_at)})`).join('; ')}</div>` : ''}</td>
        <td class="num">${fq(i.expected_qty_e4)} ${esc(i.unit)}${open && i.book_now_e4 !== i.expected_qty_e4 ? `<div class="small neg" title="Od otvaranja inventure knjižene su promjene">sada ${fq(i.book_now_e4)}</div>` : ''}</td>
        <td>${open ? `<div class="cnt"><input inputmode="decimal" aria-label="Količina" placeholder="0">
            <select aria-label="Jedinica"><option value="">${esc(i.unit)}</option>${units.map(([k]) => `<option value="u:${k}">${k}</option>`).join('')}${i.packagings.map(p => `<option value="p:${p.id}">${esc(p.name)}</option>`).join('')}</select>
            <button class="btn sm" data-act="set" title="Postavi kao ukupnu količinu">=</button><button class="btn sm" data-act="add" title="Dodaj na već prebrojano">+</button>
            <button class="btn sm" data-act="more" title="Napomena / poništi">⋯</button></div>`
          : `<button class="btn sm no-print" data-act="correct">Ispravak</button>`}</td>
        <td class="num">${i.counted_qty_e4 == null ? '<span class="muted">—</span>' : fq(i.counted_qty_e4) + ' ' + esc(i.unit)}</td>
        <td class="num"><span class="chip ${i.kind}">${i.diff_e4 == null ? KIND[i.kind] : (i.diff_e4 > 0 ? '+' : '') + fq(i.diff_e4)}</span></td>
        <td class="num ${sgn(i.diff_cents)}">${i.diff_cents == null ? '' : i.price_e4 == null ? '<span class="muted small">bez cijene</span>' : fe(i.diff_cents, true)}</td></tr>`);
    }
    $('#cntT tbody').innerHTML = out.join('') || '<tr><td colspan="6" class="muted">Nema artikala za prikaz.</td></tr>';
  };
  draw();
  $('#iq').oninput = e => { IF.q = e.target.value; draw(); };
  $('#ishow').onchange = e => { IF.show = e.target.value; draw(); };
  const reload = async () => { const y = scrollY; await ROUTES.inventura(id); scrollTo(0, y); };

  $('#cntT').addEventListener('click', async e => {
    const tr = e.target.closest('tr[data-id]'); if (!tr) return;
    const item = d.items.find(i => i.id === Number(tr.dataset.id));
    if (e.target.dataset.dc) { try { await api('/counts/' + e.target.dataset.dc, { method: 'DELETE' }); await reload(); } catch (x) { fail(x); } return; }
    const act = e.target.dataset.act; if (!act) return;
    if (act === 'set' || act === 'add') {
      const inp = $('input', tr), sel = $('select', tr); const v = inp.value.trim();
      if (!v) { inp.focus(); return toast('Upiši količinu.', true); }
      const u = sel.value;
      try {
        await api(`/items/${item.id}/count`, { method: act === 'set' ? 'PUT' : 'POST', body: { qty: v, unit: u.startsWith('u:') ? u.slice(2) : undefined, packagingId: u.startsWith('p:') ? Number(u.slice(2)) : undefined } });
        const next = tr.nextElementSibling?.classList.contains('cat') ? tr.nextElementSibling.nextElementSibling : tr.nextElementSibling;
        const nextId = next?.dataset.id;
        await reload();
        if (nextId) $(`tr[data-id="${nextId}"] input`)?.focus();
      } catch (x) { fail(x); }
    }
    if (act === 'more') {
      dialog(`<h2>${esc(item.name)}</h2><label class="f">Napomena<input name="note" value="${esc(item.note || '')}" maxlength="200"></label>
        <div class="row end"><button class="btn danger" value="clear" ${item.counted_qty_e4 == null ? 'disabled' : ''}>Poništi brojanje</button>${cancelBtn()}<button class="btn primary" value="ok">Spremi napomenu</button></div>`,
      async (fd, b) => { if (b === 'clear') await api(`/items/${item.id}/count`, { method: 'DELETE' }); else await api(`/items/${item.id}/note`, { method: 'PUT', body: { note: fd.get('note') } }); await reload(); });
    }
    if (act === 'correct') {
      dialog(`<h2>Ispravak: ${esc(item.name)}</h2><p class="muted small">Inventura je zaključena. Ispravak se bilježi u povijesti s razlogom, a razlika se knjiži kao „Ispravak zaključene inventure”.</p>
        <div class="form"><label class="f">Prebrojano dosad<input disabled value="${fq(item.counted_qty_e4)} ${esc(item.unit)}"></label>
        <label class="f">Ispravna količina (${esc(item.unit)}) *<input name="qty" required inputmode="decimal"></label>
        <label class="f" style="grid-column:1/-1">Razlog *<input name="reason" required minlength="3" maxlength="300"></label></div>
        <div class="row end">${cancelBtn()}<button class="btn primary" value="ok">Spremi ispravak</button></div>`,
      async fd => { await api(`/items/${item.id}/correct`, { method: 'POST', body: { qty: fd.get('qty'), reason: fd.get('reason') } }); toast('Ispravak spremljen.'); await reload(); });
    }
  });
  $('#cntT').addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches('.cnt input')) { e.preventDefault(); e.target.closest('tr').querySelector('[data-act=set]').click(); } });

  if (open && $('#cntMic')) $('#cntMic').onclick = () => startVoice($('#cntMic'), texts => voiceCount(texts));
  if (open && $('#cntCamFile')) $('#cntCamFile').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) photoCount(f); };
  async function photoCount(file) {
    const cam = $('#cntCam'); cam.classList.add('on'); toast('Prepoznajem artikle na slici…');
    let r;
    try { r = await Photo.recognize(id, file); } catch (x) { return fail(x); } finally { cam.classList.remove('on'); }
    const rows = r.items.map((x, k) => ({ x, k, it: d.items.find(i => i.id === x.itemId) })).filter(o => o.it);
    if (!rows.length) return toast('Na slici nisam prepoznao artikle s popisa.' + (r.unknown.length ? ' Vidim: ' + r.unknown.join(', ') : ''), true);
    const SURE = { visoka: 'slaze_se', srednja: 'open', niska: 'manjak' };
    const unitOpts = (it, pid) => `<option value="">${esc(it.unit)}</option>` + Object.entries(S.meta.units).filter(([k, u]) => u.dim === S.meta.units[it.unit].dim && k !== it.unit).map(([k]) => `<option value="u:${k}">${k}</option>`).join('') + it.packagings.map(x => `<option value="p:${x.id}" ${x.id === pid ? 'selected' : ''}>${esc(x.name)}</option>`).join('');
    dialog(`<h2>📷 Prepoznato na slici</h2>
      <p class="muted small">Provjeri i po potrebi ispravi količine. Upisuju se samo označeni artikli.</p>
      <div class="tbl-wrap"><table><thead><tr><th></th><th>Artikl</th><th>Količina</th><th>Jedinica</th><th>Sigurnost</th></tr></thead><tbody>
      ${rows.map(({ x, it, k }) => `<tr><td><input type="checkbox" name="on${k}" ${x.sure === 'niska' ? '' : 'checked'} aria-label="Upiši"></td>
        <td>${esc(it.name)} <div class="muted small">prebrojano ${it.counted_qty_e4 == null ? 'ništa' : fq(it.counted_qty_e4) + ' ' + esc(it.unit)}</div>${x.note ? `<div class="small muted">📝 ${esc(x.note)}</div>` : ''}</td>
        <td><input name="q${k}" inputmode="decimal" style="width:6em" value="${String(x.qty).replace('.', ',')}" aria-label="Količina"></td>
        <td><select name="u${k}" aria-label="Jedinica">${unitOpts(it, x.packagingId)}</select></td>
        <td><span class="chip ${SURE[x.sure] || ''}">${esc(x.sure)}</span></td></tr>`).join('')}
      </tbody></table></div>
      ${r.unknown.length ? `<p class="note small">Nije s popisa: ${r.unknown.map(esc).join(', ')}</p>` : ''}
      <div class="row end">${cancelBtn()}<button class="btn" value="add" title="Dodaj na već prebrojano">+ Dodaj</button><button class="btn primary" value="set" title="Postavi kao ukupnu količinu">= Postavi</button></div>`,
    async (fd, b) => {
      const done = new Set(); let n = 0;
      for (const { it, k } of rows) {
        if (fd.get('on' + k) !== 'on') continue;
        const q = String(fd.get('q' + k) || '').trim(); if (!q) continue;
        const u = fd.get('u' + k) || '';
        const put = b === 'set' && !done.has(it.id); done.add(it.id);
        try { await api(`/items/${it.id}/count`, { method: put ? 'PUT' : 'POST', body: { qty: q, unit: u.startsWith('u:') ? u.slice(2) : undefined, packagingId: u.startsWith('p:') ? Number(u.slice(2)) : undefined } }); }
        catch (x) { throw new Error(`${it.name}: ${x.message}` + (n ? ` (${n} artikala je već upisano i odznačeno)` : '')); }
        n++; const cb = $(`#dlgForm [name=on${k}]`); if (cb) cb.checked = false;
      }
      if (!n) throw new Error('Nijedan artikl nije označen.');
      toast(`Upisano artikala: ${n}`);
      await reload();
    }, { wide: true });
  }
  function voiceCount(texts) {
    let p = null, cands = [], heard = texts[0];
    for (const t of texts) { const pp = Voice.parseUtterance(t); const c = Voice.matchArticles(pp.query, d.items); if (c.length && pp.qty != null) { p = pp; cands = c; heard = t; break; } if (!p && c.length) { p = pp; cands = c; heard = t; } }
    if (!p || !cands.length) return toast(`Nisam prepoznao artikl: „${heard}”`, true);
    const top = cands.slice(0, 4);
    dialog(`<h2>🎤 „${esc(heard)}”</h2>
      <div class="form"><label class="f" style="grid-column:1/-1">Artikl<select name="item">${top.map((c, k) => `<option value="${c.item.id}" ${k === 0 ? 'selected' : ''}>${esc(c.item.name)} (${esc(c.item.unit)}) — prebrojano ${c.item.counted_qty_e4 == null ? 'ništa' : fq(c.item.counted_qty_e4)}</option>`).join('')}</select></label>
      <label class="f">Količina<input name="qty" inputmode="decimal" required value="${p.qty == null ? '' : String(p.qty).replace('.', ',')}"></label>
      <label class="f">Jedinica / pakiranje<select name="u" id="vU"></select></label></div>
      <label class="c"><input type="checkbox" name="again" ${localStorage.getItem('invVoiceAgain') === '1' ? 'checked' : ''}> Nakon upisa odmah slušaj sljedeći artikl</label>
      <div class="row end">${cancelBtn()}<button class="btn" value="add" title="Dodaj na već prebrojano">+ Dodaj</button><button class="btn primary" value="set">= Postavi</button></div>`,
    async (fd, b) => {
      const item = d.items.find(i => i.id === Number(fd.get('item'))); const u = fd.get('u') || '';
      try { localStorage.setItem('invVoiceAgain', fd.get('again') === 'on' ? '1' : '0'); } catch {}
      await api(`/items/${item.id}/count`, { method: b === 'add' ? 'POST' : 'PUT', body: { qty: fd.get('qty'), unit: u.startsWith('u:') ? u.slice(2) : undefined, packagingId: u.startsWith('p:') ? Number(u.slice(2)) : undefined } });
      toast(`Upisano: ${item.name}`);
      await reload();
      if (fd.get('again') === 'on' && $('#cntMic')) setTimeout(() => $('#cntMic').click(), 300);
    });
    const fillUnits = () => {
      const it = d.items.find(i => i.id === Number($('#dlgForm [name=item]').value)); const sel = $('#vU');
      sel.innerHTML = `<option value="">${esc(it.unit)}</option>` + Object.entries(S.meta.units).filter(([k, u]) => u.dim === S.meta.units[it.unit].dim && k !== it.unit).map(([k]) => `<option value="u:${k}">${k}</option>`).join('') + it.packagings.map(x => `<option value="p:${x.id}">${esc(x.name)}</option>`).join('');
      const r = Voice.resolveUnit(p, it);
      if (r.packagingId) sel.value = 'p:' + r.packagingId; else if (r.unit) sel.value = 'u:' + r.unit;
      $('#dlgErr').textContent = r.error || '';
    };
    $('#dlgForm [name=item]').onchange = fillUnits; fillUnits();
    $('#dlgForm [name=qty]').focus(); $('#dlgForm [name=qty]').select();
  }

  if (open) {
    $('#refresh').onclick = async () => { if (!await confirmDlg('Očekivane količine i cijene postavit će se na trenutno knjižno stanje. Prebrojane količine ostaju.', 'Osvježi')) return; api(`/inventories/${id}/refresh`, { method: 'POST' }).then(() => { toast('Osvježeno.'); reload(); }, fail); };
    $('#delInv').onclick = async () => { if (!await confirmDlg('Obrisati ovu inventuru u tijeku sa svim unosima? (Zaključene inventure ne mogu se brisati.)', 'Obriši', true)) return; api(`/inventories/${id}`, { method: 'DELETE' }).then(() => { toast('Obrisano.'); location.hash = '#/'; }, fail); };
    $('#review').onclick = () => {
      const diffs = d.items.filter(i => i.kind === 'visak' || i.kind === 'manjak').sort((a, b) => (a.diff_cents ?? 0) - (b.diff_cents ?? 0));
      const changed = d.items.filter(i => i.book_now_e4 !== i.expected_qty_e4 && i.counted_qty_e4 != null).length;
      dialog(`<h2>Pregled prije zaključivanja</h2>
        <div class="grid"><div class="stat"><div class="v">${s.counted}/${s.total}</div><div class="l">prebrojano</div></div>
        <div class="stat"><div class="v neg">${fe(s.shortageCents)}</div><div class="l">manjak</div></div><div class="stat"><div class="v pos">${fe(s.surplusCents, true)}</div><div class="l">višak</div></div>
        <div class="stat"><div class="v ${sgn(s.netCents)}">${fe(s.netCents, true)}</div><div class="l">neto</div></div></div>
        ${s.uncounted ? `<p class="note"><b>${s.uncounted} artikala nije prebrojano.</b> Njihovo knjižno stanje ostat će nepromijenjeno.</p><label class="c"><input type="checkbox" name="allow"> Razumijem, zaključi i bez njih</label>` : ''}
        ${changed ? `<p class="note">Za ${changed} prebrojanih artikala knjiženo je nešto nakon otvaranja inventure — razlika će se računati prema stanju u trenutku zaključivanja.</p>` : ''}
        <h3>Razlike (${diffs.length})</h3><div class="tbl-wrap" style="max-height:40vh;overflow:auto"><table><thead><tr><th>Artikl</th><th class="num">Očekivano</th><th class="num">Prebrojano</th><th class="num">Razlika</th><th class="num">Vrijednost</th></tr></thead><tbody>
        ${diffs.map(i => `<tr><td>${esc(i.name)}</td><td class="num">${fq(i.expected_qty_e4)}</td><td class="num">${fq(i.counted_qty_e4)}</td><td class="num ${sgn(i.diff_e4)}">${i.diff_e4 > 0 ? '+' : ''}${fq(i.diff_e4)} ${esc(i.unit)}</td><td class="num ${sgn(i.diff_cents)}">${i.price_e4 == null ? 'bez cijene' : fe(i.diff_cents, true)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">Nema razlika.</td></tr>'}
        </tbody></table></div>
        <p class="muted small">Zaključivanjem se za svaki prebrojani artikl knjiži inventurna razlika i knjižno stanje postaje jednako prebrojanom. Zaključena inventura više se ne može mijenjati, osim ispravkom s obrazloženjem.</p>
        <div class="row end">${cancelBtn('Natrag na brojanje')}<button class="btn primary" value="close">Zaključi inventuru</button></div>`,
      async fd => { await api(`/inventories/${id}/close`, { method: 'POST', body: { allowUncounted: fd.get('allow') === 'on' } }); toast('Inventura je zaključena.'); await reload(); }, { wide: true });
    };
  }
};

// ======================= POVIJEST =======================
ROUTES.povijest = async () => {
  const invs = await api('/inventories');
  view.innerHTML = `<div class="head"><h1>Povijest inventura</h1><a class="btn" href="${csvUrl('history')}">CSV</a></div>
    ${invs.length ? `<div class="tbl-wrap"><table><thead><tr><th>Datum</th><th>Naziv</th><th>Lokacija</th><th>Status</th><th class="num">Prebrojano</th><th class="num">Manjak</th><th class="num">Višak</th><th class="num">Neto</th></tr></thead><tbody>
    ${invs.map(i => `<tr class="click" onclick="location.hash='#/inventura/${i.id}'"><td>${fd(i.inv_date)}</td><td><a href="#/inventura/${i.id}">${esc(i.name)}</a></td><td>${esc(i.location)}</td>
      <td>${i.status === 'u_tijeku' ? '<span class="chip open">u tijeku</span>' : '<span class="chip">zaključena</span>'}</td><td class="num">${i.summary.counted}/${i.summary.total}</td>
      <td class="num neg">${fe(i.summary.shortageCents)}</td><td class="num pos">${fe(i.summary.surplusCents, true)}</td><td class="num ${sgn(i.summary.netCents)}"><b>${fe(i.summary.netCents, true)}</b></td></tr>`).join('')}
    </tbody></table></div>` : '<p class="muted">Još nema inventura. <a href="#/nova-inventura">Otvori prvu.</a></p>'}`;
};

// ======================= IZVJEŠTAJI =======================
ROUTES.izvjestaji = async () => {
  const [st, invs] = await Promise.all([api('/reports/stock?location=' + S.loc), api('/inventories')]);
  const below = st.rows.filter(a => a.below_min);
  const unpriced = st.rows.filter(a => a.purchase_price_e4 == null);
  view.innerHTML = `<h1>Izvještaji</h1>
    <div class="grid"><div class="card stat"><div class="v">${fe(st.total_cents)}</div><div class="l">Ukupna vrijednost zaliha</div></div>
      <div class="card stat"><div class="v">${st.articles}</div><div class="l">Aktivnih artikala</div></div>
      <div class="card stat ${unpriced.length ? 'warn' : ''}"><div class="v">${unpriced.length}</div><div class="l">Bez nabavne cijene</div></div></div>
    <div class="note section"><b>Metoda vrednovanja:</b> količina × <b>zadnja nabavna cijena bez PDV-a</b> po osnovnoj jedinici (izvor: Remaris analiza primki, skladište Glavno; nakon toga zadnja upisana nabava).
      Prodajne cijene i PDV se ne koriste i ne miješaju. Artikli s negativnim knjižnim stanjem ne ulaze u vrijednost zaliha (vrijednost 0), a artikli bez cijene su navedeni zasebno.
      Razlike inventure vrednuju se po cijeni zabilježenoj u trenutku otvaranja (ili osvježavanja) inventure.</div>

    <div class="card section"><div class="head"><h2>Manjkovi i viškovi</h2><div class="row"><select id="rinv">${invs.map(i => `<option value="${i.id}">${fd(i.inv_date)} · ${esc(i.name)}${i.status === 'u_tijeku' ? ' (u tijeku)' : ''}</option>`).join('') || '<option value="">nema inventura</option>'}</select><a class="btn" id="rinvCsv" href="#">CSV razlika</a></div></div><div id="rdiff"></div></div>

    <div class="card section"><div class="head"><h2>Zalihe ispod minimuma (${below.length})</h2><a class="btn" href="${csvUrl('below-min')}">CSV</a></div>
      ${below.length ? `<div class="tbl-wrap"><table><thead><tr><th>Artikl</th><th>Dobavljač</th><th class="num">Stanje</th><th class="num">Minimum</th><th class="num">Nedostaje</th></tr></thead><tbody>
      ${below.map(a => `<tr><td>${esc(a.name)}</td><td class="small">${esc(a.supplier || '')}</td><td class="num">${fq(a.stock_e4)} ${esc(a.unit)}</td><td class="num">${fq(a.min_qty_e4)}</td><td class="num neg">${fq(a.min_qty_e4 - a.stock_e4)}</td></tr>`).join('')}</tbody></table></div>`
      : '<p class="muted">Nijedan artikl nije ispod minimuma. Minimalnu zalihu postavljaš u Artiklima.</p>'}</div>

    <div class="card section"><div class="head"><h2>Po kategorijama</h2><a class="btn" href="${csvUrl('categories')}">CSV</a></div><div class="tbl-wrap"><table><thead><tr><th>Kategorija</th><th class="num">Artikala</th><th class="num">Bez cijene</th><th class="num">Vrijednost</th></tr></thead><tbody>
      ${st.categories.map(c => `<tr><td>${esc(c.category)}</td><td class="num">${c.articles}</td><td class="num muted">${c.unpriced || ''}</td><td class="num">${fe(c.value_cents)}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td>Ukupno</td><td class="num">${st.articles}</td><td class="num">${st.unpriced}</td><td class="num">${fe(st.total_cents)}</td></tr></tfoot></table></div></div>

    <div class="card section"><div class="head"><h2>Artikli bez nabavne cijene (${unpriced.length})</h2></div>
      ${unpriced.length ? `<p class="small">${unpriced.map(a => `<a href="#/artikli" data-q="${esc(a.name)}">${esc(a.name)}</a>`).join(' · ')}</p>` : '<p class="muted">Svi artikli imaju cijenu.</p>'}</div>

    <div class="card section"><div class="head"><h2>Ostali izvozi</h2></div><div class="row">
      <a class="btn" href="${csvUrl('stock')}">Stanje i vrijednost zaliha (CSV)</a><a class="btn" href="${csvUrl('movements')}">Sve promjene zaliha (CSV)</a><a class="btn" href="${csvUrl('history')}">Povijest inventura (CSV)</a></div></div>`;
  $$('[data-q]').forEach(a => a.onclick = () => { AF.q = a.dataset.q; AF.active = ''; });
  const showDiff = async () => {
    const id = $('#rinv').value; if (!id) { $('#rdiff').innerHTML = '<p class="muted">Nema inventura.</p>'; return; }
    $('#rinvCsv').href = csvUrl('inventory/' + id, { only: 'razlike' });
    const d = await api('/inventories/' + id);
    const sh = d.items.filter(i => i.kind === 'manjak').sort((a, b) => (a.diff_cents ?? 0) - (b.diff_cents ?? 0));
    const su = d.items.filter(i => i.kind === 'visak').sort((a, b) => (b.diff_cents ?? 0) - (a.diff_cents ?? 0));
    const tbl = (list, cls) => list.length ? `<div class="tbl-wrap"><table><thead><tr><th>Artikl</th><th class="num">Očekivano</th><th class="num">Prebrojano</th><th class="num">Razlika</th><th class="num">Vrijednost</th></tr></thead><tbody>
      ${list.map(i => `<tr><td>${esc(i.name)}</td><td class="num">${fq(i.expected_qty_e4)}</td><td class="num">${fq(i.counted_qty_e4)}</td><td class="num ${cls}">${i.diff_e4 > 0 ? '+' : ''}${fq(i.diff_e4)} ${esc(i.unit)}</td><td class="num ${cls}">${i.price_e4 == null ? 'bez cijene' : fe(i.diff_cents, true)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">Nema.</p>';
    $('#rdiff').innerHTML = `<p>Manjak <b class="neg">${fe(d.summary.shortageCents)}</b> · višak <b class="pos">${fe(d.summary.surplusCents, true)}</b> · neto <b class="${sgn(d.summary.netCents)}">${fe(d.summary.netCents, true)}</b> · neprebrojano ${d.summary.uncounted}</p>
      <h3>Manjkovi (${sh.length})</h3>${tbl(sh, 'neg')}<h3 style="margin-top:12px">Viškovi (${su.length})</h3>${tbl(su, 'pos')}`;
  };
  $('#rinv').onchange = showDiff; await showDiff();
};

// ======================= POSTAVKE =======================
ROUTES.postavke = async () => {
  await reloadMeta();
  const ps = S.meta.pocetno, lr = S.meta.lastRemaris;
  view.innerHTML = `<h1>Postavke</h1>
    <div class="card"><h2>Uvoz iz Remarisa</h2>
      <p class="small">U Remarisu otvori <b>Izvještaji → Skladišna stanja</b> (skladište Glavno), spremi kao PDF i odaberi ga ovdje. Aplikacija prikaže razlike, a nakon potvrde knjižno stanje postaje jednako Remarisovom (promjena vrste „Usklađenje s Remarisom”; prodaja i primke iz Remarisa tako ulaze u aplikaciju).</p>
      <p class="muted small">Početno stanje: ${ps ? esc(ps.izvor) : '—'}${lr ? ` · zadnji uvoz: stanje na ${fd(lr.datum)} (${lr.promjena} promjena, ${lr.novih} novih artikala)` : ''}</p>
      <div class="row"><input type="file" id="pdf" accept="application/pdf,.pdf"><button class="btn" id="parse">Pročitaj PDF</button></div><div id="rprev"></div></div>
    <div class="card"><h2>Lokacije</h2><p class="small">${S.meta.locations.map(l => esc(l.name)).join(', ')}</p>
      <div class="row"><input id="newLoc" placeholder="Nova lokacija (npr. Šank)"><button class="btn" id="addLoc">Dodaj</button></div>
      <p class="muted small">Trenutno sučelje radi s prvom lokacijom (Glavno), jednako kao skladište u Remarisu.</p></div>
    <div class="card"><h2>PIN</h2>${S.meta.pinMode === 'env' ? '<p class="small">PIN je zadan na serveru (varijabla INVENTURA_PIN na Renderu) i mijenja se ondje.</p>' : `
      <form id="pinForm" class="form"><label class="f">Trenutni PIN<input type="password" name="oldPin" inputmode="numeric" required></label><label class="f">Novi PIN (4–12 znamenki)<input type="password" name="newPin" inputmode="numeric" required></label>
      <div class="row" style="align-items:end"><button class="btn">Promijeni PIN</button></div></form><p class="muted small">Nakon promjene PIN-a odjavljuju se svi ostali uređaji.</p>`}</div>
    <div class="card"><h2>Sigurnosna kopija</h2><p class="small">Preuzmi cijelu bazu inventure (SQLite datoteka). Preporuka: nakon svake zaključene inventure spremi kopiju na računalo.</p>
      <a class="btn" href="/inventura/api/backup">Preuzmi kopiju baze</a></div>
    <div class="card"><h2>Dnevnik promjena</h2><div id="audit"><button class="btn" id="loadAudit">Prikaži zadnjih 300 zapisa</button></div></div>`;

  let parsed = null;
  $('#parse').onclick = async () => {
    const file = $('#pdf').files[0]; if (!file) return toast('Odaberi PDF.', true);
    $('#rprev').innerHTML = '<p class="muted">Čitam PDF…</p>';
    try {
      parsed = await api('/remaris/parse?location=' + S.loc, { method: 'POST', raw: file });
      const p = parsed.preview; const ch = p.rows.filter(r => r.diff_e4 !== 0 || r.created);
      $('#rprev').innerHTML = `<p>Pročitano <b>${parsed.items.length}</b> artikala, stanje na <b>${fd(parsed.datum) || '?'}</b>. Promjena: <b>${p.updated}</b>, novih artikala: <b>${p.created}</b>, bez promjene: ${p.unchanged}.</p>
        ${ch.length ? `<div class="tbl-wrap" style="max-height:50vh;overflow:auto"><table><thead><tr><th>Artikl</th><th class="num">U aplikaciji</th><th class="num">Remaris</th><th class="num">Razlika</th></tr></thead><tbody>
        ${ch.map(r => `<tr><td>${esc(r.name)}${r.created ? ' <span class="chip open">novi</span>' : ''}</td><td class="num">${fq(r.book_e4)}</td><td class="num">${fq(r.remaris_e4)}</td><td class="num ${sgn(r.diff_e4)}">${r.diff_e4 > 0 ? '+' : ''}${fq(r.diff_e4)}</td></tr>`).join('')}</tbody></table></div>` : ''}
        <div class="row" style="margin-top:10px"><label class="f">Datum stanja<input type="date" id="rdate" value="${parsed.datum || today()}"></label><button class="btn primary" id="doImport" ${p.updated || p.created ? '' : 'disabled'}>Potvrdi uvoz</button></div>`;
      $('#doImport').onclick = async () => {
        try { const r = await api('/remaris/import', { method: 'POST', body: { items: parsed.items, date: $('#rdate').value, source: file.name, locationId: S.loc } });
          toast(`Uvezeno: ${r.updated} promjena, ${r.created} novih artikala.`); ROUTES.postavke(); } catch (e) { fail(e); }
      };
    } catch (e) { $('#rprev').innerHTML = `<p class="err">${esc(e.message)}</p>`; }
  };
  $('#addLoc').onclick = () => api('/locations', { method: 'POST', body: { name: $('#newLoc').value } }).then(() => { toast('Dodano.'); ROUTES.postavke(); }, fail);
  $('#pinForm')?.addEventListener('submit', async e => { e.preventDefault(); const f = new FormData(e.target);
    try { await api('/pin', { method: 'POST', body: { oldPin: f.get('oldPin'), newPin: f.get('newPin') } }); e.target.reset(); toast('PIN je promijenjen.'); } catch (x) { fail(x); } });
  $('#loadAudit').onclick = async () => {
    const rows = await api('/audit');
    $('#audit').innerHTML = `<div class="tbl-wrap" style="max-height:60vh;overflow:auto"><table><thead><tr><th>Vrijeme (UTC)</th><th>Objekt</th><th>Radnja</th><th>Razlog</th><th>Korisnik</th></tr></thead><tbody>
      ${rows.map(r => `<tr><td class="small">${fdt(r.created_at)}</td><td class="small">${esc(r.entity)} ${r.entity_id ?? ''}</td><td class="small">${esc(r.action)}</td><td class="small">${esc(r.reason || '')}</td><td class="small">${esc(r.user || 'sustav')}</td></tr>`).join('')}</tbody></table></div>`;
  };
};

start().catch(e => { document.body.innerHTML = `<p class="err" style="padding:20px">${esc(e.message)}</p>`; });
