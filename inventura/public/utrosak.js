// NOMAd Inventura — normativi, uvoz prodaje i kontrola utroška (koristi pomoćne funkcije iz app.js)
'use strict';
const fpct = e4 => (e4 == null ? '—' : (e4 > 0 ? '+' : '') + fq(e4, 1) + ' %');
const MATCH = { normativ: 'normativ', artikl: 'artikl 1:1', nema: 'nema normativa' };
const matchChip = m => `<span class="chip ${m === 'nema' ? 'manjak' : m === 'artikl' ? 'slaze_se' : 'visak'}">${MATCH[m]}</span>`;
const lineText = l => l.article_id ? `${esc(l.article)} ${fq(l.qty_e4)} ${esc(l.article_unit)}` : `${esc(l.sub_recipe)} ×${fq(l.qty_e4)} <span class="muted small">(normativ)</span>`;

// ======================= NORMATIVI =======================
const NF = { q: '', flagged: false };
ROUTES.normativi = async () => {
  view.innerHTML = `<div class="head"><h1>Normativi</h1><button class="btn primary" id="newRec">+ Novi normativ</button></div>
    <div class="row" style="margin-bottom:12px"><input type="search" id="nq" class="grow" placeholder="Traži prodajni artikl ili šifru…" value="${esc(NF.q)}">${micHtml('nqMic', 'Izgovori naziv')}
      <label class="c"><input type="checkbox" id="nfl" ${NF.flagged ? 'checked' : ''}> Samo s napomenom za provjeru</label></div>
    <p class="note" style="margin-bottom:12px">Normativ kaže koliko se sastojaka troši za jednu prodanu porciju. Izmjena stvara <b>novu verziju</b> s datumom početka važenja; stare verzije ostaju i koriste se za prodaju iz ranijeg razdoblja.
      Normativi su preuzeti iz Remarisa (važe od 1.1.2026.). Napomene ⚠ označavaju količine koje izgledaju sumnjivo — provjeri ih.</p>
    <div id="recList"></div>`;
  const load = async () => {
    let rows = await api('/recipes?' + new URLSearchParams({ q: NF.q }));
    if (NF.flagged) rows = rows.filter(r => r.flagged || r.current?.note);
    $('#recList').innerHTML = `<p class="muted small">${rows.length} normativa</p><div class="tbl-wrap"><table id="recT"><thead><tr>
      <th class="sort" data-k="sale_code">Šifra</th><th class="sort" data-k="name">Prodajni artikl</th><th>Sastojci (trenutna verzija)</th><th class="sort num" data-k="cost_cents">Trošak porcije</th><th>Vrijedi od</th></tr></thead><tbody></tbody></table></div>`;
    sortable($('#recT'), rows, list => {
      $('#recT tbody').innerHTML = list.map(r => `<tr class="click" data-id="${r.id}"><td class="muted small">${esc(r.sale_code || '')}</td>
        <td>${esc(r.name)}${r.flagged || r.current?.note ? ' <span class="chip manjak" title="Napomena za provjeru">⚠</span>' : ''}</td>
        <td class="small">${r.current ? r.current.lines.map(lineText).join(' · ') : '<span class="muted">nema verzije</span>'}</td>
        <td class="num">${r.cost_cents == null ? '<span class="muted small">—</span>' : fe(r.cost_cents)}</td>
        <td class="small">${r.current ? fd(r.current.valid_from) + (r.versions > 1 ? ` <span class="chip">${r.versions} verzije</span>` : '') : ''}</td></tr>`).join('');
      $$('#recT tbody tr').forEach(tr => tr.onclick = () => (location.hash = '#/normativ/' + tr.dataset.id));
    });
  };
  let t; $('#nq').oninput = e => { NF.q = e.target.value; clearTimeout(t); t = setTimeout(load, 200); };
  $('#nfl').onchange = e => { NF.flagged = e.target.checked; load(); };
  bindDictation('nqMic', $('#nq'));
  $('#newRec').onclick = () => recipeEditor(null, null);
  await load();
};

