'use strict';

/* =====================================================================
   WIns Lounge Delivery
   Customer location -> zone (point in polygon) -> covering store -> menu
   Data lives in Supabase (see supabase/migrations). Orders go through the
   place_order() function, which re-checks zone, store, stock and prices.
   Bilingual: English / Arabic (RTL). Strings live in i18n.js.
   ===================================================================== */

const BRAND = { name: 'WIns', logoUrl: 'assets/wins-logo.png' };
const LOCAL_KEY = 'wins.local.v3';     // cart, location, my order tokens
const LANG_KEY = 'wins.lang';
const MAP_CENTER = [24.77, 46.66];
const TZ = 'Asia/Riyadh';

/* ---------------- Supabase ---------------- */
const db = window.supabase.createClient(window.WINS_CONFIG.supabaseUrl, window.WINS_CONFIG.supabaseKey, {
  auth: { persistSession: true, autoRefreshToken: true },
});

/* ---------------- language ---------------- */
let lang = (() => { try { return localStorage.getItem(LANG_KEY); } catch (e) { return null; } })()
  || ((navigator.language || '').toLowerCase().startsWith('ar') ? 'ar' : 'en');

function t(key, vars) {
  let s = I18N[lang]?.[key] ?? I18N.en[key] ?? key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m));
  return s;
}
// Localized field: nm(product) → nameAr in Arabic when present, else name
const nm = (o, f = 'name') => (o ? (lang === 'ar' && o[f + 'Ar']) || o[f] || '' : '');
const pick = (en, ar) => (lang === 'ar' && ar ? ar : en || '');
// Keep numbers, ranges and coordinates left-to-right inside Arabic text
const ltr = s => `<bdi dir="ltr">${s}</bdi>`;

