import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: true, autoRefreshToken: true } });

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const HOURS_ON_LIST = 10;

const SERVICES = ['C', '2C', '3C', 'WS', 'H', 'HC', 'H2C', 'H3C', '1H', '1HC', '1H2C', '1H3C'];
const STATUS_LABEL = {
  found: 'Pending', approved: 'Approved', done: 'Done', waiting_inspection: 'Waiting on Inspection',
  wholesale: 'Wholesale', declined: 'Declined', other: 'Other', voided: 'Voided',
};
const MAKES = ['Acura','Audi','BMW','Buick','Cadillac','Chevy','Chrysler','Dodge','Ford','GMC','Honda','Hyundai','Infiniti','Jeep','Kia','Lexus','Lincoln','Mazda','Mercedes','Mitsubishi','Nissan','Ram','Subaru','Tesla','Toyota','Volkswagen','Volvo'];
const COLORS = ['Black','White','Silver','Gray','Red','Blue','Green','Tan','Brown','Gold','Orange','Maroon','Navy'];

// ---------- local storage (wrapped: storage can throw in private mode) ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { console.warn('storage', e); } },
};

let dealers = store.get('dealers', []);
let dealerId = store.get('dealer', null);
let recent = store.get('recent', []);        // app-entered rows (lot list + today)
let outbox = store.get('outbox', []);        // rows waiting to upload
const index = {};                            // dealerId -> history rows for search

// ---------- pricing (mirrors public.service_lines in the database) ----------
function lines(code, wsPrice) {
  let c = (code || '').toUpperCase();
  if (c === 'WS') return [{ item: 'New Windshield', qty: 1, amount: Number(wsPrice) || 0 }];
  let hl = 0, ch = 0;
  if (c.startsWith('1H')) { hl = 1; c = c.slice(2); } else if (c.startsWith('H')) { hl = 2; c = c.slice(1); }
  if (c === 'C') ch = 1; else if (/^[23]C$/.test(c)) ch = +c[0]; else if (c) return [];
  const out = [];
  if (hl) out.push({ item: 'Headlamp Restoration', qty: hl, amount: hl === 2 ? 125 : 75 });
  if (ch) out.push({ item: '69 Windshield Repair Service', qty: ch, amount: [0, 69, 89, 99][ch] });
  return out;
}
const price = (v) => lines(v.service_code, v.ws_price).reduce((s, l) => s + l.amount, 0);
const money = (n) => '$' + n.toFixed(2).replace(/\.00$/, '');

// ---------- helpers ----------
const today = () => new Date().toLocaleDateString('en-CA');
const localDate = (ts) => (ts ? new Date(ts).toLocaleDateString('en-CA') : null);
const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const dealer = (id) => dealers.find((d) => d.id === id);
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2200);
}
function fmtDate(v) {
  const d = v.work_date || localDate(v.found_at);
  if (!d) return '';
  const [y, m, dd] = d.split('-'); return `${+m}/${+dd}/${y.slice(2)}`;
}
const vehTitle = (v) => [v.year, v.make, v.model].filter(Boolean).join(' ') || '(no description)';

// ---------- sync ----------
function setSync() {
  const el = $('#sync');
  el.className = 'sync' + (!navigator.onLine ? ' offline' : outbox.length ? ' pending' : '');
  el.title = !navigator.onLine ? 'Offline – changes saved on phone' : outbox.length ? `${outbox.length} change(s) waiting to sync` : 'All synced';
}
let flushing = false;
async function flush() {
  if (flushing || !navigator.onLine || !outbox.length) { setSync(); return; }
  flushing = true;
  try {
    while (outbox.length) {
      const row = outbox[0];
      const { error } = await sb.from('vehicles').upsert(row, { onConflict: 'id' });
      if (error) { console.warn('sync failed', error); break; }
      outbox.shift(); store.set('outbox', outbox);
    }
  } finally { flushing = false; setSync(); }
}
window.addEventListener('online', () => { flush(); refresh(); });
window.addEventListener('offline', setSync);
setInterval(flush, 30000);

