// NOMAd Inventura — modul Statistika (usklade, trendovi, kronični gubici)
// Uključiti nakon utrosak.js u index.html: <script src="/inventura/inventura-stats.js"></script>
(function StatsInstall(){
    'use strict';
    if (window.__statsInstalled) return 'already';
    window.__statsInstalled = true;

    // ---------- helpers ----------
    const $ = (s, r) => (r || document).querySelector(s);
    const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const eur = c => c == null ? '—' : (c / 100).toLocaleString('hr-HR', {minimumFractionDigits: 2, maximumFractionDigits: 2}) + ' €';
    const eurSign = c => c == null ? '—' : (c < 0 ? '−' : '+') + eur(Math.abs(c));
    const eurAxis = c => (c / 100).toLocaleString('hr-HR', {maximumFractionDigits: 0}) + ' €';
    const dHr = iso => { if (!iso) return '—'; const p = String(iso).slice(0, 10).split('-'); return p.length === 3 ? `${p[2]}.${p[1]}.${p[0]}.` : String(iso); };
    const dShort = iso => { const p = String(iso).slice(0, 10).split('-'); return p.length === 3 ? `${p[2]}.${p[1]}.` : ''; };
    const daysSince = iso => iso ? Math.floor((Date.now() - new Date(String(iso).replace(' ', 'T'))) / 864e5) : null;
    async function api(path){
      const r = await fetch('/inventura/api' + path, {headers: {'X-Inventura': '1'}, credentials: 'same-origin'});
      if (r.status === 401) throw new Error('Prijavi se.');
      if (!r.ok) throw new Error('API ' + path + ' → ' + r.status);
      return r.json();
    }
    const detailCache = {};
    const invDetail = id => detailCache[id] || (detailCache[id] = api('/inventories/' + id));

    // ---------- css ----------
    const st = document.createElement('style');
    st.textContent = `
.st-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;margin:10px 0 4px}
.st-card{border:1px solid rgba(255,255,255,.14);border-radius:10px;padding:10px 12px}
.st-card.warn{border-color:rgba(214,69,69,.55);background:rgba(214,69,69,.10)}
.st-card.ok{border-color:rgba(63,174,106,.4)}
.st-card .lab{font-size:12px;opacity:.7}
.st-card .val{font-size:20px;font-weight:600;margin:2px 0}
.st-card .hint{font-size:12px;opacity:.65}
.st-sec{margin-top:28px}
.st-chart{width:100%;height:auto;margin-top:8px}
.st-g{stroke:rgba(255,255,255,.08)}
.st-g0{stroke:rgba(255,255,255,.28)}
.st-ylab,.st-xlab{font-size:10px;fill:rgba(255,255,255,.55)}
.st-sh{fill:#d64545}.st-su{fill:#3fae6a}
.st-net{stroke:#4d9de0;stroke-width:2;fill:none}
.st-dot{fill:#4d9de0}
.st-netlab{font-size:10px;fill:#9cc7ee;text-anchor:middle}
.st-neg{color:#e88}.st-pos{color:#7d8}
.st-bar{height:8px;background:#d64545;border-radius:4px;display:inline-block;vertical-align:middle;margin-right:8px}
table.st{width:100%;border-collapse:collapse;margin-top:8px}
table.st th,table.st td{padding:5px 8px;border-bottom:1px solid rgba(255,255,255,.08);text-align:left;font-size:13px}
table.st td.r,table.st th.r{text-align:right}
.st-sel{margin:0 6px 8px 0;padding:5px 8px}
.st-legend{font-size:12px;opacity:.8;display:flex;gap:16px;margin:4px 0}
.st-sw{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:middle}`;
    document.head.appendChild(st);

    // ---------- nav link ----------
    if (!$('#side a[data-r="statistika"]')) {
      const a = document.createElement('a');
      a.href = '#/statistika'; a.dataset.r = 'statistika'; a.textContent = 'Statistika';
      const anchor = $('#side a[data-r="izvjestaji"]');
      if (anchor) anchor.after(a); else $('#side').appendChild(a);
    }

    // ---------- 1) zdravlje podataka ----------
    function healthHtml(dash, meta, salesList, closed){
      const cards = [];
      const card = (warn, label, val, hint) =>
        `<div class="st-card ${warn ? 'warn' : 'ok'}"><div class="lab">${esc(label)}</div><div class="val">${esc(String(val))}</div><div class="hint">${esc(hint || '')}</div></div>`;

      cards.push(card(dash.unpriced > 0, 'Artikala bez nabavne cijene', dash.unpriced ?? 0,
        dash.unpriced > 0 ? 'njihove razlike ne ulaze u vrednovanje inventure' : 'sve se vrednuje'));
      cards.push(card((dash.negative ?? 0) > 0, 'Negativno knjižno stanje', dash.negative ?? 0, 'provjeriti unose i otpise'));
      cards.push(card((dash.below_min ?? 0) > 0, 'Ispod minimalne zalihe', dash.below_min ?? 0, 'kandidati za narudžbu'));

      const lr = dash.lastRemaris || meta.lastRemaris;
      const lrDate = lr && (lr.imported_at || lr.date || lr.created_at || lr.day);
      const lrDays = lrDate ? daysSince(lrDate) : null;
      cards.push(card(!lr || lrDays > 14, 'Zadnji uvoz iz Remarisa',
        lrDate ? dHr(lrDate) : 'nikad', lrDate ? `prije ${lrDays} dana` : 'knjižno stanje ne prati prodaju'));

      if (!salesList.length) {
        cards.push(card(true, 'Uvezene prodaje', 0, 'kontrola utroška i food-cost nemaju podataka'));
      } else {
        const last = salesList[salesList.length - 1];
        const pTo = last && (last.period_to || last.to || last.periodTo);
        const lastInv = closed.length ? closed[closed.length - 1].inv_date : null;
        const gap = lastInv && pTo && String(pTo) < String(lastInv);
        cards.push(card(gap, 'Uvezenih prodaja', salesList.length,
          pTo ? 'zadnja do ' + dHr(pTo) + (gap ? ' — ne pokriva zadnju inventuru' : '') : ''));
      }
      if (dash.open) {
        const oDays = daysSince(dash.open.created_at || dash.open.inv_date);
        cards.push(card(oDays > 7, 'Otvorena inventura', esc(dash.open.name || 'da'), `otvorena prije ${oDays} dana`));
      }
      return `<div class="st-sec"><h2>Zdravlje podataka</h2><div class="st-grid">${cards.join('')}</div></div>`;
    }

    // ---------- 2) trend inventura ----------
    function trendHtml(closed){
      if (!closed.length) return `<div class="st-sec"><h2>Trend inventura</h2><p class="muted">Nema zaključenih inventura.</p></div>`;
      const W = 760, H = 250, P = 40;
      let maxAbs = 1;
      closed.forEach(i => { maxAbs = Math.max(maxAbs, Math.abs(i.summary.shortageCents), i.summary.surplusCents, Math.abs(i.summary.netCents)); });
      const y0 = P + (H - 2 * P) / 2, half = (H - 2 * P) / 2;
      const sy = v => (v / maxAbs) * half;
      const step = (W - 2 * P) / closed.length, bw = Math.min(24, step / 3.2);
      let s = `<svg viewBox="0 0 ${W} ${H}" class="st-chart">`;
      for (const f of [-1, -0.5, 0, 0.5, 1]) {
        const y = y0 - sy(maxAbs * f);
        s += `<line x1="${P}" y1="${y}" x2="${W - P}" y2="${y}" class="${f === 0 ? 'st-g0' : 'st-g'}"/>` +
             `<text x="${P - 5}" y="${y + 3}" class="st-ylab" text-anchor="end">${eurAxis(maxAbs * f)}</text>`;
      }
      const pts = [];
      closed.forEach((inv, i) => {
        const x = P + step * i + step / 2, su = inv.summary.surplusCents, sh = inv.summary.shortageCents;
        const rect = (bx, v, cls) => { const h = Math.abs(sy(v)); const y = v >= 0 ? y0 - h : y0; return `<rect x="${bx.toFixed(1)}" y="${y.toFixed(1)}" width="${bw}" height="${Math.max(h, v ? 1 : 0).toFixed(1)}" class="${cls}"><title>${esc(inv.name)}: ${eur(v)}</title></rect>`; };
        s += rect(x - bw - 1, su, 'st-su') + rect(x + 1, sh, 'st-sh');
        pts.push([x, y0 - sy(inv.summary.netCents), inv.summary.netCents]);
        s += `<text x="${x}" y="${H - P + 14}" class="st-xlab" text-anchor="middle">${dShort(inv.inv_date)}</text>`;
      });
      s += `<polyline class="st-net" points="${pts.map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ')}"/>`;
      pts.forEach(p => {
        s += `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="3.5" class="st-dot"/>`;
        if (closed.length <= 8) s += `<text x="${p[0]}" y="${p[1] - 8}" class="st-netlab">${eur(p[2])}</text>`;
      });
      s += '</svg>';

      let rows = '';
      closed.forEach((inv, i) => {
        const sm = inv.summary;
        const prev = i ? closed[i - 1].summary.netCents : null;
        const d = prev == null ? null : sm.netCents - prev;
        const pct = sm.countedValueCents ? (100 * sm.netCents / sm.countedValueCents) : null;
        rows += `<tr><td><a href="#/inventura/${inv.id}">${esc(inv.name)}</a></td><td>${dHr(inv.inv_date)}</td>
<td class="r">${sm.counted}/${sm.total}</td>
<td class="r st-neg">${eur(sm.shortageCents)}</td><td class="r st-pos">${eurSign(sm.surplusCents)}</td>
<td class="r ${sm.netCents < 0 ? 'st-neg' : 'st-pos'}">${eurSign(sm.netCents)}</td>
<td class="r ${d == null ? '' : d < 0 ? 'st-neg' : 'st-pos'}">${d == null ? '—' : eurSign(d)}</td>
<td class="r">${eur(sm.countedValueCents)}</td>
<td class="r">${pct == null ? '—' : pct.toLocaleString('hr-HR', {maximumFractionDigits: 1}) + ' %'}</td></tr>`;
      });
      return `<div class="st-sec"><h2>Trend inventura</h2>
<div class="st-legend"><span><span class="st-sw" style="background:#3fae6a"></span>višak</span><span><span class="st-sw" style="background:#d64545"></span>manjak</span><span><span class="st-sw" style="background:#4d9de0"></span>neto</span></div>
${s}
<table class="st"><thead><tr><th>Inventura</th><th>Datum</th><th class="r">Prebrojano</th><th class="r">Manjak</th><th class="r">Višak</th><th class="r">Neto</th><th class="r">Δ neto vs prethodna</th><th class="r">Vrijednost zalihe</th><th class="r">Neto % vrijednosti</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    }

    // ---------- 3) usporedba dviju inventura ----------
    function cmpShell(closed){
      const opts = inv => `<option value="${inv.id}">${esc(inv.name)} (${dHr(inv.inv_date)})</option>`;
      const A = closed[Math.max(0, closed.length - 2)], B = closed[closed.length - 1];
      return `<div class="st-sec"><h2>Usporedba dviju inventura (artikal po artikal)</h2>
${closed.length < 2 ? '<p class="muted">Za usporedbu trebaju barem dvije zaključene inventure — pojavit će se nakon sljedeće.</p>' : ''}
<div><label>Starija <select id="stCmpA" class="st-sel">${closed.map(opts).join('')}</select></label>
<label>Novija <select id="stCmpB" class="st-sel">${closed.map(opts).join('')}</select></label></div>
<div id="stCmpOut"></div></div>
<script>0</script>`.replace('<script>0</script>', '') + `
<style>0</style>`.replace('<style>0</style>', '');
    }

    async function runCmp(){
      const out = $('#stCmpOut'); if (!out) return;
      const aId = $('#stCmpA').value, bId = $('#stCmpB').value;
      if (!aId || !bId) return;
      if (aId === bId) { out.innerHTML = '<p class="muted">Odaberite dvije različite inventure.</p>'; return; }
      out.innerHTML = '<p class="muted">Učitavam…</p>';
      const [da, db] = await Promise.all([invDetail(aId), invDetail(bId)]);
      const map = new Map();
      for (const it of da.items) map.set(it.article_id, {code: it.code, name: it.name, unit: it.unit, cat: it.category, A: it.diff_cents ?? 0, qA: it.diff_e4, B: null, qB: null});
      for (const it of db.items) {
        const r = map.get(it.article_id) || {code: it.code, name: it.name, unit: it.unit, cat: it.category, A: null, qA: null};
        r.B = it.diff_cents ?? 0; r.qB = it.diff_e4; map.set(it.article_id, r);
      }
      const rows = [...map.values()].map(r => ({...r, delta: (r.B ?? 0) - (r.A ?? 0)}))
        .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
      const netA = da.summary.netCents, netB = db.summary.netCents;
      const cell = (v, q, unit) => v == null ? '<td class="r muted">nije bilo</td>'
        : `<td class="r ${v < 0 ? 'st-neg' : v > 0 ? 'st-pos' : ''}" title="${(q / 10000).toLocaleString('hr-HR', {maximumFractionDigits: 4})} ${esc(unit)}">${eurSign(v)}</td>`;
      out.innerHTML = `<p>Ukupni neto: <b class="${netA < 0 ? 'st-neg' : 'st-pos'}">${eurSign(netA)}</b> → <b class="${netB < 0 ? 'st-neg' : 'st-pos'}">${eurSign(netB)}</b>
(Δ <b class="${netB - netA < 0 ? 'st-neg' : 'st-pos'}">${eurSign(netB - netA)}</b>)</p>
<table class="st"><thead><tr><th>Kategorija</th><th>Šifra</th><th>Artikl</th><th class="r">Razlika (starija)</th><th class="r">Razlika (novija)</th><th class="r">Δ pogoršanje</th></tr></thead>
<tbody>${rows.map(r => `<tr><td>${esc(r.cat || '')}</td><td>${esc(r.code || '')}</td><td>${esc(r.name)}</td>${cell(r.A, r.qA, r.unit)}${cell(r.B, r.qB, r.unit)}<td class="r ${r.delta < 0 ? 'st-neg' : r.delta > 0 ? 'st-pos' : ''}">${eurSign(r.delta)}</td></tr>`).join('')}</tbody></table>`;
    }

    // ---------- 4) kronični gubici ----------
    function chronicShell(){
      return `<div class="st-sec"><h2>Kronični gubici — kumulativni manjak kroz sve inventure</h2><div id="stChronic"><p class="muted">Učitavam…</p></div></div>`;
    }
    async function loadChronic(closed){
      const box = $('#stChronic'); if (!box) return;
      if (!closed.length) { box.innerHTML = '<p class="muted">Nema zaključenih inventura.</p>'; return; }
      const agg = new Map();
      for (const inv of closed) {
        const d = await invDetail(inv.id);
        for (const it of d.items) {
          const a = agg.get(it.article_id) || {code: it.code, name: it.name, unit: it.unit, cat: it.category, neg: 0, tot: 0, n: 0};
          const dc = it.diff_cents || 0;
          if (dc < 0) { a.neg += dc; a.n++; }
          a.tot += dc;
          agg.set(it.article_id, a);
        }
      }
      const rows = [...agg.values()].filter(a => a.neg < 0).sort((x, y) => x.neg - y.neg).slice(0, 20);
      if (!rows.length) { box.innerHTML = '<p class="muted">Nema zabilježenih manjkova.</p>'; return; }
      const max = Math.abs(rows[0].neg);
      box.innerHTML = `<p class="muted">Analiza ${closed.length} zaključenih inventura. „Ponavlja se“ = u koliko inventura je artikl bio u manjku.</p>
<table class="st"><thead><tr><th>Artikl</th><th>Kategorija</th><th class="r">Kumulativni manjak</th><th class="r">Neto kroz inventure</th><th class="r">Ponavlja se</th></tr></thead>
<tbody>${rows.map(r => `<tr><td><span class="st-bar" style="width:${(Math.abs(r.neg) / max * 110).toFixed(0)}px"></span>${esc(r.name)}</td>
<td>${esc(r.cat || '')}</td><td class="r st-neg">${eur(r.neg)}</td>
<td class="r ${r.tot < 0 ? 'st-neg' : 'st-pos'}">${eurSign(r.tot)}</td>
<td class="r">${r.n}/${closed.length}</td></tr>`).join('')}</tbody></table>`;
    }

    // ---------- glavna ruta ----------
    async function render(){
      const view = document.getElementById('view');
      view.innerHTML = '<div class="head"><h1>Statistika i usporedbe</h1></div><p class="muted">Učitavam…</p>';
      try {
        const [dash, meta, invsRaw, salesRaw] = await Promise.all([
          api('/dashboard'), api('/meta'), api('/inventories'), api('/sales/imports').catch(() => [])
        ]);
        const invList = Array.isArray(invsRaw) ? invsRaw : (invsRaw.inventories || []);
        const closed = invList.filter(i => i.status === 'zakljucena').sort((a, b) => String(a.inv_date).localeCompare(String(b.inv_date)));
        const salesList = Array.isArray(salesRaw) ? salesRaw : (salesRaw.imports || salesRaw.items || []);
        view.innerHTML = '<div class="head"><h1>Statistika i usporedbe</h1></div>'
          + healthHtml(dash, meta, salesList, closed)
          + trendHtml(closed) + cmpShell(closed) + chronicShell();
        if (closed.length) {
          const a = $('#stCmpA'), b = $('#stCmpB');
          if (a && b) {
            a.value = String(closed[Math.max(0, closed.length - 2)].id);
            b.value = String(closed[closed.length - 1].id);
            a.onchange = b.onchange = runCmp;
            if (closed.length >= 2) runCmp();
          }
        }
        loadChronic(closed);
      } catch (e) {
        view.innerHTML = `<p class="err">${esc(e.message)}</p>`;
      }
    }

    // ---------- registracija rute ----------
    let ok = false;
    try { if (typeof ROUTES !== 'undefined') { ROUTES['statistika'] = render; ok = true; } } catch (_) {}
    if (!ok) {
      const h = () => { if (location.hash.replace(/^#\/?/, '').split('?')[0].split('/')[0] === 'statistika') render(); };
      window.addEventListener('hashchange', h);
      h();
    }
    return ok ? 'route-registered' : 'fallback-listener';
  })();