ROUTES.normativ = async id => {
  const r = await api('/recipes/' + id);
  const cur = r.versions.find(v => v.valid_from <= today()) || r.versions[0];
  view.innerHTML = `<div class="head"><div><a href="#/normativi" class="small">← Normativi</a><h1>${esc(r.name)}</h1><div class="muted small">Šifra ${esc(r.sale_code || '—')} · trošak porcije danas: <b>${r.cost_cents == null ? 'nepoznat (sastojak bez cijene)' : fe(r.cost_cents)}</b></div></div>
    <button class="btn primary" id="newVer">Nova verzija</button></div>
    ${r.usedIn.length ? `<p class="small">Koristi se u: ${r.usedIn.map(u => `<a href="#/normativ/${u.id}">${esc(u.name)}</a>`).join(', ')}</p>` : ''}
    ${r.versions.map(v => `<div class="card section"><div class="head"><h2>Verzija ${v.version} ${v === cur ? '<span class="chip open">vrijedi danas</span>' : v.valid_from > today() ? '<span class="chip">buduća</span>' : '<span class="chip">povijest</span>'}</h2>
      <span class="muted small">vrijedi od ${fd(v.valid_from)} · ${esc(v.source || '')}${v.user ? ' · ' + esc(v.user) : ''} · upisano ${fdt(v.created_at)}</span></div>
      ${v.yield_loss_pct_e4 ? `<p class="small">Gubitak pripreme: ${fq(v.yield_loss_pct_e4, 2)} % — potrošnja sirovine = količina × (1 + gubitak)</p>` : ''}
      ${v.note ? `<p class="note">${esc(v.note)}</p>` : ''}
      <div class="tbl-wrap"><table><thead><tr><th>Sastojak</th><th class="num">Količina po porciji</th><th class="num">Cijena</th><th>Napomena</th></tr></thead><tbody>
      ${v.lines.map(l => `<tr><td>${l.article_id ? esc(l.article) + (l.article_active ? '' : ' <span class="chip" title="Nije na popisu za inventuru">neaktivan</span>') : `<a href="#/normativ/${l.sub_recipe_id}">${esc(l.sub_recipe)}</a> <span class="muted small">(normativ)</span>`}</td>
        <td class="num">${fq(l.qty_e4)} ${l.article_id ? esc(l.article_unit) : 'porcija'}</td><td class="num small">${l.article_id ? fp(l.purchase_price_e4) : ''}</td>
        <td class="small">${l.note ? '⚠ ' + esc(l.note) : ''}</td></tr>`).join('')}</tbody></table></div></div>`).join('')}`;
  $('#newVer').onclick = () => recipeEditor(r, cur);
};