const COLS = 'id,dealer_id,stock,vin,year,make,model,color,service_code,ws_price,ws_part,status,status_note,approved_by,notes,found_at,approved_at,done_at,work_date,invoice_id,legacy_invoice_no,source';

function save(row) {
  row = { ...row };
  delete row._local;
  const i = recent.findIndex((r) => r.id === row.id);
  if (i >= 0) recent[i] = row; else recent.unshift(row);
  store.set('recent', recent);
  const idx = index[row.dealer_id];
  if (idx) { const j = idx.findIndex((r) => r.id === row.id); if (j >= 0) idx[j] = row; else idx.unshift(row); }
  outbox = outbox.filter((r) => r.id !== row.id).concat(row);
  store.set('outbox', outbox);
  render(); flush();
}

// ---------- data loading ----------
async function loadDealers() {
  const { data, error } = await sb.from('dealers').select('*').order('sort');
  if (!error && data) { dealers = data; store.set('dealers', dealers); }
}
async function loadRecent() {
  const since = new Date(Date.now() - 48 * 3600e3).toISOString();
  const { data, error } = await sb.from('vehicles').select(COLS).eq('source', 'app')
    .or(`found_at.gte.${since},status.eq.waiting_inspection,status.eq.approved,done_at.gte.${since}`)
    .order('found_at', { ascending: false }).limit(1000);
  if (error || !data) return;
  const pending = new Set(outbox.map((r) => r.id));
  recent = data.filter((r) => !pending.has(r.id)).concat(outbox);
  store.set('recent', recent);
}
async function loadIndex(id, force = false) {
  if (!id) return;
  if (!index[id]) index[id] = store.get('idx:' + id, null);
  if (index[id] && !force && index[id]._fresh) return;
  if (!navigator.onLine) { index[id] = index[id] || []; return; }
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('vehicles')
      .select('id,dealer_id,stock,vin,year,make,model,color,service_code,status,status_note,found_at,work_date,legacy_invoice_no,source')
      .eq('dealer_id', id).order('found_at', { ascending: false }).range(from, from + 999);
    if (error) { console.warn(error); return; }
    rows.push(...data);
    if (data.length < 1000) break;
  }
  index[id] = rows;
  store.set('idx:' + id, rows);
  index[id]._fresh = true;
}
async function refresh(force = false) {
  if (!navigator.onLine) { render(); return; }
  await Promise.all([loadDealers(), loadRecent()]);
  fillDealers();
  await loadIndex(dealerId, force);
  render(); setSync();
}

// ---------- rendering ----------
function fillDealers() {
  const sel = $('#dealer');
  const active = dealers.filter((d) => d.active);
  if (!dealerId || !active.some((d) => d.id === dealerId)) dealerId = active[0]?.id || null;
  sel.innerHTML = active.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('');
  if (dealerId) sel.value = dealerId;
  store.set('dealer', dealerId);
}