/* ---------------- utils ---------------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = p => p + '_' + Math.random().toString(36).slice(2, 8);
const fmt = n => Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
const money = n => (lang === 'ar' ? `${fmt(n)} ${t('currency')}` : `${t('currency')} ${fmt(n)}`);
const clone = o => JSON.parse(JSON.stringify(o));
const pad = n => String(n).padStart(2, '0');
const normPhone = s => String(s || '').replace(/[^0-9+]/g, '');
const validPhone = s => /^\+?[0-9]{9,15}$/.test(normPhone(s));

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg; el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), 3000);
}
// Map a Supabase/Postgres error to a friendly message.
function errText(e) {
  const key = String(e?.message || '').split(':')[0].trim();
  return I18N.en['err_' + key] ? t('err_' + key) : t('err_generic');
}

/* ---------------- geometry ---------------- */
function pointInPolygon(lat, lng, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i], [yj, xj] = poly[j];
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function areaKm2(poly) {
  if (poly.length < 3) return 0;
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += (poly[j][1] + poly[i][1]) * (poly[j][0] - poly[i][0]);
  const lat = poly[0][0] * Math.PI / 180;
  return Math.abs(a / 2) * 111.32 * 111.32 * Math.cos(lat);
}
function centroid(poly) {
  const n = poly.length || 1;
  return { lat: poly.reduce((s, p) => s + p[0], 0) / n, lng: poly.reduce((s, p) => s + p[1], 0) / n };
}
function km(a, b) {
  const R = 6371, r = d => d * Math.PI / 180;
  const dLat = r(b.lat - a.lat), dLng = r(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const kmStr = d => t('km', { d: d.toFixed(1) });
const coords = p => ltr(`${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}`);

/* ---------------- state ---------------- */
// S: shared data from Supabase. LS: this device's own state.
let S = { zones: [], stores: [], categories: [], products: [], inventory: {}, events: [] };
const LS = (() => {
  const base = { cart: {}, customer: null, orders: [], orderCache: {}, lastCustomer: {} };
  try { return Object.assign(base, JSON.parse(localStorage.getItem(LOCAL_KEY) || '{}')); } catch (e) { return base; }
})();
function saveLocal() { try { localStorage.setItem(LOCAL_KEY, JSON.stringify(LS)); } catch (e) { /* storage blocked */ } }

const ui = {
  ready: false, loadError: null,
  route: 'shop', cat: 'All', q: '', whyOpen: false,
  cartOpen: false, checkout: false, placing: false,
  adminTab: 'overview', mapMode: 'test', testLoc: null,
  zoneEdit: null, storeEdit: null, armed: null, focus: null,
  pendingLoc: null, eventPkg: null, eventSent: null, sendingEvent: false,
  session: null, isAdmin: false, adminOrders: [], eventReqs: [], authMsg: '',
};

/* ---------------- catalog visuals ---------------- */
const ICONS = {
  Cheesecake: '<path d="M3 16 18 8l3 2v6Z"/><path d="M3 16v4h18v-4"/><path d="M3 18h18"/><circle cx="16.5" cy="6" r="1.6"/>',
  Shisha: '<path d="M10 3h4"/><path d="M9.5 5h5l-.8 3h-3.4Z"/><path d="M12 8v4"/><path d="M8 17.5a4 4 0 0 0 8 0c0-2.2-1.8-4.5-4-4.5s-4 2.3-4 4.5Z"/><path d="M16 15c2.5 0 4 1.2 4 4.5"/>',
  Tea: '<path d="M4 10h12v4a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5Z"/><path d="M16 11.5h1.5a2 2 0 0 1 0 4H16"/><path d="M8 3.5c0 1.5 1 1.5 1 3M12 3.5c0 1.5 1 1.5 1 3"/>',
  _: '<circle cx="12" cy="12" r="7"/>',
};
const EVENT_ICON = '<path d="M4 9h16v11H4Z"/><path d="M8 3v4M16 3v4M4 13h16"/>';
const catOf = key => S.categories.find(c => c.key === key);
const catIcon = key => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[key] || ICONS._}</svg>`;
const hueOf = key => catOf(key)?.hue || '#CC9F50';
const tileStyle = key => { const h = hueOf(key); return `background:color-mix(in srgb, ${h} 15%, var(--surface));color:${h}`; };
const catLabel = key => nm(catOf(key)) || key;
const ageRestricted = key => !!catOf(key)?.ageRestricted;

/* ---------------- data loading ---------------- */
async function loadCatalog() {
  const q = (table, order) => { let r = db.from(table).select('*'); if (order) r = r.order(order); return r; };
  const res = await Promise.all([
    q('zones', 'code'), q('stores', 'name'), q('store_coverage'), q('categories', 'sort'),
    q('products', 'sort'), q('inventory'), q('event_packages', 'sort'),
  ]);
  const bad = res.find(r => r.error);
  if (bad) throw bad.error;
  const [zones, stores, cov, cats, prods, inv, evs] = res.map(r => r.data);
  S.zones = zones.map(z => ({ id: z.id, code: z.code, name: z.name, nameAr: z.name_ar, color: z.color, fee: +z.fee, minOrder: +z.min_order, active: z.active, poly: z.poly }));
  S.stores = stores.map(s => ({
    id: s.id, name: s.name, nameAr: s.name_ar, lat: s.lat, lng: s.lng, open: s.open_time, close: s.close_time,
    prep: s.prep_minutes, active: s.active,
    coverage: cov.filter(c => c.store_id === s.id).map(c => ({ zone: c.zone_id, role: c.role })),
  }));
  S.categories = cats.map(c => ({ key: c.key, name: c.name, nameAr: c.name_ar, hue: c.hue, ageRestricted: c.age_restricted }));
  S.products = prods.map(p => ({ id: p.id, category: p.category, name: p.name, nameAr: p.name_ar, unit: p.unit, unitAr: p.unit_ar, price: +p.price, was: p.was == null ? null : +p.was, listed: p.listed, sort: p.sort }));
  S.inventory = {};
  inv.forEach(i => { (S.inventory[i.store_id] = S.inventory[i.store_id] || {})[i.product_id] = i.qty; });
  S.events = evs.map(e => ({ id: e.id, name: e.name, nameAr: e.name_ar, desc: e.description, descAr: e.description_ar, guests: e.guests, guestsAr: e.guests_ar, price: +e.price, was: e.was == null ? null : +e.was, active: e.active }));
  // Drop cart lines for products that no longer exist.
  Object.keys(LS.cart).forEach(id => { if (!S.products.some(p => p.id === id)) delete LS.cart[id]; });
}

async function loadAdminData() {
  if (!ui.isAdmin) return;
  const [o, e] = await Promise.all([
    db.from('orders').select('*, order_items(*)').order('created_at', { ascending: false }).limit(100),
    db.from('event_requests').select('*').order('created_at', { ascending: false }).limit(200),
  ]);
  if (o.error) throw o.error;
  if (e.error) throw e.error;
  ui.adminOrders = o.data;
  ui.eventReqs = e.data;
}

async function refreshAll() {
  try {
    await loadCatalog();
    await loadAdminData();
    ui.ready = true; ui.loadError = null;
  } catch (err) {
    ui.loadError = err;
    console.error(err);
  }
  renderAll();
}

/* ---------------- store selection engine ---------------- */
const toMin = v => { const [h, m] = String(v).split(':').map(Number); return h * 60 + (m || 0); };
function riyadhMinutes() {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
  const get = type => +parts.find(p => p.type === type).value;
  return get('hour') * 60 + get('minute');
}
// Same rule as the database: hours are Saudi time, overnight hours (08:00 → 02:00) allowed.
function isOpen(store) {
  const o = toMin(store.open), c = toMin(store.close), now = riyadhMinutes();
  if (c - o >= 1440 || o === c) return true;
  return c > o ? now >= o && now < c : now >= o || now < c;
}
const hours = s => ltr(`${s.open}–${s.close}`);
const roleRank = r => (r === 'primary' ? 0 : 1);

/** Which zone(s) contain a point and which store serves it: available → primary → nearest. */
function resolve(loc) {
  if (!loc) return null;
  const zones = S.zones
    .filter(z => z.active !== false && z.poly.length >= 3 && pointInPolygon(loc.lat, loc.lng, z.poly))
    .sort((a, b) => areaKm2(a.poly) - areaKm2(b.poly));
  const candidates = [];
  for (const st of S.stores) {
    const covs = st.coverage.filter(c => zones.some(z => z.id === c.zone)).sort((a, b) => roleRank(a.role) - roleRank(b.role));
    if (!covs.length) continue;
    const best = covs[0];
    const zone = zones.find(z => z.id === best.zone);
    const reasons = [];
    if (!st.active) reasons.push(esc(t('paused')));
    if (!isOpen(st)) reasons.push(t('closedHours', { h: hours(st) }));
    candidates.push({ store: st, zone, role: best.role, dist: km(loc, st), ok: reasons.length === 0, reasons });
  }
  candidates.sort((a, b) => (b.ok - a.ok) || (roleRank(a.role) - roleRank(b.role)) || (a.dist - b.dist));
  let nearest = null;
  if (!zones.length) {
    for (const z of S.zones.filter(z => z.poly.length >= 3)) {
      const d = km(loc, centroid(z.poly));
      if (!nearest || d < nearest.dist) nearest = { zone: z, dist: d };
    }
  }
  return { loc, zones, candidates, pick: candidates.find(c => c.ok) || null, nearest };
}
function eta(c) {
  const lo = c.store.prep + Math.round(c.dist * 3.2 + 4);
  return [lo, lo + 10];
}
const etaStr = ([lo, hi]) => t('minutes', { r: ltr(`${lo}–${hi}`) });
const current = () => resolve(LS.customer);
const stockOf = (storeId, pid) => S.inventory[storeId]?.[pid];

/* ---------------- quick places ---------------- */
const SAMPLES = [
  ['Al Olaya', 'العليا', 24.6960, 46.6840], ['Al Sulimaniyah', 'السليمانية', 24.7050, 46.7150], ['Al Nakheel', 'النخيل', 24.7480, 46.6420],
  ['Al Malqa', 'الملقا', 24.8130, 46.6130], ['Al Yasmin', 'الياسمين', 24.8330, 46.6530], ['Al Narjis', 'النرجس', 24.8720, 46.6760],
  ['Al Rawdah', 'الروضة', 24.7350, 46.7710], ['Diriyah', 'الدرعية', 24.7430, 46.5760], ['King Khalid Airport', 'مطار الملك خالد', 24.9576, 46.6988],
];
function placeName(c) {
  if (!c) return '';
  if (c.sample != null && SAMPLES[c.sample]) return SAMPLES[c.sample][lang === 'ar' ? 1 : 0];
  if (c.kind === 'gps') return t('currentLoc');
  return t('pinned');
}

/* ---------------- static text & brand ---------------- */
function applyStatic() {
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  $$('[data-i18n]').forEach(el => (el.textContent = t(el.dataset.i18n)));
  $$('[data-i18n-ph]').forEach(el => (el.placeholder = t(el.dataset.i18nPh)));
  $$('[data-i18n-aria]').forEach(el => el.setAttribute('aria-label', t(el.dataset.i18nAria)));
  const lb = $('#langBtn');
  lb.textContent = t('otherLang');
  lb.setAttribute('lang', lang === 'ar' ? 'en' : 'ar');
  lb.title = lang === 'ar' ? 'Switch to English' : 'التبديل إلى العربية';
}
function renderBrand() {
  $('#brand').innerHTML = `<img class="brand-img" src="${esc(BRAND.logoUrl)}" alt="${esc(BRAND.name)}">`;
}

/* ---------------- header ---------------- */
function renderHeader() {
  let label = t('setLocation');
  if (LS.customer && ui.ready) {
    const z = current()?.zones[0], l = placeName(LS.customer);
    label = z ? (l === nm(z) ? nm(z) : `${nm(z)} · ${l}`) : t('outsideSuffix', { l });
  }
  $('#locLabel').textContent = label;
  $('#cartCount').textContent = Object.values(LS.cart).reduce((a, b) => a + b, 0);
  $$('.nav a').forEach(a => a.classList.toggle('active', a.dataset.route === ui.route));
}

/* ---------------- shared states ---------------- */
function loadingState() {
  if (ui.loadError) {
    return `<div class="empty"><h2>${t('loadFail')}</h2><button class="btn btn-brand" data-action="retry">${t('retry')}</button></div>`;
  }
  return `<div class="empty loading"><span class="spinner" aria-hidden="true"></span><p>${t('loading')}</p></div>`;
}

/* ---------------- shop ---------------- */
function whyList(res) {
  if (!res.candidates.length) return `<p class="muted small">${esc(t('noCoverage'))}</p>`;
  return `<ol class="why">${res.candidates.map(c => `
    <li class="${c === res.pick ? 'is-pick' : ''} ${c.ok ? '' : 'is-off'}">
      <b>${esc(nm(c.store))}</b>
      <span class="role role-${c.role}">${t('role_' + c.role)}</span>
      <span class="why-meta muted small">${t('whyMeta', { d: ltr(c.dist.toFixed(1)), z: `<span class="mono">${esc(c.zone.code)}</span>` })}${c === res.pick ? ' · ' + t('selected') : ''}</span>
      ${c.reasons.length ? `<span class="why-reason">${c.reasons.join(' · ')}</span>` : ''}
    </li>`).join('')}</ol>`;
}
const zoneTag = (z, full = true) => `<span class="zone-tag"><i style="background:${esc(z.color)}"></i><span class="mono">${esc(z.code)}</span>${full ? ` · ${esc(nm(z))}` : ''}</span>`;

function dispatchBanner(res) {
  if (!LS.customer) {
    return `<div class="hero">
      <div class="hero-copy">
        <span class="eyebrow">${t('step1')}</span>
        <h1>${t('tellUs')}</h1>
        <p>${t('tellUsP')}</p>
        <div class="row"><button class="btn btn-brand" data-action="use-gps-direct">${t('detect')}</button><button class="btn" data-action="open-loc">${t('chooseMap')}</button></div>
      </div>
      <div class="hero-art" aria-hidden="true">${['Cheesecake', 'Shisha', 'Tea'].map(k => `<span style="${tileStyle(k)}">${catIcon(k)}</span>`).join('')}</div>
    </div>`;
  }
  if (!res.zones.length) {
    const n = res.nearest;
    return `<div class="empty">
      <span class="eyebrow">${t('outside')}</span>
      <h1>${t('noDeliverH')}</h1>
      <p>${t('noDeliverP', { c: `<span class="mono">${coords(LS.customer)}</span>` })}
      ${n ? t('closestP', { z: `<b>${esc(nm(n.zone))}</b>`, d: ltr(n.dist.toFixed(1)) }) : ''}</p>
      <div class="row"><button class="btn btn-brand" data-action="open-loc">${t('changeLoc')}</button></div>
    </div>`;
  }
  const z = res.zones[0];
  if (!res.pick) {
    return `<div class="dispatch is-off">
      <div class="dispatch-main">
        <span class="eyebrow">${t('zoneNoStoreEy')}</span>
        <h2>${t('storesClosedH', { z: esc(nm(z)) })}</h2>
        <p class="muted">${t('storesClosedP')}</p>
      </div>
      <div class="dispatch-actions"><button class="btn" data-action="open-loc">${t('changeLoc')}</button></div>
      <div class="why-wrap">${whyList(res)}</div>
    </div>`;
  }
  const c = res.pick, dz = c.zone;
  return `<div class="dispatch">
    <div class="dispatch-main">
      <span class="eyebrow">${t('autoSel')}</span>
      <div class="dispatch-route">
        ${zoneTag(z)}
        <svg class="route-arrow" viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
        <h2>${esc(nm(c.store))}</h2>
      </div>
      <div class="dispatch-stats">
        <div class="stat"><b>${etaStr(eta(c))}</b><span>${t('deliveryTime')}</span></div>
        <div class="stat"><b>${money(dz.fee)}</b><span>${t('deliveryFee')}</span></div>
        <div class="stat"><b>${money(dz.minOrder)}</b><span>${t('minOrder')}</span></div>
        <div class="stat"><b>${kmStr(c.dist)}</b><span>${t('storeDist')}</span></div>
      </div>
    </div>
    <div class="dispatch-actions">
      <button class="btn btn-ghost" data-action="why-toggle">${ui.whyOpen ? t('hide') : t('whyStore')}</button>
      <button class="btn" data-action="open-loc">${t('changeLoc')}</button>
    </div>
    ${ui.whyOpen ? `<div class="why-wrap">${whyList(res)}</div>` : ''}
  </div>`;
}

const priceHtml = p => {
  const cur = `<small>${t('currency')}</small>`;
  const num = fmt(p.price);
  const was = p.was ? ` <s class="muted small">${fmt(p.was)}</s>` : '';
  return `<span class="price">${lang === 'ar' ? num + ' ' + cur : cur + num}${was}</span>`;
};

function productCard(p, storeId) {
  const stock = stockOf(storeId, p.id) || 0;
  const qty = LS.cart[p.id] || 0;
  const out = stock <= 0;
  const badge = out ? `<span class="badge badge-muted">${t('outOfStock')}</span>`
    : p.was ? `<span class="badge">${ltr('−' + Math.round((1 - p.price / p.was) * 100) + '%')}</span>`
    : stock <= 5 ? `<span class="badge badge-muted">${t('onlyLeft', { n: stock })}</span>` : '';
  const age = ageRestricted(p.category) ? `<span class="badge badge-age">${t('ageBadge')}</span>` : '';
  const ctrl = out ? `<button class="add-btn" disabled>${t('soldOut')}</button>`
    : qty ? `<div class="stepper"><button data-action="dec" data-id="${p.id}" aria-label="${t('removeOne')}">−</button><span>${qty}</span><button data-action="inc" data-id="${p.id}" aria-label="${t('addOne')}">+</button></div>`
    : `<button class="add-btn" data-action="inc" data-id="${p.id}">${t('add')}</button>`;
  return `<article class="card ${out ? 'is-out' : ''}">
    <div class="tile" style="${tileStyle(p.category)}">${badge}${age}${catIcon(p.category)}</div>
    <div class="card-body"><span class="name">${esc(nm(p))}</span><span class="unit">${esc(nm(p, 'unit'))}</span></div>
    <div class="card-foot">${priceHtml(p)}${ctrl}</div>
  </article>`;
}

function renderShop() {
  const el = $('#view-shop');
  if (!ui.ready) { el.innerHTML = loadingState(); return; }
  const res = current();
  let html = dispatchBanner(res);
  const store = res?.pick?.store;
  if (store) {
    const q = ui.q.trim().toLowerCase();
    const carried = S.products.filter(p => p.listed !== false && stockOf(store.id, p.id) !== undefined);
    const cats = ['All', ...S.categories.map(c => c.key).filter(k => carried.some(p => p.category === k))];
    if (!cats.includes(ui.cat)) ui.cat = 'All';
    const hay = p => { const c = catOf(p.category) || {}; return [p.name, p.nameAr, c.name, c.nameAr].join(' ').toLowerCase(); };
    const list = carried.filter(p => (ui.cat === 'All' || p.category === ui.cat) && (!q || hay(p).includes(q)));
    list.sort((a, b) => ((stockOf(store.id, b.id) > 0) - (stockOf(store.id, a.id) > 0)) || a.sort - b.sort);
    html += `<div class="catalog-head">
      <div><span class="eyebrow">${t('inStockAt', { s: esc(nm(store)) })}</span><h2>${ui.cat === 'All' ? t('everything') : esc(catLabel(ui.cat))}${q ? ` ${t('matching', { q: esc(ui.q) })}` : ''}</h2></div>
      <a class="btn btn-ghost btn-sm" href="#events"><svg viewBox="0 0 24 24" aria-hidden="true">${EVENT_ICON}</svg>${t('navEvents')}</a>
    </div>
    <div class="chips" role="tablist">${cats.map(c => `<button class="chip ${c === ui.cat ? 'active' : ''}" data-action="cat" data-cat="${esc(c)}">${c === 'All' ? '' : catIcon(c)}${c === 'All' ? t('all') : esc(catLabel(c))}<span class="count">${c === 'All' ? carried.length : carried.filter(p => p.category === c).length}</span></button>`).join('')}</div>
    <div style="height:14px"></div>
    ${list.length ? `<div class="grid-products">${list.map(p => productCard(p, store.id)).join('')}</div>`
      : `<div class="empty"><h3>${t('noProducts')}</h3><p>${t('noProductsP')}</p></div>`}`;
  }
  el.innerHTML = html;
}

/* ---------------- cart ---------------- */
function cartLines(storeId) {
  return Object.entries(LS.cart).map(([pid, qty]) => {
    const p = S.products.find(x => x.id === pid);
    if (!p) return null;
    const stock = storeId ? stockOf(storeId, pid) || 0 : 0;
    return { p, qty, available: stock >= qty && stock > 0, stock };
  }).filter(Boolean);
}
function cartTotals(res) {
  const store = res?.pick?.store;
  const lines = cartLines(store?.id);
  const ok = lines.filter(l => l.available);
  const sub = ok.reduce((s, l) => s + l.p.price * l.qty, 0);
  const zone = res?.pick?.zone;
  const fee = zone && sub > 0 ? zone.fee : 0;
  const needsAge = ok.some(l => ageRestricted(l.p.category));
  return { lines, ok, sub, fee, total: sub + fee, zone, store, min: zone?.minOrder || 0, needsAge };
}

function renderCart() {
  const d = $('#drawer');
  if (!ui.cartOpen) { d.hidden = true; $('#scrim').hidden = true; return; }
  d.hidden = false; $('#scrim').hidden = false;
  const res = ui.ready ? current() : null;
  const tt = cartTotals(res);
  const head = `<div class="drawer-head"><h2>${ui.checkout ? t('checkout') : t('yourCart')}</h2><button class="icon-btn" data-action="close-cart" aria-label="${t('close')}"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>`;

  if (!tt.lines.length) {
    d.innerHTML = head + `<div class="drawer-body"><div class="empty"><h3>${t('emptyCart')}</h3><p>${t('emptyCartP')}</p><button class="btn btn-brand" data-action="close-cart">${t('startShopping')}</button></div></div><div></div>`;
    return;
  }
  const from = tt.store
    ? `<div class="from-store"><span class="store-dot">W</span><div><b>${esc(nm(tt.store))}</b><div class="muted small">${t('deliveringTo', { z: esc(nm(tt.zone)) })} · <span class="mono">${esc(tt.zone.code)}</span></div></div></div>`
    : `<div class="notice notice-danger">${t('noStoreHere')} <button class="link-btn" data-action="open-loc">${t('changeLoc')}</button></div>`;
  const unavailable = tt.lines.filter(l => !l.available);
  const totals = `<div class="totals">
    <div><span>${t('subtotal')}</span><span>${money(tt.sub)}</span></div>
    <div><span>${t('deliveryFee')}</span><span>${money(tt.fee)}</span></div>
    <div class="grand"><span>${t('total')}</span><span>${money(tt.total)}</span></div>
  </div>`;
  const short = Math.max(0, tt.min - tt.sub);

  if (!ui.checkout) {
    d.innerHTML = head + `<div class="drawer-body">
      ${from}
      ${unavailable.length ? `<div class="notice">${t('unavailableN', { n: unavailable.length })}</div>` : ''}
      ${tt.lines.map(l => `<div class="line-item ${l.available ? '' : 'unavailable'}">
        <div class="mini" style="${tileStyle(l.p.category)}">${catIcon(l.p.category)}</div>
        <div><b>${esc(nm(l.p))}</b><div class="muted small">${esc(nm(l.p, 'unit'))} · ${money(l.p.price)}${l.available ? '' : ` · <span style="color:var(--danger)">${l.stock ? t('onlyNInStock', { n: l.stock }) : t('notHere')}</span>`}</div></div>
        <div class="stepper"><button data-action="dec" data-id="${l.p.id}" aria-label="${t('removeOne')}">−</button><span>${l.qty}</span><button data-action="inc" data-id="${l.p.id}" aria-label="${t('addOne')}">+</button></div>
      </div>`).join('')}
    </div>
    <div class="drawer-foot">
      ${short > 0 && tt.store ? `<div class="small">${t('addMore', { m: money(short), min: money(tt.min), z: esc(nm(tt.zone)) })}</div><div class="meter"><i style="width:${Math.min(100, (tt.sub / tt.min) * 100)}%"></i></div>` : ''}
      ${totals}
      <button class="btn btn-brand btn-block" data-action="checkout" ${!tt.store || short > 0 || !tt.ok.length ? 'disabled' : ''}>${t('checkoutBtn', { t: money(tt.total) })}</button>
    </div>`;
    return;
  }

  const last = LS.lastCustomer || {};
  d.innerHTML = head + `<form class="drawer-body" id="checkoutForm" autocomplete="on">
      ${from}
      <div class="notice" style="background:var(--brand-soft)">${t('arrivesIn', { e: etaStr(eta(res.pick)) })}</div>
      <label class="field"><span>${t('fullName')}</span><input id="coName" name="name" required minlength="2" maxlength="80" value="${esc(last.name || '')}"></label>
      <label class="field"><span>${t('mobile')}</span><input id="coPhone" name="phone" type="tel" dir="ltr" required placeholder="05x xxx xxxx" value="${esc(last.phone || '')}"></label>
      <div class="grid-3">
        <label class="field"><span>${t('building')}</span><input id="coBldg" name="building" required maxlength="40" value="${esc(last.building || '')}"></label>
        <label class="field"><span>${t('floor')}</span><input id="coFloor" name="floor" maxlength="20" value="${esc(last.floor || '')}"></label>
        <label class="field"><span>${t('apt')}</span><input id="coApt" name="apt" maxlength="20" value="${esc(last.apt || '')}"></label>
      </div>
      <label class="field"><span>${t('street')}</span><input id="coStreet" name="street" required maxlength="160" value="${esc(last.street || '')}"></label>
      <label class="field"><span>${t('note')}</span><textarea id="coNote" name="note" maxlength="500"></textarea></label>
      <div class="field"><span>${t('payment')}</span>
        <label class="pay-opt"><input type="radio" name="pay" value="cash" checked> ${t('cod')}</label>
        <label class="pay-opt"><input type="radio" name="pay" value="card-on-delivery"> ${t('cardPos')}</label>
      </div>
      ${tt.needsAge ? `<label class="age-row"><input id="coAge" type="checkbox" name="age" required> <span>${t('ageConfirm')}</span></label>` : ''}
      ${totals}
    </form>
    <div class="drawer-foot">
      <button class="btn btn-brand btn-block" type="submit" form="checkoutForm" ${ui.placing ? 'disabled' : ''}>${ui.placing ? t('placing') : t('placeOrder', { t: money(tt.total) })}</button>
      <button class="btn btn-ghost btn-block" data-action="back-cart">${t('backCart')}</button>
    </div>`;
}

async function placeOrder(form) {
  if (ui.placing) return;
  const res = current();
  const tt = cartTotals(res);
  if (!tt.store || !tt.ok.length || tt.sub < tt.min) { toast(t('cantOrder')); return; }
  const f = Object.fromEntries(new FormData(form));
  if (!validPhone(f.phone)) { toast(t('err_invalid_phone')); $('#coPhone')?.focus(); return; }
  if (tt.needsAge && !f.age) { toast(t('err_age_confirmation_required')); return; }
  LS.lastCustomer = { name: f.name, phone: f.phone, building: f.building, floor: f.floor, apt: f.apt, street: f.street };
  saveLocal();

  ui.placing = true; renderCart();
  const { data, error } = await db.rpc('place_order', {
    p_lat: LS.customer.lat, p_lng: LS.customer.lng,
    p_items: tt.ok.map(l => ({ id: l.p.id, qty: l.qty })),
    p_customer: { name: f.name, phone: normPhone(f.phone), building: f.building, floor: f.floor, apt: f.apt, street: f.street, note: f.note },
    p_pay: f.pay, p_age_confirmed: !!f.age,
  });
  ui.placing = false;
  if (error) {
    toast(errText(error));
    if (/stock|unavailable/.test(error.message)) { await loadCatalog().catch(() => {}); renderAll(); } else renderCart();
    return;
  }
  LS.orders.unshift({ code: data.code, token: data.token });
  LS.orderCache[data.code] = {
    ...data, status: 0, pay: f.pay,
    items: tt.ok.map(l => ({ name: l.p.name, name_ar: l.p.nameAr, qty: l.qty })),
  };
  LS.cart = {};
  saveLocal();
  ui.checkout = false; ui.cartOpen = false;
  toast(t('orderPlaced', { id: data.code, s: pick(data.store, data.store_ar) }));
  await loadCatalog().catch(() => {});   // stock changed
  location.hash = '#orders';
  renderAll();
}

/* ---------------- orders ---------------- */
// One card for both the customer's tracked orders (get_order shape) and the admin list.
function orderCard(o, admin = false) {
  const when = new Date(o.created_at);
  const date = when.toLocaleDateString(lang === 'ar' ? 'ar-SA-u-ca-gregory-nu-latn' : 'en-GB', { day: 'numeric', month: 'short' });
  const count = o.items.reduce((s, i) => s + i.qty, 0);
  const time = when.toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
  return `<article class="order">
    <div class="order-head">
      <div><span class="eyebrow">${date} · ${ltr(time)}</span>
        <h3 class="mono" style="font-size:15px">${esc(o.code)}</h3>
        <div class="muted small">${esc(pick(o.store, o.store_ar))} ${lang === 'ar' ? '←' : '→'} ${esc(pick(o.zone, o.zone_ar))} <span class="mono">(${esc(o.zone_code)})</span></div>
        ${admin ? `<div class="small">${esc(o.customer_name)} · <span class="mono">${esc(o.phone)}</span> · ${esc([o.building, o.floor, o.apt, o.street].filter(Boolean).join(', '))}${o.note ? ` · <i>${esc(o.note)}</i>` : ''}${o.age_confirmed ? ` · <span class="badge badge-age">${t('ageBadge')}</span>` : ''}</div>` : ''}
      </div>
      <div class="order-total"><div class="price">${money(o.total)}</div><div class="muted small">${t('itemsCount', { n: count })} · ${o.pay === 'cash' ? t('cashOD') : t('cardOD')}</div></div>
    </div>
    <div class="track">${[0, 1, 2, 3].map(i => `<div class="${i < o.status || o.status === 3 ? 'done' : i === o.status ? 'done now' : ''}">${t('status' + i)}</div>`).join('')}</div>
    <div class="muted small">${o.items.map(i => `${i.qty}× ${esc(pick(i.name, i.name_ar))}`).join(' · ')}</div>
    ${admin && o.status < 3 ? `<div><button class="btn btn-sm btn-brand" data-action="order-advance" data-id="${o.id}" data-status="${o.status}">${t('markAs', { s: t('status' + (o.status + 1)) })}</button></div>` : ''}
  </article>`;
}

async function refreshMyOrders() {
  await Promise.all(LS.orders.slice(0, 20).map(async ({ code, token }) => {
    const { data, error } = await db.rpc('get_order', { p_code: code, p_token: token });
    if (!error && data) LS.orderCache[code] = data;
  }));
  saveLocal();
  if (ui.route === 'orders') renderOrders();
}

function renderOrders() {
  const mine = LS.orders.map(o => LS.orderCache[o.code]).filter(Boolean);
  $('#view-orders').innerHTML = `<div class="stack" style="max-width:860px">
    <div class="section-head"><div><span class="eyebrow">${t('yourOrders')}</span><h1>${t('trackH')}</h1></div>
      ${mine.length ? `<button class="btn btn-sm" data-action="refresh-orders">${t('refresh')}</button>` : ''}</div>
    ${mine.length ? `<div class="orders">${mine.map(o => orderCard(o)).join('')}</div>`
      : `<div class="empty"><h3>${t('noOrders')}</h3><p>${t('noOrdersP')}</p><a class="btn btn-brand" href="#shop">${t('startShopping')}</a></div>`}
  </div>`;
}

/* ---------------- events ---------------- */
function renderEvents() {
  const el = $('#view-events');
  if (!ui.ready) { el.innerHTML = loadingState(); return; }
  const pkgs = S.events.filter(e => e.active !== false);
  const sel = ui.eventPkg || pkgs[0]?.id;
  const today = new Date().toISOString().slice(0, 10);
  const last = LS.lastCustomer || {};
  el.innerHTML = `<div class="stack">
    <div class="events-hero">
      <span class="eyebrow">${t('eventsEyebrow')}</span>
      <h1>${t('eventsH')}</h1>
      <p class="muted">${t('eventsP')}</p>
    </div>
    <div class="events-grid">${pkgs.map(e => `<article class="pkg ${e.id === sel ? 'selected' : ''}">
      <div class="pkg-art">${e.id === 'ev01' ? `<span style="${tileStyle('Shisha')}">${catIcon('Shisha')}</span>`
        : e.id === 'ev02' ? `<span style="${tileStyle('Tea')}">${catIcon('Tea')}</span>`
        : e.id === 'ev03' ? `<span style="${tileStyle('Cheesecake')}">${catIcon('Cheesecake')}</span>`
        : ['Shisha', 'Tea', 'Cheesecake'].map(k => `<span style="${tileStyle(k)}">${catIcon(k)}</span>`).join('')}</div>
      <h3>${esc(nm(e))}</h3>
      <p class="muted small">${esc(nm(e, 'desc'))}</p>
      <div class="pkg-foot">
        <div><div class="price">${money(e.price)}${e.was ? ` <s class="muted small">${fmt(e.was)}</s>` : ''}</div><div class="muted small">${esc(nm(e, 'guests'))}</div></div>
        <button class="btn btn-sm ${e.id === sel ? 'btn-brand' : ''}" data-action="pick-pkg" data-id="${e.id}">${t('requestBooking')}</button>
      </div>
    </article>`).join('')}</div>
    <form class="form-card booking" id="eventForm" autocomplete="on">
      <h2>${t('bookingForm')}</h2>
      ${ui.eventSent ? `<div class="notice" style="background:var(--brand-soft)">${esc(t('requestSent', { p: ui.eventSent }))}</div>` : ''}
      <div class="grid-2">
        <label class="field"><span>${t('package')}</span><select id="evPkg" name="package">${pkgs.map(e => `<option value="${e.id}" ${e.id === sel ? 'selected' : ''}>${esc(nm(e))} · ${money(e.price)}</option>`).join('')}</select></label>
        <label class="field"><span>${t('eventDate')}</span><input id="evDate" name="date" type="date" required min="${today}"></label>
      </div>
      <div class="grid-2">
        <label class="field"><span>${t('fullName')}</span><input id="evName" name="name" required minlength="2" maxlength="80" value="${esc(last.name || '')}"></label>
        <label class="field"><span>${t('mobile')}</span><input id="evPhone" name="phone" type="tel" dir="ltr" required placeholder="05x xxx xxxx" value="${esc(last.phone || '')}"></label>
      </div>
      <div class="grid-2">
        <label class="field"><span>${t('guestsN')}</span><input id="evGuests" name="guests" type="number" min="1" max="2000" required value="30"></label>
        <label class="field"><span>${t('district')}</span><input id="evDistrict" name="district" maxlength="80" placeholder="${esc(lang === 'ar' ? 'العليا' : 'Al Olaya')}"></label>
      </div>
      <label class="field"><span>${t('notesOpt')}</span><textarea id="evNotes" name="notes" maxlength="1000"></textarea></label>
      <button class="btn btn-brand" type="submit" ${ui.sendingEvent ? 'disabled' : ''}>${ui.sendingEvent ? t('sending') : t('sendRequest')}</button>
    </form>
  </div>`;
}

async function sendEventRequest(form) {
  const f = Object.fromEntries(new FormData(form));
  if (!validPhone(f.phone)) { toast(t('err_invalid_phone')); $('#evPhone')?.focus(); return; }
  ui.sendingEvent = true; renderEvents();
  const { error } = await db.from('event_requests').insert({
    package_id: f.package, name: f.name.trim(), phone: normPhone(f.phone), event_date: f.date,
    guests: Math.round(+f.guests), district: f.district.trim() || null, notes: f.notes.trim() || null,
  });
  ui.sendingEvent = false;
  if (error) { toast(errText(error)); renderEvents(); return; }
  LS.lastCustomer = { ...LS.lastCustomer, name: f.name, phone: f.phone }; saveLocal();
  ui.eventSent = f.phone;
  renderEvents();
  $('#eventForm')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ---------------- maps ---------------- */
function baseMap(el) {
  const map = L.map(el, { zoomControl: true, attributionControl: true }).setView(MAP_CENTER, 11);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);
  return map;
}
const storeIcon = cls => L.divIcon({ className: '', html: `<div class="pin-store ${cls || ''}">W</div>`, iconSize: [30, 30], iconAnchor: [15, 15] });
const meIcon = () => L.divIcon({ className: '', html: '<div class="pin-me"></div>', iconSize: [22, 22], iconAnchor: [11, 11] });
const vertexIcon = () => L.divIcon({ className: '', html: '<div class="pin-vertex"></div>', iconSize: [12, 12], iconAnchor: [6, 6] });

function drawZones(layer, { highlight = [], labels = true, dim = null } = {}) {
  layer.clearLayers();
  S.zones.forEach(z => {
    if (z.poly.length < 3) return;
    const hi = highlight.includes(z.id);
    const isDim = dim && dim !== z.id;
    const pg = L.polygon(z.poly, {
      color: z.color, weight: hi ? 3 : 1.6, fillOpacity: z.active === false ? 0.04 : hi ? 0.32 : isDim ? 0.06 : 0.16,
      dashArray: z.active === false ? '6 6' : null,
    }).addTo(layer);
    if (labels) pg.bindTooltip(`${z.code}`, { permanent: true, direction: 'center', className: 'zone-label' });
  });
}
function fitAll(map) {
  const pts = S.zones.flatMap(z => z.poly);
  if (pts.length) map.fitBounds(L.latLngBounds(pts), { padding: [20, 20] });
}

/* ---------- location picker ---------- */
let locMap, locLayers;
function renderSamples() {
  $('#samples').innerHTML = SAMPLES.map((s, i) => `<button class="chip" data-action="sample" data-i="${i}">${esc(s[lang === 'ar' ? 1 : 0])}</button>`).join('');
}
function openLoc() {
  $('#locModal').hidden = false;
  ui.pendingLoc = LS.customer ? { ...LS.customer } : null;
  renderSamples();
  if (!locMap) {
    locMap = baseMap($('#locMap'));
    locLayers = { zones: L.layerGroup().addTo(locMap), stores: L.layerGroup().addTo(locMap), me: L.layerGroup().addTo(locMap) };
    locMap.on('click', e => setPending({ lat: e.latlng.lat, lng: e.latlng.lng, kind: 'pin' }));
  }
  setTimeout(() => { locMap.invalidateSize(); updateLocModal(true); }, 30);
}
function setPending(loc, fly = false) { ui.pendingLoc = loc; updateLocModal(fly); }
function updateLocModal(fly) {
  if (!locMap) return;
  const loc = ui.pendingLoc;
  const res = resolve(loc);
  drawZones(locLayers.zones, { highlight: res ? res.zones.map(z => z.id) : [] });
  locLayers.stores.clearLayers();
  S.stores.forEach(s => L.marker([s.lat, s.lng], { icon: storeIcon(res?.pick?.store.id === s.id ? 'picked' : (!s.active || !isOpen(s)) ? 'off' : '') }).bindTooltip(nm(s)).addTo(locLayers.stores));
  locLayers.me.clearLayers();
  const prev = $('#locPreview');
  $('#locConfirm').disabled = !loc;
  if (!loc) {
    prev.innerHTML = `<span class="muted">${t('locEmpty')}</span>`;
    fitAll(locMap);
    return;
  }
  L.marker([loc.lat, loc.lng], { icon: meIcon(), zIndexOffset: 1000 }).addTo(locLayers.me);
  if (fly) locMap.setView([loc.lat, loc.lng], 13);
  const c = `<span class="mono muted">${coords(loc)}</span>`;
  if (!res.zones.length) {
    prev.innerHTML = `<span class="pill pill-off">${t('outside')}</span>${c}${res.nearest ? `<span class="small muted">${t('closestZone', { z: esc(nm(res.nearest.zone)), d: ltr(res.nearest.dist.toFixed(1)) })}</span>` : ''}`;
  } else if (!res.pick) {
    prev.innerHTML = `${zoneTag(res.zones[0], false)}<span class="pill pill-warn">${t('noOpenStore')}</span>${c}`;
  } else {
    prev.innerHTML = `${zoneTag(res.zones[0])}<b>${esc(nm(res.pick.store))}</b><span class="pill pill-ok">${etaStr(eta(res.pick))}</span>${c}`;
  }
}
function closeLoc() { $('#locModal').hidden = true; }

function detectLocation(onDone) {
  const status = $('#gpsStatus');
  if (!('geolocation' in navigator)) { status.textContent = t('gpsNone'); onDone?.(null); return; }
  status.textContent = t('gpsBusy');
  navigator.geolocation.getCurrentPosition(
    p => { status.textContent = t('gpsFound', { m: Math.round(p.coords.accuracy) }); onDone?.({ lat: p.coords.latitude, lng: p.coords.longitude, kind: 'gps' }); },
    err => { status.textContent = err.code === 1 ? t('gpsDenied') : t('gpsFail'); onDone?.(null); },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
  );
}
function setCustomer(loc) {
  const before = current()?.pick?.store.id;
  LS.customer = loc; saveLocal();
  const after = current();
  if (after?.pick && before && after.pick.store.id !== before) toast(t('toastSwitched', { s: nm(after.pick.store) }));
  else if (after?.pick) toast(t('toastFrom', { s: nm(after.pick.store) }));
  renderAll();
}

/* ---------------- admin: auth ---------------- */
async function checkAdmin(session) {
  ui.session = session;
  ui.isAdmin = false;
  if (session?.user) {
    const { data } = await db.from('admins').select('user_id').eq('user_id', session.user.id).maybeSingle();
    ui.isAdmin = !!data;
  }
}

function adminLogin() {
  const user = ui.session?.user;
  return `<div class="login-card">
    <img src="${esc(BRAND.logoUrl)}" alt="" class="login-logo">
    <h2>${t('adminSignIn')}</h2>
    <p class="muted">${t('adminSignInP')}</p>
    ${ui.authMsg ? `<div class="notice">${esc(ui.authMsg)}</div>` : ''}
    ${user ? `<div class="notice notice-danger">${esc(t('signedInAs', { e: user.email }))}. ${t('notAdmin')}</div>
      <button class="btn" data-action="sign-out">${t('signOut')}</button>`
    : `<form id="loginForm" class="stack">
      <label class="field"><span>${t('email')}</span><input id="lgEmail" name="email" type="email" dir="ltr" required autocomplete="username"></label>
      <label class="field"><span>${t('password')}</span><input id="lgPass" name="password" type="password" dir="ltr" required minlength="8" autocomplete="current-password"></label>
      <div class="row"><button class="btn btn-brand" type="submit">${t('signIn')}</button><button class="btn btn-ghost" type="button" data-action="sign-up">${t('signUp')}</button></div>
    </form>`}
  </div>`;
}

/* ---------------- admin ---------------- */
let adminMap, A;
function ensureAdminMap() {
  if (adminMap) { setTimeout(() => adminMap.invalidateSize(), 30); return; }
  adminMap = baseMap($('#adminMap'));
  A = {
    zones: L.layerGroup().addTo(adminMap), links: L.layerGroup().addTo(adminMap),
    stores: L.layerGroup().addTo(adminMap), draft: L.layerGroup().addTo(adminMap), test: L.layerGroup().addTo(adminMap),
  };
  adminMap.on('click', onAdminMapClick);
  setTimeout(() => { adminMap.invalidateSize(); fitAll(adminMap); }, 30);
}

function onAdminMapClick(e) {
  const pt = [+e.latlng.lat.toFixed(5), +e.latlng.lng.toFixed(5)];
  if (ui.mapMode === 'draw' && ui.zoneEdit) {
    ui.zoneEdit.poly.push(pt);
    redrawAdminMap(); updateDrawStatus();
  } else if (ui.mapMode === 'place' && ui.storeEdit) {
    ui.storeEdit.lat = pt[0]; ui.storeEdit.lng = pt[1];
    ui.mapMode = 'test';
    renderAdminBody(); redrawAdminMap();
  } else {
    ui.testLoc = { lat: pt[0], lng: pt[1] };
    ui.adminTab = 'overview';
    renderAdmin();
  }
}

function redrawAdminMap() {
  if (!adminMap) return;
  const test = ui.testLoc ? resolve(ui.testLoc) : null;
  let highlight = test ? test.zones.map(z => z.id) : [];
  if (ui.focus?.type === 'store') {
    const s = S.stores.find(x => x.id === ui.focus.id);
    highlight = s ? s.coverage.map(c => c.zone) : [];
  }
  if (ui.storeEdit) highlight = ui.storeEdit.coverage.map(c => c.zone);
  drawZones(A.zones, { highlight, dim: ui.zoneEdit?.id });

  A.links.clearLayers();
  const linkStore = ui.storeEdit || (ui.focus?.type === 'store' && S.stores.find(x => x.id === ui.focus.id));
  if (linkStore && linkStore.lat != null) {
    linkStore.coverage.forEach(c => {
      const z = S.zones.find(x => x.id === c.zone); if (!z) return;
      const cc = centroid(z.poly);
      L.polyline([[linkStore.lat, linkStore.lng], [cc.lat, cc.lng]], { color: z.color, weight: 2.5, dashArray: c.role === 'backup' ? '5 7' : null, opacity: .9 }).addTo(A.links);
    });
  }

  A.stores.clearLayers();
  S.stores.forEach(s => {
    if (ui.storeEdit && ui.storeEdit.id === s.id) return;
    const cls = test?.pick?.store.id === s.id ? 'picked' : (!s.active || !isOpen(s)) ? 'off' : '';
    L.marker([s.lat, s.lng], { icon: storeIcon(cls) }).bindTooltip(`${nm(s)}${isOpen(s) ? '' : ' ' + t('closedTip')}`).addTo(A.stores)
      .on('click', ev => { L.DomEvent.stopPropagation(ev); ui.adminTab = 'stores'; ui.focus = { type: 'store', id: s.id }; renderAdmin(); });
  });
  if (ui.storeEdit && ui.storeEdit.lat != null) L.marker([ui.storeEdit.lat, ui.storeEdit.lng], { icon: storeIcon('picked') }).addTo(A.stores);

  A.draft.clearLayers();
  if (ui.zoneEdit) {
    const p = ui.zoneEdit.poly;
    if (p.length >= 3) L.polygon(p, { color: ui.zoneEdit.color, weight: 3, fillOpacity: .28 }).addTo(A.draft);
    else if (p.length === 2) L.polyline(p, { color: ui.zoneEdit.color, weight: 3 }).addTo(A.draft);
    p.forEach(pt => L.marker(pt, { icon: vertexIcon(), interactive: false }).addTo(A.draft));
  }

  A.test.clearLayers();
  if (ui.testLoc) {
    L.marker([ui.testLoc.lat, ui.testLoc.lng], { icon: meIcon(), zIndexOffset: 1000 }).addTo(A.test);
    if (test?.pick) L.polyline([[ui.testLoc.lat, ui.testLoc.lng], [test.pick.store.lat, test.pick.store.lng]], { color: '#CC9F50', weight: 3, dashArray: '2 6' }).addTo(A.test);
  }

  $('#mapHint').textContent = ui.mapMode === 'draw' ? t('hintDraw', { n: ui.zoneEdit?.poly.length || 0 })
    : ui.mapMode === 'place' ? t('hintPlace') : '';
}

function renderAdmin() {
  if (!ui.isAdmin) {
    $('#adminTabs').innerHTML = '';
    $('#adminShell').classList.add('wide');
    $('#adminBody').innerHTML = adminLogin();
    return;
  }
  const newEvents = ui.eventReqs.filter(e => e.status === 'new').length;
  const tabs = [['overview'], ['zones', S.zones.length], ['stores', S.stores.length], ['products', S.products.length], ['orders', ui.adminOrders.filter(o => o.status < 3).length], ['events', newEvents]];
  $('#adminTabs').innerHTML = tabs.map(([id, n]) => `<button class="tab ${ui.adminTab === id ? 'active' : ''}" data-action="admin-tab" data-tab="${id}" role="tab">${t('tab_' + id)}${n != null ? `<span class="count">${n}</span>` : ''}</button>`).join('');
  const wide = ['products', 'orders', 'events'].includes(ui.adminTab);
  $('#adminShell').classList.toggle('wide', wide);
  renderAdminBody();
  if (!wide) { ensureAdminMap(); redrawAdminMap(); }
}

function renderAdminBody() {
  if (!ui.isAdmin) { $('#adminBody').innerHTML = adminLogin(); return; }
  const fn = { overview: adminOverview, zones: adminZones, stores: adminStores, products: adminProducts, orders: adminOrders, events: adminEvents }[ui.adminTab];
  $('#adminBody').innerHTML = fn();
  if (ui.adminTab === 'zones' && ui.zoneEdit) updateDrawStatus();
}

function adminOverview() {
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
  const todays = ui.adminOrders.filter(o => new Date(o.created_at).toLocaleDateString('en-CA', { timeZone: TZ }) === todayStr);
  const openNow = S.stores.filter(s => s.active && isOpen(s)).length;
  const covered = S.zones.filter(z => S.stores.some(s => s.coverage.some(c => c.zone === z.id && c.role === 'primary'))).length;
  const test = ui.testLoc ? resolve(ui.testLoc) : null;
  let testHtml = `<p class="muted">${t('testerP')}</p>`;
  if (test) {
    testHtml = `<div class="test-result">
      <div class="row"><span class="mono muted">${coords(test.loc)}</span>
        ${test.zones.length ? test.zones.map(z => zoneTag(z)).join('') : `<span class="pill pill-off">${t('outsideAll')}</span>`}</div>
      ${test.zones.length ? whyList(test) : test.nearest ? `<p class="muted small">${t('closestZoneP', { z: esc(nm(test.nearest.zone)), d: ltr(test.nearest.dist.toFixed(1)) })}</p>` : ''}
      <div class="row"><button class="btn btn-sm" data-action="test-as-customer">${t('shopFromHere')}</button><button class="btn btn-sm btn-ghost" data-action="test-clear">${t('clear')}</button></div>
    </div>`;
  }
  return `<div class="section-head"><div><span class="eyebrow">${t('operations')}</span><h2>${t('networkOverview')}</h2></div>
      <span class="pill pill-ok">${t('liveData')}</span></div>
    <div class="kpis">
      <div class="kpi"><b>${S.zones.length}</b><span>${t('kpiZones', { n: covered })}</span></div>
      <div class="kpi"><b>${ltr(`${openNow}/${S.stores.length}`)}</b><span>${t('kpiOpen')}</span></div>
      <div class="kpi"><b>${todays.length}</b><span>${t('kpiOrders')}</span></div>
      <div class="kpi"><b class="num">${fmt(todays.reduce((s, o) => s + +o.total, 0))}</b><span>${t('kpiRevenue', { c: t('currency') })}</span></div>
    </div>
    <div class="form-card"><div class="section-head"><h3>${t('tester')}</h3></div>${testHtml}</div>
    <div class="form-card">
      <h3>${t('howChosen')}</h3>
      <ol class="small muted how"><li>${t('how1')}</li><li>${t('how2')}</li><li>${t('how3')}</li><li>${t('how4')}</li></ol>
    </div>
    <div class="row small muted">${esc(t('signedInAs', { e: ui.session?.user?.email || '' }))} · <button class="link-btn" data-action="sign-out">${t('signOut')}</button></div>`;
}

/* ----- zones ----- */
function adminZones() {
  if (ui.zoneEdit) {
    const z = ui.zoneEdit;
    return `<div class="section-head"><h2>${S.zones.some(x => x.id === z.id) ? t('editZone') : t('newZone')}</h2></div>
      <div class="form-card">
        <div class="draw-status" id="drawStatus"></div>
        <div class="grid-2">
          <label class="field"><span>${t('nameEn')}</span><input id="zName" dir="ltr" data-zf="name" value="${esc(z.name)}" placeholder="Al Wurud"></label>
          <label class="field"><span>${t('nameAr')}</span><input id="zNameAr" dir="rtl" lang="ar" data-zf="nameAr" value="${esc(z.nameAr || '')}" placeholder="الورود"></label>
        </div>
        <div class="grid-2">
          <label class="field"><span>${t('code')}</span><input id="zCode" dir="ltr" data-zf="code" value="${esc(z.code)}" placeholder="WRD-09"></label>
          <label class="field"><span>${t('mapColor')}</span><input id="zColor" type="color" data-zf="color" value="${esc(z.color)}"></label>
        </div>
        <div class="grid-2">
          <label class="field"><span>${t('fee')} (${t('currency')})</span><input id="zFee" type="number" min="0" data-zf="fee" value="${z.fee}"></label>
          <label class="field"><span>${t('minOrderShort')} (${t('currency')})</span><input id="zMin" type="number" min="0" data-zf="minOrder" value="${z.minOrder}"></label>
        </div>
        <label class="row small"><input id="zActive" type="checkbox" data-zf="active" ${z.active !== false ? 'checked' : ''}> ${t('zoneLive')}</label>
        <div class="row">
          <button class="btn btn-brand" data-action="zone-save">${t('saveZone')}</button>
          <button class="btn btn-ghost" data-action="zone-cancel">${t('cancel')}</button>
        </div>
      </div>`;
  }
  return `<div class="section-head"><div><span class="eyebrow">${t('deliveryAreas')}</span><h2>${t('tab_zones')}</h2></div><button class="btn btn-brand btn-sm" data-action="zone-new">${t('drawZone')}</button></div>
    <div class="list">${S.zones.map(z => {
      const cov = S.stores.filter(s => s.coverage.some(c => c.zone === z.id));
      const hasPrimary = cov.some(s => s.coverage.find(c => c.zone === z.id).role === 'primary');
      return `<div class="item">
        <span class="swatch" style="background:${esc(z.color)}"></span>
        <div><b>${esc(nm(z))}</b> <span class="mono muted">${esc(z.code)}</span></div>
        <div class="row" style="gap:6px"><button class="btn btn-sm" data-action="zone-edit" data-id="${z.id}">${t('edit')}</button><button class="btn btn-sm btn-danger ${ui.armed === 'z' + z.id ? 'armed' : ''}" data-action="zone-del" data-id="${z.id}">${ui.armed === 'z' + z.id ? t('confirm') : t('del')}</button></div>
        <div class="item-meta">
          ${z.active === false ? `<span class="pill pill-off">${t('pausedPill')}</span>` : ''}
          <span class="mono">${ltr(areaKm2(z.poly).toFixed(1) + ' km²')}</span> · <span>${t('feeX', { m: money(z.fee) })}</span> · <span>${t('minX', { m: money(z.minOrder) })}</span> ·
          ${hasPrimary ? `<span>${t('storesN', { n: cov.length })}</span>` : `<span style="color:var(--danger)">${t('noPrimary')}</span>`}
        </div>
      </div>`;
    }).join('')}</div>`;
}
function updateDrawStatus() {
  const el = $('#drawStatus'); if (!el || !ui.zoneEdit) return;
  const n = ui.zoneEdit.poly.length;
  el.innerHTML = `<span class="small">${t('corners', { n })} · ${n >= 3 ? `<span class="mono">${ltr(areaKm2(ui.zoneEdit.poly).toFixed(2) + ' km²')}</span>` : t('add3')}</span>
    <span class="row" style="gap:6px"><button class="btn btn-sm" data-action="zone-undo" ${n ? '' : 'disabled'}>${t('undo')}</button><button class="btn btn-sm" data-action="zone-clear" ${n ? '' : 'disabled'}>${t('redraw')}</button></span>`;
}

/* ----- stores ----- */
function adminStores() {
  if (ui.storeEdit) {
    const s = ui.storeEdit;
    const roleOf = zid => s.coverage.find(c => c.zone === zid)?.role || 'none';
    const roleLabel = { none: t('off'), primary: t('primary'), backup: t('backup') };
    return `<div class="section-head"><h2>${S.stores.some(x => x.id === s.id) ? t('editStore') : t('newStore')}</h2></div>
      <div class="form-card">
        <div class="grid-2">
          <label class="field"><span>${t('nameEn')}</span><input id="sName" dir="ltr" data-sf="name" value="${esc(s.name)}" placeholder="WIns Al Wurud"></label>
          <label class="field"><span>${t('nameAr')}</span><input id="sNameAr" dir="rtl" lang="ar" data-sf="nameAr" value="${esc(s.nameAr || '')}" placeholder="WIns الورود"></label>
        </div>
        <div class="field"><span>${t('location')}</span>
          <div class="row">
            <span class="mono">${s.lat != null ? ltr(`${s.lat.toFixed(5)}, ${s.lng.toFixed(5)}`) : t('notSet')}</span>
            <button class="btn btn-sm ${ui.mapMode === 'place' ? 'btn-gold' : ''}" data-action="store-pick">${ui.mapMode === 'place' ? t('clickMap') : s.lat != null ? t('moveMap') : t('pickMap')}</button>
          </div>
        </div>
        <div class="grid-3">
          <label class="field"><span>${t('opens')}</span><input id="sOpen" type="time" data-sf="open" value="${esc(s.open)}"></label>
          <label class="field"><span>${t('closes')}</span><input id="sClose" type="time" data-sf="close" value="${esc(s.close === '24:00' ? '23:59' : s.close)}"></label>
          <label class="field"><span>${t('prep')}</span><input id="sPrep" type="number" min="1" max="240" data-sf="prep" value="${s.prep}"></label>
        </div>
        <label class="row small"><input id="sActive" type="checkbox" data-sf="active" ${s.active ? 'checked' : ''}> ${t('accepting')}</label>
        <div class="field"><span>${t('covering')}</span>
          <p class="small muted">${t('coveringP')}</p>
          <div class="cov-table">${S.zones.map(z => `<div class="cov-row">
            <span class="row" style="gap:8px"><span class="swatch" style="background:${esc(z.color)}"></span>${esc(nm(z))} <span class="mono muted">${esc(z.code)}</span></span>
            <span class="seg">${['none', 'primary', 'backup'].map(r => `<button type="button" class="${roleOf(z.id) === r ? 'on ' + r : ''}" data-action="cov" data-zone="${z.id}" data-role="${r}">${roleLabel[r]}</button>`).join('')}</span>
          </div>`).join('')}</div>
        </div>
        <div class="row">
          <button class="btn btn-brand" data-action="store-save">${t('saveStore')}</button>
          <button class="btn btn-ghost" data-action="store-cancel">${t('cancel')}</button>
        </div>
      </div>`;
  }
  return `<div class="section-head"><div><span class="eyebrow">${t('fulfilment')}</span><h2>${t('tab_stores')}</h2></div><button class="btn btn-brand btn-sm" data-action="store-new">${t('addStore')}</button></div>
    <div class="list">${S.stores.map(s => {
      const open = isOpen(s);
      const skus = Object.values(S.inventory[s.id] || {}).filter(q => q > 0).length;
      return `<div class="item ${ui.focus?.id === s.id ? 'focus' : ''}" data-action="store-focus" data-id="${s.id}">
        <span class="store-dot">W</span>
        <div><b>${esc(nm(s))}</b><div class="small muted">${t('storeLine', { h: hours(s), n: skus, p: s.prep })}</div></div>
        <div class="row" style="gap:6px"><button class="btn btn-sm" data-action="store-edit" data-id="${s.id}">${t('edit')}</button><button class="btn btn-sm btn-danger ${ui.armed === 's' + s.id ? 'armed' : ''}" data-action="store-del" data-id="${s.id}">${ui.armed === 's' + s.id ? t('confirm') : t('del')}</button></div>
        <div class="item-meta">
          ${!s.active ? `<span class="pill pill-off">${t('pausedPill')}</span>` : open ? `<span class="pill pill-ok">${t('open')}</span>` : `<span class="pill pill-warn">${t('closed')}</span>`}
          ${s.coverage.map(c => { const z = S.zones.find(x => x.id === c.zone); return z ? `<span class="cov cov-${c.role}" title="${t('role_' + c.role)}">${esc(z.code)}</span>` : ''; }).join('')}
        </div>
      </div>`;
    }).join('')}</div>`;
}

/* ----- products ----- */
const shortStore = s => nm(s).replace(/^WIns\s+/, '');
function adminProducts() {
  return `<div class="section-head"><div><span class="eyebrow">${t('catalogInv')}</span><h2>${t('tab_products')}</h2></div></div>
    <form class="form-card" id="newProduct">
      <h3>${t('addProduct')}</h3>
      <div class="grid-2">
        <label class="field"><span>${t('nameEn')}</span><input id="npName" name="name" dir="ltr" required maxlength="120" placeholder="Lotus Cheesecake"></label>
        <label class="field"><span>${t('nameAr')}</span><input id="npNameAr" name="nameAr" dir="rtl" lang="ar" maxlength="120" placeholder="تشيز كيك لوتس"></label>
      </div>
      <div class="grid-3" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr))">
        <label class="field"><span>${t('category')}</span><select id="npCat" name="category">${S.categories.map(c => `<option value="${esc(c.key)}">${esc(nm(c))}</option>`).join('')}</select></label>
        <label class="field"><span>${t('priceC', { c: t('currency') })}</span><input id="npPrice" name="price" type="number" min="0" step="0.5" required></label>
        <label class="field"><span>${t('unit')}</span><input id="npUnit" name="unit" dir="ltr" maxlength="60" placeholder="1 slice"></label>
        <label class="field"><span>${t('unitAr')}</span><input id="npUnitAr" name="unitAr" dir="rtl" lang="ar" maxlength="60" placeholder="شريحة"></label>
      </div>
      <div class="row"><label class="field" style="flex:1"><span>${t('startStock')}</span><input id="npStock" name="stock" type="number" min="0" value="20"></label><button class="btn btn-brand" type="submit" style="align-self:end">${t('addProductBtn')}</button></div>
    </form>
    <p class="small muted">${t('stockNote')}</p>
    <div class="table-wrap"><table>
      <thead><tr><th>${t('product')}</th><th>${t('listed')}</th><th class="n">${t('price')}</th>${S.stores.map(s => `<th class="n" title="${esc(nm(s))}">${esc(shortStore(s))}</th>`).join('')}<th></th></tr></thead>
      <tbody>${S.products.map(p => `<tr>
        <td><div class="prod-cell"><span class="mini" style="${tileStyle(p.category)}">${catIcon(p.category)}</span><div><b>${esc(nm(p))}</b><div class="small muted">${esc(catLabel(p.category))} · ${esc(nm(p, 'unit'))}</div></div></div></td>
        <td><input type="checkbox" data-listed="${p.id}" ${p.listed !== false ? 'checked' : ''} aria-label="${t('listed')}"></td>
        <td class="n"><input class="stock-in" type="number" min="0" step="0.5" data-price="${p.id}" value="${p.price}" aria-label="${t('price')}"></td>
        ${S.stores.map(s => { const q = stockOf(s.id, p.id); return `<td class="n"><input class="stock-in ${q === 0 ? 'zero' : q === undefined ? 'na' : ''}" type="number" min="0" placeholder="—" data-stock="${s.id}|${p.id}" value="${q ?? ''}" aria-label="${esc(t('stockAt', { s: nm(s) }))}"></td>`; }).join('')}
        <td><button class="btn btn-sm btn-danger ${ui.armed === 'p' + p.id ? 'armed' : ''}" data-action="prod-del" data-id="${p.id}">${ui.armed === 'p' + p.id ? t('confirm') : t('del')}</button></td>
      </tr>`).join('')}</tbody>
    </table></div>`;
}

/* ----- orders ----- */
const adminOrderShape = o => ({
  ...o, store: o.store_name, store_ar: o.store_name_ar, zone: o.zone_name, zone_ar: o.zone_name_ar,
  items: (o.order_items || []).map(i => ({ name: i.name, name_ar: i.name_ar, qty: i.qty })),
});
function adminOrders() {
  const active = ui.adminOrders.filter(o => o.status < 3);
  return `<div class="section-head"><div><span class="eyebrow">${t('dispatchEy')}</span><h2>${t('tab_orders')}</h2></div>
      <span class="row"><span class="muted small">${t('inProgress', { n: active.length })}</span><button class="btn btn-sm" data-action="admin-refresh">${t('refresh')}</button></span></div>
    ${ui.adminOrders.length ? `<div class="orders" style="max-width:none">${ui.adminOrders.map(o => orderCard(adminOrderShape(o), true)).join('')}</div>`
      : `<div class="empty"><h3>${t('noOrders')}</h3><p>${t('noOrdersAdminP')}</p></div>`}`;
}

/* ----- event requests ----- */
function adminEvents() {
  const statuses = ['new', 'contacted', 'confirmed', 'cancelled'];
  return `<div class="section-head"><div><span class="eyebrow">${t('eventsEyebrow')}</span><h2>${t('tab_events')}</h2></div><button class="btn btn-sm" data-action="admin-refresh">${t('refresh')}</button></div>
    ${ui.eventReqs.length ? `<div class="list">${ui.eventReqs.map(r => {
      const pkg = S.events.find(e => e.id === r.package_id);
      return `<div class="item event-req">
        <span class="store-dot"><svg viewBox="0 0 24 24" aria-hidden="true">${EVENT_ICON}</svg></span>
        <div><b>${esc(r.name)}</b> · <span class="mono">${esc(r.phone)}</span>
          <div class="small muted">${esc(pkg ? nm(pkg) : '—')} · ${ltr(esc(r.event_date))} · ${t('guestsCount', { n: r.guests })}${r.district ? ' · ' + esc(r.district) : ''}</div>
          ${r.notes ? `<div class="small">${esc(r.notes)}</div>` : ''}</div>
        <span class="seg">${statuses.map(s => `<button type="button" class="${r.status === s ? 'on' : ''}" data-action="event-status" data-id="${r.id}" data-status="${s}">${t('evStatus_' + s)}</button>`).join('')}</span>
      </div>`;
    }).join('')}</div>` : `<div class="empty"><h3>${t('noEventReqs')}</h3></div>`}`;
}

/* ---------------- admin writes ---------------- */
async function write(fn, { reload = true, quiet = false } = {}) {
  try {
    const results = [].concat(await fn());
    const bad = results.find(r => r && r.error);
    if (bad) throw bad.error;
    if (!quiet) toast(t('savedOk'));
    if (reload) { await loadCatalog(); await loadAdminData(); renderAll(); }
    return true;
  } catch (e) {
    toast(t('saveFail', { m: e.message || e }));
    return false;
  }
}

/* ---------------- render ---------------- */
const ROUTES = ['shop', 'events', 'orders', 'admin'];
function renderAll() {
  renderHeader();
  ROUTES.forEach(r => ($('#view-' + r).hidden = ui.route !== r));
  if (ui.route === 'shop') renderShop();
  if (ui.route === 'events') renderEvents();
  if (ui.route === 'orders') renderOrders();
  if (ui.route === 'admin') renderAdmin();
  renderCart();
}
function route() {
  const r = location.hash.slice(1) || 'shop';
  ui.route = ROUTES.includes(r) ? r : 'shop';
  if (ui.route === 'orders') refreshMyOrders();
  if (ui.route === 'events') ui.eventSent = null;
  renderAll();
  window.scrollTo(0, 0);
}
function setLang(next) {
  lang = next;
  try { localStorage.setItem(LANG_KEY, lang); } catch (e) { /* storage blocked */ }
  applyStatic();
  renderAll();
  if (!$('#locModal').hidden) { renderSamples(); updateLocModal(false); }
  setTimeout(() => { locMap?.invalidateSize(); adminMap?.invalidateSize(); }, 30);
}

/* ---------------- events ---------------- */
function setQty(pid, delta) {
  const store = current()?.pick?.store;
  const next = (LS.cart[pid] || 0) + delta;
  if (delta > 0 && store && next > (stockOf(store.id, pid) || 0)) { toast(t('maxStock')); return; }
  if (next <= 0) delete LS.cart[pid]; else LS.cart[pid] = next;
  saveLocal();
  if (delta > 0) { const b = $('#cartBtn'); b.classList.remove('bump'); void b.offsetWidth; b.classList.add('bump'); }
  renderHeader();
  if (ui.route === 'shop') renderShop();
  renderCart();
}

const actions = {
  'retry': () => { ui.loadError = null; renderAll(); refreshAll(); },
  'toggle-lang': () => setLang(lang === 'ar' ? 'en' : 'ar'),
  'open-loc': () => openLoc(),
  'close-loc': () => closeLoc(),
  'use-gps': () => detectLocation(loc => loc && setPending(loc, true)),
  'use-gps-direct': () => { openLoc(); detectLocation(loc => loc && setPending(loc, true)); },
  'sample': el => { const i = +el.dataset.i, s = SAMPLES[i]; setPending({ lat: s[2], lng: s[3], sample: i }, true); },
  'loc-confirm': () => { if (ui.pendingLoc) setCustomer(ui.pendingLoc); closeLoc(); },
  'why-toggle': () => { ui.whyOpen = !ui.whyOpen; renderShop(); },
  'cat': el => { ui.cat = el.dataset.cat; renderShop(); },
  'inc': el => setQty(el.dataset.id, 1),
  'dec': el => setQty(el.dataset.id, -1),
  'open-cart': () => { ui.cartOpen = true; ui.checkout = false; renderCart(); },
  'close-cart': () => { ui.cartOpen = false; ui.checkout = false; renderCart(); },
  'checkout': () => { ui.checkout = true; renderCart(); },
  'back-cart': () => { ui.checkout = false; renderCart(); },
  'refresh-orders': () => refreshMyOrders(),
  'pick-pkg': el => {
    ui.eventPkg = el.dataset.id; ui.eventSent = null; renderEvents();
    $('#eventForm')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  },

  // admin auth
  'sign-up': async () => {
    const email = $('#lgEmail')?.value.trim(), password = $('#lgPass')?.value;
    if (!email || !password || password.length < 8) { $('#loginForm')?.reportValidity(); return; }
    const { error } = await db.auth.signUp({ email, password });
    ui.authMsg = error ? t('authFail', { m: error.message }) : t('signUpDone');
    renderAdminBody();
  },
  'sign-out': async () => { await db.auth.signOut(); ui.authMsg = ''; },

  'admin-tab': el => { ui.adminTab = el.dataset.tab; ui.zoneEdit = null; ui.storeEdit = null; ui.mapMode = 'test'; ui.focus = null; renderAdmin(); },
  'admin-refresh': async () => { await loadAdminData().catch(e => toast(t('saveFail', { m: e.message }))); renderAdmin(); },
  'test-clear': () => { ui.testLoc = null; renderAdmin(); },
  'test-as-customer': () => { setCustomer({ ...ui.testLoc, kind: 'pin' }); location.hash = '#shop'; },

  'zone-new': () => {
    ui.zoneEdit = { id: uid('z'), code: `ZN-${pad(S.zones.length + 1)}`, name: '', nameAr: '', color: '#CC9F50', fee: 12, minOrder: 60, active: true, poly: [] };
    ui.mapMode = 'draw'; renderAdmin();
  },
  'zone-edit': el => { ui.zoneEdit = clone(S.zones.find(z => z.id === el.dataset.id)); ui.mapMode = 'draw'; renderAdmin(); adminMap.fitBounds(L.latLngBounds(ui.zoneEdit.poly), { padding: [60, 60] }); },
  'zone-undo': () => { ui.zoneEdit.poly.pop(); redrawAdminMap(); updateDrawStatus(); },
  'zone-clear': () => { ui.zoneEdit.poly = []; redrawAdminMap(); updateDrawStatus(); },
  'zone-cancel': () => { ui.zoneEdit = null; ui.mapMode = 'test'; renderAdmin(); },
  'zone-save': async () => {
    const z = ui.zoneEdit;
    if (!z.name.trim() && !(z.nameAr || '').trim()) { toast(t('nameZone')); $('#zName')?.focus(); return; }
    if (z.poly.length < 3) { toast(t('need3')); return; }
    const ok = await write(() => db.from('zones').upsert({
      id: z.id, code: z.code.trim(), name: z.name.trim() || z.nameAr.trim(), name_ar: (z.nameAr || '').trim() || null,
      color: z.color, fee: +z.fee || 0, min_order: +z.minOrder || 0, active: z.active !== false, poly: z.poly,
    }));
    if (ok) { ui.zoneEdit = null; ui.mapMode = 'test'; renderAdmin(); }
  },
  'zone-del': async el => {
    const id = el.dataset.id;
    if (ui.armed !== 'z' + id) { ui.armed = 'z' + id; renderAdminBody(); return; }
    ui.armed = null;
    await write(() => db.from('zones').delete().eq('id', id));
  },

  'store-new': () => {
    ui.storeEdit = { id: uid('s'), name: '', nameAr: '', lat: null, lng: null, coverage: [], open: '08:00', close: '24:00', prep: 12, active: true };
    ui.mapMode = 'place'; renderAdmin();
  },
  'store-edit': el => { ui.storeEdit = clone(S.stores.find(s => s.id === el.dataset.id)); ui.mapMode = 'test'; renderAdmin(); },
  'store-focus': el => { ui.focus = { type: 'store', id: el.dataset.id }; const s = S.stores.find(x => x.id === el.dataset.id); renderAdminBody(); redrawAdminMap(); adminMap.panTo([s.lat, s.lng]); },
  'store-pick': () => { ui.mapMode = ui.mapMode === 'place' ? 'test' : 'place'; renderAdminBody(); redrawAdminMap(); },
  'cov': el => {
    const s = ui.storeEdit, zid = el.dataset.zone, role = el.dataset.role;
    s.coverage = s.coverage.filter(c => c.zone !== zid);
    if (role !== 'none') s.coverage.push({ zone: zid, role });
    renderAdminBody(); redrawAdminMap();
  },
  'store-cancel': () => { ui.storeEdit = null; ui.mapMode = 'test'; renderAdmin(); },
  'store-save': async () => {
    const s = ui.storeEdit;
    if (!s.name.trim() && !(s.nameAr || '').trim()) { toast(t('nameStore')); $('#sName')?.focus(); return; }
    if (s.lat == null) { toast(t('pickStoreLoc')); return; }
    const isNew = !S.stores.some(x => x.id === s.id);
    const ok = await write(async () => {
      const r1 = await db.from('stores').upsert({
        id: s.id, name: s.name.trim() || s.nameAr.trim(), name_ar: (s.nameAr || '').trim() || null, lat: s.lat, lng: s.lng,
        open_time: s.open, close_time: s.close === '23:59' ? '24:00' : s.close, prep_minutes: Math.round(+s.prep) || 12, active: !!s.active,
      });
      if (r1.error) return r1;
      const r2 = await db.from('store_coverage').delete().eq('store_id', s.id);
      if (r2.error) return r2;
      const r3 = s.coverage.length ? await db.from('store_coverage').insert(s.coverage.map(c => ({ store_id: s.id, zone_id: c.zone, role: c.role }))) : {};
      if (r3.error || !isNew) return r3;
      return db.from('inventory').insert(S.products.map(p => ({ store_id: s.id, product_id: p.id, qty: 20 })));
    });
    if (ok) { ui.storeEdit = null; ui.mapMode = 'test'; renderAdmin(); }
  },
  'store-del': async el => {
    const id = el.dataset.id;
    if (ui.armed !== 's' + id) { ui.armed = 's' + id; renderAdminBody(); return; }
    ui.armed = null; ui.focus = null;
    await write(() => db.from('stores').delete().eq('id', id));
  },
  'prod-del': async el => {
    const id = el.dataset.id;
    if (ui.armed !== 'p' + id) { ui.armed = 'p' + id; renderAdminBody(); return; }
    ui.armed = null;
    delete LS.cart[id]; saveLocal();
    await write(() => db.from('products').delete().eq('id', id));
  },
  'order-advance': async el => {
    const next = +el.dataset.status + 1;
    await write(() => db.from('orders').update({ status: next }).eq('id', el.dataset.id));
  },
  'event-status': async el => {
    await write(() => db.from('event_requests').update({ status: el.dataset.status }).eq('id', el.dataset.id));
  },
};

document.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el) { if (ui.armed) { ui.armed = null; if (ui.route === 'admin') renderAdminBody(); } return; }
  const a = el.dataset.action;
  if (a === 'store-focus' && e.target.closest('button')) return;
  if (!/^(zone-del|store-del|prod-del)$/.test(a) && ui.armed) ui.armed = null;
  if (actions[a]) { e.preventDefault(); actions[a](el); }
});

document.addEventListener('input', e => {
  const el = e.target;
  if (el.id === 'search') { ui.q = el.value; if (ui.route !== 'shop') location.hash = '#shop'; else renderShop(); return; }
  const val = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;
  if (el.dataset.zf && ui.zoneEdit) { ui.zoneEdit[el.dataset.zf] = val; if (el.dataset.zf === 'color') redrawAdminMap(); }
  if (el.dataset.sf && ui.storeEdit) ui.storeEdit[el.dataset.sf] = val;
});

// Inline edits in the products table save without re-rendering, so focus stays put.
document.addEventListener('change', e => {
  const el = e.target;
  if (el.id === 'evPkg') { ui.eventPkg = el.value; }
  if (el.dataset.stock) {
    const [sid, pid] = el.dataset.stock.split('|');
    const blank = el.value === '';
    const qty = Math.max(0, Math.round(+el.value));
    write(() => blank
      ? db.from('inventory').delete().eq('store_id', sid).eq('product_id', pid)
      : db.from('inventory').upsert({ store_id: sid, product_id: pid, qty }), { reload: false })
      .then(ok => {
        if (!ok) return;
        S.inventory[sid] = S.inventory[sid] || {};
        if (blank) delete S.inventory[sid][pid]; else S.inventory[sid][pid] = qty;
        el.classList.toggle('zero', !blank && qty === 0);
        el.classList.toggle('na', blank);
      });
  }
  if (el.dataset.price && +el.value >= 0) {
    const id = el.dataset.price, price = +el.value;
    write(() => db.from('products').update({ price }).eq('id', id), { reload: false })
      .then(ok => { if (ok) S.products.find(p => p.id === id).price = price; });
  }
  if (el.dataset.listed) {
    const id = el.dataset.listed, listed = el.checked;
    write(() => db.from('products').update({ listed }).eq('id', id), { reload: false })
      .then(ok => { if (ok) S.products.find(p => p.id === id).listed = listed; });
  }
});

document.addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  if (f.id === 'checkoutForm') placeOrder(f);
  if (f.id === 'eventForm') sendEventRequest(f);
  if (f.id === 'loginForm') {
    const { email, password } = Object.fromEntries(new FormData(f));
    const { error } = await db.auth.signInWithPassword({ email: email.trim(), password });
    ui.authMsg = error ? t('authFail', { m: error.message }) : '';
    if (error) renderAdminBody();
  }
  if (f.id === 'newProduct') {
    const d = Object.fromEntries(new FormData(f));
    const id = uid('p');
    const ok = await write(async () => {
      const r1 = await db.from('products').insert({
        id, category: d.category, name: d.name.trim() || d.nameAr.trim(), name_ar: d.nameAr.trim() || null,
        unit: d.unit.trim() || null, unit_ar: d.unitAr.trim() || null, price: +d.price, sort: S.products.length,
      });
      if (r1.error) return r1;
      return db.from('inventory').insert(S.stores.map(s => ({ store_id: s.id, product_id: id, qty: Math.max(0, Math.round(+d.stock || 0)) })));
    });
    if (ok) toast(t('productAdded', { p: d.nameAr && lang === 'ar' ? d.nameAr : d.name }));
  }
});

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (!$('#locModal').hidden) closeLoc();
  else if (ui.cartOpen) actions['close-cart']();
  else if (ui.zoneEdit) actions['zone-cancel']();
});

window.addEventListener('hashchange', route);

db.auth.onAuthStateChange((event, session) => {
  // Defer: Supabase recommends not awaiting other Supabase calls inside this callback.
  setTimeout(async () => {
    const wasAdmin = ui.isAdmin;
    await checkAdmin(session);
    if (ui.isAdmin !== wasAdmin) { await refreshAll(); } else if (ui.route === 'admin') renderAdmin();
  }, 0);
});

/* ---------------- boot ---------------- */
applyStatic();
renderBrand();
route();
refreshAll().then(() => {
  // Auto-detect on first visit; if that fails, let the customer choose on the map.
  if (!LS.customer && ui.ready) {
    detectLocation(loc => {
      if (loc) setCustomer(loc);
      else if (ui.route === 'shop') openLoc();
    });
  }
});