async function recipeEditor(r, base) {
  const [arts, recs] = await Promise.all([api('/articles?active='), api('/recipes')]);
  const opts = arts.map(a => `<option value="A:${a.id}">${esc(a.code)} · ${esc(a.name)} (${esc(a.unit)})${a.active ? '' : ' – neaktivan'}</option>`).join('')
    + recs.filter(x => !r || x.id !== r.id).map(x => `<option value="N:${x.id}">Normativ: ${esc(x.sale_code || '')} · ${esc(x.name)}</option>`).join('');
  const unitOpts = (sel, chosen) => {
    if (!sel || sel.startsWith('N:')) return '<option value="">porcija</option>';
    const a = arts.find(x => x.id === Number(sel.slice(2))); if (!a) return '';
    const dim = S.meta.units[a.unit].dim;
    return Object.entries(S.meta.units).filter(([, u]) => u.dim === dim).map(([k]) => `<option value="${k}" ${k === (chosen || a.unit) ? 'selected' : ''}>${k}</option>`).join('');
  };
  const lineRow = (l = {}) => {
    const sel = l.article_id ? 'A:' + l.article_id : l.sub_recipe_id ? 'N:' + l.sub_recipe_id : '';
    return `<div class="row rl" style="margin-bottom:6px"><select class="grow rs" required><option value="">— odaberi sastojak —</option>${opts}</select>
      <input class="rq" inputmode="decimal" placeholder="količina" style="width:100px" value="${l.qty_e4 ? fq(l.qty_e4).replace(/\./g, '') : ''}" required>
      <select class="ru" style="width:90px">${unitOpts(sel)}</select><input class="rn" placeholder="napomena" style="width:160px" value="${esc(l.note || '')}">
      <button type="button" class="btn sm danger rx" title="Ukloni">×</button></div>`.replace(`value="${sel}"`, `value="${sel}" selected`);
  };
  const f = dialog(`<h2>${r ? 'Nova verzija: ' + esc(r.name) : 'Novi normativ'}</h2>
    <div class="form">${r ? '' : `<label class="f">Šifra prodajnog artikla (Remaris)<input name="sale_code" maxlength="20"></label><label class="f" style="grid-column:span 2">Naziv prodajnog artikla *<input name="name" required maxlength="120"></label>`}
      <label class="f">Vrijedi od *<input type="date" name="valid_from" required value="${today()}"></label>
      <label class="f">Gubitak pripreme %<input name="loss" inputmode="decimal" placeholder="0" value="${base?.yield_loss_pct_e4 ? fq(base.yield_loss_pct_e4) : ''}"></label>
      <label class="f" style="grid-column:1/-1">Napomena / razlog izmjene<input name="note" maxlength="300"></label></div>
    <h3>Sastojci po jednoj porciji</h3><p class="muted small">Količinu možeš upisati u bilo kojoj usporedivoj jedinici (npr. 8 g kave za artikl u kg). „Normativ” kao sastojak znači poluproizvod ili drugi prodajni artikl (npr. espresso unutar kave s mlijekom).</p>
    <div id="rlines">${(base?.lines || [{}]).map(lineRow).join('')}</div>
    <button type="button" class="btn sm" id="addLine">+ Dodaj sastojak</button>
    <p class="muted small">Postojeće verzije se ne mijenjaju. Prodaja od datumu „Vrijedi od” računa se po ovoj verziji.</p>
    <div class="row end">${cancelBtn()}<button class="btn primary" value="ok">Spremi verziju</button></div>`,
  async fd => {
    const lines = $$('.rl', f).map(row => { const s = $('.rs', row).value; return { article_id: s.startsWith('A:') ? Number(s.slice(2)) : undefined, sub_recipe_id: s.startsWith('N:') ? Number(s.slice(2)) : undefined,
      qty: $('.rq', row).value, unit: $('.ru', row).value || undefined, note: $('.rn', row).value }; });
    const body = { valid_from: fd.get('valid_from'), yield_loss_pct: fd.get('loss'), note: fd.get('note'), lines, sale_code: fd.get('sale_code'), name: fd.get('name') };
    const res = await api(r ? `/recipes/${r.id}/versions` : '/recipes', { method: 'POST', body });
    toast(`Spremljena verzija ${res.version}.`); location.hash = '#/normativ/' + res.recipeId; if (r) ROUTES.normativ(res.recipeId);
  }, { wide: true });
  const wire = () => $$('.rl', f).forEach(row => {
    $('.rs', row).onchange = () => { $('.ru', row).innerHTML = unitOpts($('.rs', row).value); };
    $('.rx', row).onclick = () => row.remove();
  });
  $('#addLine', f).onclick = () => { $('#rlines', f).insertAdjacentHTML('beforeend', lineRow()); wire(); };
  wire();
}