function onLot(v) {
  return v.dealer_id === dealerId &&
    (v.status === 'waiting_inspection' || Date.now() - new Date(v.found_at).getTime() < HOURS_ON_LIST * 3600e3);
}
function vehCard(v, { showDealer = false, doneBtn = false } = {}) {
  const pend = outbox.some((r) => r.id === v.id);
  const sub = [v.color, v.stock && `Stk ${v.stock}`, v.vin && `VIN …${String(v.vin).slice(-8)}`,
    showDealer && dealer(v.dealer_id)?.code].filter(Boolean).join(' · ');
  const btn = doneBtn && (v.status === 'approved' || v.status === 'done') && !v.invoice_id
    ? `<button class="btn small done-btn ${v.status === 'done' ? 'ok' : ''}" data-done="${v.id}">${v.status === 'done' ? '✓ Done' : 'Done'}</button>` : '';
  return `<div class="veh ${pend ? 'unsynced' : ''}" data-id="${v.id}">
    <span class="code">${esc(v.service_code || '—')}</span>
    <div class="main"><div class="t">${esc(vehTitle(v))}</div><div class="s">${esc(sub)}</div></div>
    ${btn || `<span class="st ${v.status}">${STATUS_LABEL[v.status]}</span>`}
  </div>`;
}
function renderLot() {
  const rows = recent.filter(onLot).sort((a, b) => new Date(b.found_at) - new Date(a.found_at));
  $('#lot-count').textContent = rows.length;
  $('#lot').innerHTML = rows.length ? rows.map((v) => vehCard(v, { doneBtn: true })).join('')
    : '<div class="empty">Nothing on the list yet.<br>Search a stock # or VIN to start.</div>';
}
function renderToday() {
  const t = today();
  const rows = recent.filter((v) => v.status === 'approved' ||
    (v.status === 'done' && (localDate(v.done_at) === t || localDate(v.approved_at) === t)));
  const by = {};
  rows.forEach((v) => (by[v.dealer_id] ||= []).push(v));
  let total = 0;
  const html = Object.entries(by).map(([id, vs]) => {
    const sum = vs.reduce((s, v) => s + price(v), 0); total += sum;
    return `<div class="dealer-group"><h3>${esc(dealer(id)?.name || '?')} · ${vs.length} · ${money(sum)}</h3>
      ${vs.map((v) => vehCard(v, { doneBtn: true })).join('')}</div>`;
  }).join('');
  $('#today').innerHTML = html || '<div class="empty">No approved vehicles today.</div>';
  $('#today-total').textContent = rows.length ? `${rows.length} · ${money(total)}` : '';
}
function renderSearch() {
  const q = norm($('#q').value);
  const el = $('#results');
  if (q.length < 3) { el.innerHTML = ''; return; }
  const pool = new Map();
  (index[dealerId] || []).forEach((r) => pool.set(r.id, r));
  recent.filter((r) => r.dealer_id === dealerId).forEach((r) => pool.set(r.id, r));
  const hits = [...pool.values()].filter((r) => norm(r.stock).includes(q) || norm(r.vin).includes(q))
    .sort((a, b) => new Date(b.found_at) - new Date(a.found_at));
  const d = dealer(dealerId);
  if (!hits.length) {
    const note = index[dealerId] ? '' : ' (history not loaded – go online once)';
    el.innerHTML = `<div class="banner ok">✓ No prior work on ${esc(q)} at ${esc(d?.code || '')}${note}</div>
      <div class="row" style="margin-top:8px">
        <button class="btn small" data-prefill="stock">Add as Stock #</button>
        <button class="btn small" data-prefill="vin">Add as VIN</button></div>`;
    return;
  }
  el.innerHTML = `<div class="banner bad">⚠ ${hits.length} match${hits.length > 1 ? 'es' : ''} at ${esc(d?.code || '')}</div>` +
    hits.slice(0, 25).map((r) => `<div class="hit">
      <b>${esc(fmtDate(r))}</b> · <b>${esc(r.service_code || '—')}</b> · ${esc(vehTitle(r))} ${esc(r.color || '')}<br>
      <span class="muted">Stk ${esc(r.stock || '—')} · VIN ${esc(r.vin || '—')} · ${esc(STATUS_LABEL[r.status])}${r.legacy_invoice_no ? ' · Inv ' + esc(r.legacy_invoice_no) : ''}${r.status_note ? ' · ' + esc(r.status_note) : ''}</span>
    </div>`).join('');
}
function render() { renderLot(); renderToday(); renderSearch(); setSync(); }

// ---------- service pickers ----------
function svcPicker(el, onPick) {
  el.innerHTML = SERVICES.map((s) => `<button type="button" data-svc="${s}">${s}</button>`).join('');
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-svc]'); if (!b) return;
    $$('button', el).forEach((x) => x.classList.toggle('on', x === b));
    onPick(b.dataset.svc);
  });
  return (val) => $$('button', el).forEach((x) => x.classList.toggle('on', x.dataset.svc === val));
}
let addSvc = null;
const setAddSvc = svcPicker($('#svc-add'), (s) => {
  addSvc = s; $('#add-form .ws-fields').classList.toggle('hidden', s !== 'WS');
});

// ---------- add vehicle ----------
$('#add-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const g = (k) => String(f.get(k) || '').trim();
  if (!dealerId) return toast('Pick an account first');
  if (!g('stock') && !g('vin')) return toast('Enter a stock # or VIN');
  if (!addSvc) return toast('Pick a service');
  const stock = g('stock').toUpperCase(), vin = g('vin').toUpperCase();
  const pool = (index[dealerId] || []).concat(recent.filter((r) => r.dealer_id === dealerId));
  const dup = pool.find((r) => (stock && norm(r.stock) === norm(stock)) || (vin && norm(r.vin).slice(-8) === norm(vin).slice(-8)));
  if (dup && !confirm(`Already in the book: ${fmtDate(dup)} ${dup.service_code || ''} ${vehTitle(dup)}. Add anyway?`)) return;
  save({
    id: crypto.randomUUID(), dealer_id: dealerId, stock: stock || null, vin: vin || null,
    year: g('year') || null, make: g('make') || null, model: g('model') || null, color: g('color') || null,
    service_code: addSvc, ws_price: addSvc === 'WS' && g('ws_price') ? Number(g('ws_price')) : null,
    ws_part: addSvc === 'WS' ? g('ws_part') || null : null, notes: g('notes') || null,
    status: 'found', found_at: new Date().toISOString(), source: 'app',
  });
  e.target.reset(); addSvc = null; setAddSvc(null);
  $('#add-form .ws-fields').classList.add('hidden');
  $('#q').value = ''; renderSearch();
  toast('Added to lot list');
});

$('#results').addEventListener('click', (e) => {
  const b = e.target.closest('[data-prefill]'); if (!b) return;
  const f = $('#add-form'); f.reset();
  f.elements[b.dataset.prefill].value = norm($('#q').value);
  $('#add').open = true;
  f.elements.year.focus();
});