// ======================= UVOZ PRODAJE =======================
ROUTES.prodaja = async () => {
  const imps = await api('/sales/imports');
  view.innerHTML = `<h1>Uvoz prodaje</h1>
    <div class="card"><h2>Nova datoteka</h2>
      <p class="small">Iz Remarisa: <b>Izvještaji → Promet po artiklima</b> za razdoblje → spremi kao PDF. Može i CSV (npr. iz druge blagajne) — tada odabereš koji je stupac datum, šifra, naziv, količina i broj računa.</p>
      <div class="row"><input type="file" id="sf" accept=".pdf,.csv,.txt,application/pdf,text/csv"><button class="btn" id="sRead">Pročitaj</button></div><div id="sStep"></div></div>
    <div class="card section"><h2>Uvezena prodaja</h2>${imps.length ? `<div class="tbl-wrap"><table><thead><tr><th>Br.</th><th>Razdoblje</th><th>Izvor</th><th class="num">Stavki</th><th class="num">Iznos</th><th>Status</th><th>Uvezeno</th></tr></thead><tbody>
      ${imps.map(i => `<tr class="click ${i.status === 'storniran' ? 'inactive' : ''}" data-id="${i.id}"><td>${i.id}</td><td>${fd(i.period_from)} – ${fd(i.period_to)}</td><td class="small">${esc(i.source)}<div class="muted">${esc(i.file_name || '')}</div></td>
        <td class="num">${i.line_count}</td><td class="num">${fe(i.total_cents)}</td><td>${i.status === 'aktivan' ? '<span class="chip visak">aktivan</span>' : `<span class="chip manjak" title="${esc(i.storno_reason)}">storniran</span>`}</td><td class="small">${fdt(i.created_at)}</td></tr>`).join('')}</tbody></table></div>`
      : '<p class="muted">Još nema uvezene prodaje.</p>'}</div>
    <p class="note section">Povrati i storna u datoteci su negativne količine i smanjuju teorijski utrošak. Ista datoteka ne može se uvesti dvaput, a razdoblja uvoza se ne smiju preklapati (to bi udvostručilo utrošak). Pogrešan uvoz se ne briše nego stornira, uz razlog.</p>`;
  $$('tr[data-id]').forEach(tr => tr.onclick = () => importDetail(Number(tr.dataset.id)));
  let token = null, kind = null;
  const showPreview = (p, extra = {}) => {
    const okTotal = p.reported_total_cents == null || p.reported_total_cents === p.total_cents;
    const block = p.duplicate || p.overlap.length || p.errors.length || !okTotal;
    $('#sPrev').innerHTML = `<div class="grid section"><div class="stat"><div class="v">${fd(p.period_from)} – ${fd(p.period_to)}</div><div class="l">Razdoblje</div></div>
      <div class="stat"><div class="v">${p.lines}</div><div class="l">Stavki</div></div><div class="stat"><div class="v">${fe(p.total_cents)}</div><div class="l">Iznos${p.reported_total_cents != null ? (okTotal ? ' (jednak izvještaju ✓)' : ` (izvještaj: ${fe(p.reported_total_cents)})`) : ''}</div></div>
      <div class="stat ${p.unmatched ? 'warn' : ''}"><div class="v">${p.unmatched}</div><div class="l">Artikala bez normativa</div></div></div>
      ${p.duplicate ? `<p class="err">Ova datoteka je već uvezena (uvoz br. ${p.duplicate.id}).</p>` : ''}
      ${p.overlap.map(o => `<p class="err">Razdoblje se preklapa s uvozom br. ${o.id} (${fd(o.period_from)} – ${fd(o.period_to)}).</p>`).join('')}
      ${p.errors.length ? `<p class="err">${p.errors.length} redaka s pogreškom:</p><div class="tbl-wrap" style="max-height:30vh;overflow:auto"><table><tbody>${p.errors.slice(0, 200).map(e => `<tr><td class="num">red ${e.row}</td><td>${esc(e.error)}</td></tr>`).join('')}</tbody></table></div>` : ''}
      <div class="tbl-wrap section" style="max-height:45vh;overflow:auto"><table><thead><tr><th>Šifra</th><th>Prodajni artikl</th><th class="num">Količina</th><th class="num">Iznos</th><th>Povezano s</th></tr></thead><tbody>
      ${p.preview.map(x => `<tr><td class="muted small">${esc(x.code || '')}</td><td>${esc(x.name)}</td><td class="num ${x.qty_e4 < 0 ? 'neg' : ''}">${fq(x.qty_e4)}</td><td class="num">${fe(x.total_cents)}</td><td>${matchChip(x.match)} <span class="small muted">${esc(x.match_name || '')}</span></td></tr>`).join('')}</tbody></table></div>
      <div class="row end section"><button class="btn primary" id="sDo" ${block ? 'disabled' : ''}>Uvezi prodaju</button></div>`;
    $('#sDo').onclick = async () => {
      if (!await confirmDlg(`Uvesti prodaju ${fd(p.period_from)} – ${fd(p.period_to)} (${p.lines} stavki, ${fe(p.total_cents)})?`, 'Uvezi')) return;
      try { const r = await api('/sales/import', { method: 'POST', body: { token, locationId: S.loc, ...extra } }); toast(`Uvezeno (br. ${r.id}).`); ROUTES.prodaja(); } catch (e) { fail(e); }
    };
  };
  $('#sRead').onclick = async () => {
    const file = $('#sf').files[0]; if (!file) return toast('Odaberi datoteku.', true);
    $('#sStep').innerHTML = '<p class="muted">Čitam…</p>';
    try {
      const isPdf = /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
      if (isPdf) {
        const res = await api(`/sales/pdf?location=${S.loc}&name=${encodeURIComponent(file.name)}`, { method: 'POST', raw: file });
        token = res.token; kind = 'pdf'; $('#sStep').innerHTML = '<div id="sPrev"></div>'; showPreview(res.preview);
      } else {
        const text = await file.text();
        const r = await fetch(`/inventura/api/sales/csv?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'X-Inventura': '1', 'Content-Type': 'text/csv' }, body: text, credentials: 'same-origin' });
        const res = await r.json(); if (!r.ok) throw new Error(res.error || 'Greška.');
        token = res.token; kind = 'csv';
        const F = [['date', 'Datum'], ['code', 'Šifra artikla'], ['name', 'Naziv artikla'], ['qty', 'Količina *'], ['ref', 'Broj računa / dokumenta'], ['price', 'Cijena'], ['total', 'Iznos']];
        const sel = (k) => `<select name="m_${k}"><option value="">— nema —</option>${res.header.map((h, i) => `<option value="${i}" ${res.mapping[k] === i ? 'selected' : ''}>${i + 1}: ${esc(h)}</option>`).join('')}</select>`;
        $('#sStep').innerHTML = `<form id="mapF" class="section"><p class="small">Prepoznato ${res.rows} redaka, separator „${res.delimiter === '\t' ? 'TAB' : esc(res.delimiter)}”. Odaberi stupce:</p>
          <div class="form">${F.map(([k, l]) => `<label class="f">${l}${sel(k)}</label>`).join('')}
          <label class="f">Razdoblje od (ako nema datuma)<input type="date" name="pf"></label><label class="f">do<input type="date" name="pt"></label></div>
          <label class="c"><input type="checkbox" name="hdr" checked> Prvi red je zaglavlje</label>
          <div class="tbl-wrap section"><table><thead><tr>${res.header.map((h, i) => `<th>${i + 1}: ${esc(h)}</th>`).join('')}</tr></thead><tbody>${res.sample.map(r => `<tr>${r.map(c => `<td class="small">${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
          <div class="row end section"><button class="btn">Pregled</button></div></form><div id="sPrev"></div>`;
        $('#mapF').onsubmit = async e => {
          e.preventDefault(); const fd = new FormData(e.target);
          const mapping = Object.fromEntries(F.map(([k]) => [k, fd.get('m_' + k) === '' ? null : Number(fd.get('m_' + k))]));
          const extra = { mapping, header: fd.get('hdr') === 'on', period_from: fd.get('pf') || undefined, period_to: fd.get('pt') || undefined };
          try { const p = await api('/sales/preview', { method: 'POST', body: { token, locationId: S.loc, ...extra } }); showPreview(p, extra); } catch (x) { $('#sPrev').innerHTML = `<p class="err">${esc(x.message)}</p>`; }
        };
      }
    } catch (e) { $('#sStep').innerHTML = `<p class="err">${esc(e.message)}</p>`; }
  };
};
async function importDetail(id) {
  const d = await api('/sales/imports/' + id);
  dialog(`<h2>Uvoz br. ${d.id}: ${fd(d.period_from)} – ${fd(d.period_to)}</h2><p class="small muted">${esc(d.source)} · ${esc(d.file_name || '')} · ${fe(d.total_cents)}${d.status === 'storniran' ? ` · <b class="neg">storniran ${fdt(d.storno_at)}: ${esc(d.storno_reason)}</b>` : ''}</p>
    <div class="tbl-wrap" style="max-height:50vh;overflow:auto"><table><thead><tr><th>Šifra</th><th>Artikl</th><th class="num">Količina</th><th class="num">Iznos</th><th>Povezano s</th></tr></thead><tbody>
    ${d.lines.map(l => `<tr><td class="small muted">${esc(l.code)}</td><td>${esc(l.name)}</td><td class="num">${fq(l.qty_e4)}</td><td class="num">${fe(l.total_cents)}</td><td>${matchChip(l.match)} ${l.recipe_id ? `<a class="small" href="#/normativ/${l.recipe_id}" onclick="document.getElementById('dlg').close()">${esc(l.match_name)}</a>` : `<span class="small muted">${esc(l.match_name || '')}</span>`}</td></tr>`).join('')}</tbody></table></div>
    ${d.status === 'aktivan' ? '<label class="f">Razlog storniranja (ako je uvoz pogrešan)<input name="reason" maxlength="200"></label>' : ''}
    <div class="row end">${cancelBtn('Zatvori')}${d.status === 'aktivan' ? '<button class="btn danger" value="storno">Storniraj uvoz</button>' : ''}</div>`,
  async (fd, b) => { if (b !== 'storno') return; await api(`/sales/imports/${id}/storno`, { method: 'POST', body: { reason: fd.get('reason') } }); toast('Uvoz je storniran.'); ROUTES.prodaja(); }, { wide: true });
}

// ======================= KONTROLA UTROŠKA =======================
const UF = { from: '', to: '' };
ROUTES.utrosak = async () => {
  const [imps, invs] = await Promise.all([api('/sales/imports'), api('/inventories')]);
  const act = imps.filter(i => i.status === 'aktivan');
  if (!UF.from && act.length) { UF.from = act.map(i => i.period_from).sort()[0]; UF.to = act.map(i => i.period_to).sort().pop(); }
  const closed = invs.filter(i => i.status === 'zakljucena').sort((a, b) => a.inv_date.localeCompare(b.inv_date));
  view.innerHTML = `<h1>Kontrola utroška</h1>
    <p class="note">Dvije različite mjere: <b>inventurni manjak/višak</b> (Povijest inventura) uspoređuje prebrojano s knjižnim stanjem. <b>Odstupanje utroška</b> (ovdje) uspoređuje koliko je robe stvarno potrošeno s onim što bi se po normativima trebalo potrošiti za prodano.</p>
    <div class="card section"><div class="head"><h2>Teorijski utrošak po normativima</h2><div class="row"><input type="date" id="uf" value="${UF.from}"><input type="date" id="ut" value="${UF.to}"><button class="btn primary" id="uGo">Izračunaj</button><a class="btn" id="uCsv" href="#">CSV</a></div></div><div id="uRes">${act.length ? '' : '<p class="muted">Prvo <a href="#/prodaja">uvezi prodaju</a>.</p>'}</div></div>
    <div class="card section"><div class="head"><h2>Stvarni naspram teorijskog utroška</h2><div class="row">
      <label class="f">Od<select id="cs"><option value="pocetno">Početno stanje (Remaris)</option>${closed.map(i => `<option value="${i.id}">${fd(i.inv_date)} · ${esc(i.name)}</option>`).join('')}</select></label>
      <label class="f">Do<select id="ce">${closed.map(i => `<option value="${i.id}">${fd(i.inv_date)} · ${esc(i.name)}</option>`).join('') || '<option value="">nema zaključenih inventura</option>'}</select></label>
      <button class="btn primary" id="cGo" ${closed.length ? '' : 'disabled'}>Usporedi</button><a class="btn" id="cCsv" href="#">CSV</a></div></div>
      <p class="muted small">Stvarni utrošak = početno stanje + nabava upisana u aplikaciji − završno prebrojano stanje. Neobjašnjeno = stvarni − teorijski − evidentirani otpis, lom i interno. Potrebne su dvije inventure i uvezena prodaja za razdoblje između njih.</p><div id="cRes"></div></div>`;
  if (closed.length) $('#ce').value = closed[closed.length - 1].id;
  const runT = async () => {
    UF.from = $('#uf').value; UF.to = $('#ut').value; if (!UF.from || !UF.to) return;
    $('#uCsv').href = csvUrl('theoretical', { from: UF.from, to: UF.to });
    $('#uRes').innerHTML = '<p class="muted">Računam…</p>';
    try {
      const t = await api('/consumption/theoretical?' + new URLSearchParams({ location: S.loc, from: UF.from, to: UF.to }));
      const fc = t.sales_cents ? Math.round(t.value_cents / t.sales_cents * 1000) / 10 : null;
      $('#uRes').innerHTML = `<p class="small muted">Razdoblje ${fd(t.from)} – ${fd(t.to)} · uvozi: ${t.imports.map(i => 'br. ' + i.id).join(', ') || 'nijedan'} · osnova: ${esc(t.basis)}</p>
        ${t.excluded.length ? `<p class="note">Isključeni uvozi (samo djelomično u razdoblju): ${t.excluded.map(i => `br. ${i.id} (${fd(i.period_from)} – ${fd(i.period_to)})`).join(', ')}</p>` : ''}
        ${t.warnings.map(w => `<p class="note">${esc(w)}</p>`).join('')}
        <div class="grid"><div class="stat"><div class="v">${fe(t.sales_cents)}</div><div class="l">Prodaja (s PDV-om, iz izvještaja)</div></div><div class="stat"><div class="v">${fe(t.value_cents)}</div><div class="l">Teorijski trošak robe (nabavno, bez PDV-a)</div></div>
          <div class="stat"><div class="v">${fc == null ? '—' : String(fc).replace('.', ',') + ' %'}</div><div class="l">Trošak robe / prodaja (okvirno)</div></div><div class="stat ${t.unmatched.length ? 'warn' : ''}"><div class="v">${t.unmatched.length}</div><div class="l">Prodajnih artikala bez normativa</div></div></div>
        <h3 class="section">Utrošak po sastojku</h3><div class="tbl-wrap" style="max-height:60vh;overflow:auto"><table id="thT"><thead><tr><th class="sort" data-k="name">Sastojak</th><th class="sort num" data-k="qty_e4">Teorijski utrošak</th><th class="sort num" data-k="value_cents">Vrijednost</th><th>Najviše iz</th></tr></thead><tbody></tbody></table></div>
        <h3 class="section">Po prodajnom artiklu</h3><div class="tbl-wrap" style="max-height:50vh;overflow:auto"><table id="rcT"><thead><tr><th class="sort" data-k="name">Prodajni artikl</th><th class="sort num" data-k="qty_e4">Prodano</th><th class="sort num" data-k="total_cents">Prihod</th><th class="sort num" data-k="cost_cents">Trošak po normativu</th><th class="num">Udio troška</th></tr></thead><tbody></tbody></table></div>
        ${t.unmatched.length ? `<h3 class="section">Prodaja bez normativa (nije u utrošku)</h3><div class="tbl-wrap"><table><thead><tr><th>Šifra</th><th>Artikl</th><th class="num">Količina</th><th class="num">Iznos</th><th>Razlog</th></tr></thead><tbody>
        ${t.unmatched.map(u => `<tr><td class="small muted">${esc(u.code || '')}</td><td>${esc(u.name)}</td><td class="num">${fq(u.qty_e4)}</td><td class="num">${fe(u.total_cents)}</td><td class="small">${esc(u.reason)}</td></tr>`).join('')}</tbody></table></div><p class="muted small">Dodaj im normativ (Normativi → Novi normativ, ista šifra kao u Remarisu).</p>` : ''}`;
      sortable($('#thT'), t.articles, list => { $('#thT tbody').innerHTML = list.map(a => `<tr><td>${esc(a.name)}${a.active ? '' : ' <span class="chip">nije na zalihi</span>'}</td><td class="num">${fq(a.qty_e4, 3)} ${esc(a.unit)}</td><td class="num">${a.price_e4 == null ? '<span class="muted small">bez cijene</span>' : fe(a.value_cents)}</td><td class="small muted">${a.sources.slice(0, 3).map(s => esc(s.name)).join(', ')}</td></tr>`).join(''); }, { key: 'value_cents', dir: -1 });
      sortable($('#rcT'), t.recipes, list => { $('#rcT tbody').innerHTML = list.map(r => `<tr><td><a href="#/normativ/${r.recipe_id}">${esc(r.name)}</a></td><td class="num">${fq(r.qty_e4)}</td><td class="num">${fe(r.total_cents)}</td><td class="num">${r.unpriced ? '<span class="muted small">nepotpuno</span>' : fe(r.cost_cents)}</td><td class="num">${r.total_cents > 0 && !r.unpriced ? String(Math.round(r.cost_cents / r.total_cents * 1000) / 10).replace('.', ',') + ' %' : ''}</td></tr>`).join(''); }, { key: 'total_cents', dir: -1 });
    } catch (e) { $('#uRes').innerHTML = `<p class="err">${esc(e.message)}</p>`; }
  };
  const runC = async () => {
    const q = { location: S.loc, start: $('#cs').value, end: $('#ce').value }; if (!q.end) return;
    $('#cCsv').href = csvUrl('compare', { start: q.start, end: q.end });
    $('#cRes').innerHTML = '<p class="muted">Računam…</p>';
    try {
      const c = await api('/consumption/compare?' + new URLSearchParams(q));
      $('#cRes').innerHTML = `<p class="small muted">${esc(c.start)} → ${esc(c.end)} · prodaja ${fd(c.from)} – ${fd(c.to)} · ${esc(c.basis)}</p>
        ${c.warnings.map(w => `<p class="note">${esc(w)}</p>`).join('')}
        <p>Ukupno neobjašnjeno odstupanje: <b class="${sgn(-c.total_unexplained_cents)}">${fe(c.total_unexplained_cents)}</b> <span class="muted small">(pozitivno = potrošeno više nego po normativu)</span></p>
        <div class="tbl-wrap" style="max-height:65vh;overflow:auto"><table><thead><tr><th>Artikl</th><th class="num">Početno</th><th class="num">+ Nabava</th><th class="num">− Završno</th><th class="num">= Stvarni</th><th class="num">Teorijski</th><th class="num">Otpis/lom/interno</th><th class="num">Neobjašnjeno</th><th class="num">%</th><th class="num">Vrijednost</th></tr></thead><tbody>
        ${c.rows.map(r => `<tr><td>${esc(r.name)} <span class="muted small">${esc(r.unit)}</span></td><td class="num">${fq(r.start_e4)}</td><td class="num">${fq(r.purchases_e4)}</td><td class="num">${fq(r.end_e4)}</td><td class="num"><b>${r.complete ? fq(r.actual_e4) : '<span class="muted small">nije prebrojano</span>'}</b></td>
          <td class="num">${fq(r.theoretical_e4)}</td><td class="num">${r.losses_e4 ? fq(r.losses_e4) : ''}</td><td class="num ${sgn(-(r.unexplained_e4 || 0))}">${r.unexplained_e4 == null ? '' : (r.unexplained_e4 > 0 ? '+' : '') + fq(r.unexplained_e4)}</td>
          <td class="num small">${fpct(r.unexplained_pct_e4)}</td><td class="num ${sgn(-(r.unexplained_cents || 0))}">${r.unexplained_cents == null ? '' : r.price_e4 == null ? '<span class="muted small">bez cijene</span>' : fe(r.unexplained_cents, true)}</td></tr>`).join('')}</tbody></table></div>`;
    } catch (e) { $('#cRes').innerHTML = `<p class="err">${esc(e.message)}</p>`; }
  };
  $('#uGo').onclick = runT; $('#cGo').onclick = runC;
  if (act.length) await runT();
};