// ---------- vehicle sheet ----------
let editing = null, editSvc = null;
const setEditSvc = svcPicker($('#svc-edit'), (s) => {
  editSvc = s; $('#sheet .ws-fields').classList.toggle('hidden', s !== 'WS');
});
function openSheet(id) {
  const v = recent.find((r) => r.id === id); if (!v) return;
  editing = { ...v }; editSvc = v.service_code;
  $('#sheet-title').textContent = `${vehTitle(v)} ${v.color || ''}`;
  $('#sheet-sub').textContent = [v.stock && `Stk ${v.stock}`, v.vin && `VIN ${v.vin}`, STATUS_LABEL[v.status],
    v.invoice_id && 'Invoiced'].filter(Boolean).join(' · ');
  const locked = !!v.invoice_id;
  const acts = locked ? [] : [
    ['approved', 'Approve', 'ok'], ['done', 'Done', 'ok'], ['waiting_inspection', 'Waiting on Insp.', 'warn'],
    ['wholesale', 'Wholesale', 'bad'], ['declined', 'Declined', 'bad'], ['other', 'Other', 'bad'],
    ['voided', 'Voided', 'bad'], ['found', 'Back to pending', ''],
  ].filter(([s]) => s !== v.status);
  $('#sheet-actions').innerHTML = acts.map(([s, l, c]) => `<button type="button" class="btn ${c}" data-status="${s}">${l}</button>`).join('');
  setEditSvc(v.service_code);
  $('#svc-edit').classList.toggle('hidden', locked);
  $('#sheet .ws-fields').classList.toggle('hidden', v.service_code !== 'WS' || locked);
  $('#edit-ws-price').value = v.ws_price ?? ''; $('#edit-ws-part').value = v.ws_part ?? '';
  $('#edit-note').value = v.status_note ?? ''; $('#edit-approved-by').value = v.approved_by ?? '';
  $('#sheet-save').classList.toggle('hidden', locked);
  $('#sheet').showModal();
}
function withStatus(v, s) {
  const now = new Date().toISOString();
  v = { ...v, status: s };
  if (s === 'approved') { v.approved_at = v.approved_at || now; v.done_at = null; v.work_date = null; }
  else if (s === 'done') { v.approved_at = v.approved_at || now; v.done_at = now; v.work_date = today(); }
  else { v.approved_at = null; v.done_at = null; v.work_date = null; }
  return v;
}
function collectEdits(v) {
  return { ...v, service_code: editSvc,
    ws_price: editSvc === 'WS' && $('#edit-ws-price').value ? Number($('#edit-ws-price').value) : null,
    ws_part: editSvc === 'WS' ? $('#edit-ws-part').value.trim() || null : null,
    status_note: $('#edit-note').value.trim() || null, approved_by: $('#edit-approved-by').value.trim() || null };
}
$('#sheet-actions').addEventListener('click', (e) => {
  const b = e.target.closest('[data-status]'); if (!b || !editing) return;
  if (b.dataset.status === 'other' && !$('#edit-note').value.trim()) { $('#edit-note').focus(); return toast('Add a reason for Other'); }
  save(withStatus(collectEdits(editing), b.dataset.status));
  $('#sheet').close(); toast(STATUS_LABEL[b.dataset.status]);
});
$('#sheet').addEventListener('close', () => {
  if ($('#sheet').returnValue === 'save' && editing) { save(collectEdits(editing)); toast('Saved'); }
  editing = null; $('#sheet').returnValue = '';
});

document.addEventListener('click', (e) => {
  const d = e.target.closest('[data-done]');
  if (d) {
    e.stopPropagation();
    const v = recent.find((r) => r.id === d.dataset.done);
    if (v) save(withStatus(v, v.status === 'done' ? 'approved' : 'done'));
    return;
  }
  const c = e.target.closest('.veh[data-id]');
  if (c) openSheet(c.dataset.id);
});

// ---------- present list ----------
$('#present-btn').addEventListener('click', () => {
  const rows = recent.filter((v) => onLot(v) && (v.status === 'found' || v.status === 'waiting_inspection'))
    .sort((a, b) => new Date(a.found_at) - new Date(b.found_at));
  $('#present-title').textContent = `${dealer(dealerId)?.name || ''} — ${rows.length} vehicle${rows.length === 1 ? '' : 's'}`;
  $('#present-table').innerHTML = '<tr><th>Stock</th><th>Vehicle</th><th>VIN</th><th>Svc</th></tr>' +
    rows.map((v) => `<tr><td><b>${esc(v.stock || '')}</b></td><td>${esc(vehTitle(v))}<br><span class="muted">${esc(v.color || '')}</span></td>
      <td>${esc(String(v.vin || '').slice(-8))}</td><td><b>${esc(v.service_code || '')}</b>${v.status === 'waiting_inspection' ? '<br><span class="muted">insp.</span>' : ''}</td></tr>`).join('');
  $('#present').showModal();
});

// ---------- tabs, dealer, search ----------
$$('nav.bottom [data-tab]').forEach((b) => b.addEventListener('click', () => {
  $$('nav.bottom [data-tab]').forEach((x) => x.classList.toggle('active', x === b));
  $$('.tab').forEach((t) => t.classList.toggle('hidden', t.id !== 'tab-' + b.dataset.tab));
}));
$('#dealer').addEventListener('change', async (e) => {
  dealerId = e.target.value; store.set('dealer', dealerId);
  render(); await loadIndex(dealerId); renderSearch();
});
$('#q').addEventListener('input', renderSearch);

$('#menu-btn').addEventListener('click', async () => {
  const { data } = await sb.auth.getSession();
  $('#menu-user').textContent = data.session?.user.email || '';
  $('#menu').showModal();
});
$('#menu').addEventListener('close', async () => {
  const v = $('#menu').returnValue;
  if (v === 'refresh') { toast('Refreshing…'); await flush(); await refresh(true); toast('Up to date'); }
  if (v === 'signout') { await sb.auth.signOut(); location.reload(); }
  if (v === 'import') $('#import-file').click();
});

// One-time history import: JSON produced by scripts/import_ssv_book.py, uploaded with the signed-in session.
$('#import-file').addEventListener('change', async (e) => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file) return;
  const { dealers: ds, vehicles: vs } = JSON.parse(await file.text());
  const { count } = await sb.from('vehicles').select('id', { count: 'exact', head: true }).eq('source', 'import');
  if (count && !confirm(`${count} imported rows already exist. Import ${vs.length} more anyway?`)) return;
  if (!confirm(`Import ${ds.length} dealers and ${vs.length} vehicles?`)) return;
  await loadDealers();
  const missing = ds.filter((d) => !dealers.some((x) => x.code === d.code))
    .map((d) => ({ code: d.code, name: d.name, active: false, billing_emails: d.billing_emails, sort: 200 }));
  if (missing.length) { const { error } = await sb.from('dealers').insert(missing); if (error) return alert(error.message); }
  for (const d of ds) {
    const have = dealers.find((x) => x.code === d.code);
    if (have && !have.billing_emails && d.billing_emails) await sb.from('dealers').update({ billing_emails: d.billing_emails }).eq('id', have.id);
  }
  await loadDealers();
  const ids = Object.fromEntries(dealers.map((d) => [d.code, d.id]));
  const rows = vs.map(({ dealer_code, ...r }) => ({ ...r, dealer_id: ids[dealer_code], source: 'import' }));
  for (let i = 0; i < rows.length; i += 1000) {
    toast(`Importing ${i + 1}–${Math.min(i + 1000, rows.length)} of ${rows.length}…`);
    const { error } = await sb.from('vehicles').insert(rows.slice(i, i + 1000));
    if (error) return alert(`Stopped at row ${i}: ${error.message}`);
  }
  toast(`Imported ${rows.length} vehicles`);
  await refresh(true);
});

$('#makes').innerHTML = MAKES.map((m) => `<option value="${m}">`).join('');
$('#colors').innerHTML = COLORS.map((m) => `<option value="${m}">`).join('');

// ---------- auth ----------
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-msg').textContent = '';
  const { error } = await sb.auth.signInWithPassword({ email: $('#login-email').value, password: $('#login-pass').value });
  if (error) $('#login-msg').textContent = error.message;
});
$('#signup-btn').addEventListener('click', async () => {
  const email = $('#login-email').value, password = $('#login-pass').value;
  if (!email || password.length < 8) { $('#login-msg').textContent = 'Enter email and a password of 8+ characters'; return; }
  const { error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: location.href.split('#')[0] } });
  $('#login-msg').textContent = error ? error.message : 'Check your email to confirm, then sign in.';
});

let started = false;
async function start() {
  if (started) return; started = true;
  $('#login').classList.add('hidden'); $('#app').classList.remove('hidden');
  if (dealers.length) fillDealers();
  if (dealerId) index[dealerId] = store.get('idx:' + dealerId, null);
  render();
  await flush(); await refresh();
}
sb.auth.onAuthStateChange((_ev, session) => { if (session) start(); });
const { data: { session } } = await sb.auth.getSession();
if (session || (!navigator.onLine && dealers.length)) start();
else $('#login').classList.remove('hidden');

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
