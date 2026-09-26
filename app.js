'use strict';

/* =====================================================================
   WIns Delivery
   Customer location -> zone (point in polygon) -> covering store -> catalog
   Bilingual: English / Arabic (RTL). Strings live in i18n.js.
   ===================================================================== */

const BRAND = { name: 'WIns', logoUrl: 'assets/wins-logo.png' };
const KEY = 'wins.delivery.v2'; // v2: Riyadh demo data, SAR
const LANG_KEY = 'wins.lang';
const MAP_CENTER = [24.77, 46.66];

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
const catLabel = c => t('cat_' + c);

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg; el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), 2600);
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

/* ---------------- catalog visuals ---------------- */
const CAT = {
  Fresh:       { hue: '#2E9E5B', icon: '<path d="M5 19c0-8 6-14 14-14 0 8-6 14-14 14Z"/><path d="M5 19l8-8"/>' },
  Pantry:      { hue: '#C07A1A', icon: '<rect x="6" y="8" width="12" height="12" rx="2"/><path d="M8 4h8v4H8z"/><path d="M9 13h6"/>' },
  Beverages:   { hue: '#2F6FB0', icon: '<path d="M7 4h10l-1.5 16h-7Z"/><path d="M7.5 9h9"/>' },
  Electronics: { hue: '#5B4BB7', icon: '<path d="M13 3 5 14h6l-1 7 8-11h-6Z"/>' },
  Home:        { hue: '#8A5A44', icon: '<path d="M4 11 12 4l8 7"/><path d="M6 10v10h12V10"/><path d="M10 20v-5h4v5"/>' },
  Beauty:      { hue: '#B8457A', icon: '<path d="M12 3c3 5 6 8 6 11a6 6 0 0 1-12 0c0-3 3-6 6-11Z"/>' },
};
const catIcon = c => `<svg viewBox="0 0 24 24" aria-hidden="true">${(CAT[c] || CAT.Pantry).icon}</svg>`;
const tileStyle = c => { const h = (CAT[c] || CAT.Pantry).hue; return `background:color-mix(in srgb, ${h} 15%, var(--surface));color:${h}`; };

/* ---------------- demo data (Riyadh) ---------------- */
function seed() {
  const Z = (id, code, name, nameAr, color, fee, minOrder, poly) => ({ id, code, name, nameAr, color, fee, minOrder, active: true, poly });
  const zones = [
    Z('z_oly', 'OLY-01', 'Al Olaya', 'العليا', '#0A7A55', 9, 50, [[24.7150, 46.6700], [24.7120, 46.6990], [24.6900, 46.7020], [24.6750, 46.6950], [24.6780, 46.6700], [24.6980, 46.6660]]),
    Z('z_sul', 'SUL-02', 'Al Sulimaniyah', 'السليمانية', '#2F6FB0', 9, 50, [[24.7200, 46.7020], [24.7180, 46.7250], [24.6950, 46.7280], [24.6900, 46.7040]]),
    Z('z_nak', 'NAK-03', 'Al Nakheel', 'النخيل', '#B8457A', 12, 60, [[24.7650, 46.6250], [24.7620, 46.6600], [24.7350, 46.6620], [24.7300, 46.6300], [24.7480, 46.6180]]),
    Z('z_mlq', 'MLQ-04', 'Al Malqa', 'الملقا', '#C07A1A', 12, 60, [[24.8300, 46.5900], [24.8280, 46.6340], [24.7980, 46.6350], [24.7950, 46.5950]]),
    Z('z_ysm', 'YSM-05', 'Al Yasmin', 'الياسمين', '#5B4BB7', 12, 60, [[24.8500, 46.6360], [24.8480, 46.6700], [24.8200, 46.6720], [24.8150, 46.6380]]),
    Z('z_nrj', 'NRJ-06', 'Al Narjis', 'النرجس', '#1F8A8A', 15, 75, [[24.8900, 46.6500], [24.8880, 46.7000], [24.8580, 46.7020], [24.8550, 46.6550]]),
    Z('z_rwd', 'RWD-07', 'Al Rawdah', 'الروضة', '#8A5A44', 12, 60, [[24.7500, 46.7500], [24.7480, 46.7900], [24.7220, 46.7920], [24.7200, 46.7520]]),
    Z('z_dir', 'DIR-08', 'Diriyah', 'الدرعية', '#A33A3A', 15, 75, [[24.7600, 46.5550], [24.7580, 46.5950], [24.7280, 46.5970], [24.7250, 46.5580]]),
  ];
  const cov = list => list.map(([zone, role]) => ({ zone, role }));
  const St = (id, name, nameAr, lat, lng, coverage, open, close, prep) => ({ id, name, nameAr, lat, lng, coverage: cov(coverage), open, close, prep, active: true });
  const stores = [
    St('s_oly', 'WIns Olaya Hub', 'WIns العليا', 24.6950, 46.6850, [['z_oly', 'primary'], ['z_sul', 'primary'], ['z_nak', 'backup']], '00:00', '24:00', 12),
    St('s_nak', 'WIns Al Nakheel', 'WIns النخيل', 24.7470, 46.6400, [['z_nak', 'primary'], ['z_oly', 'backup'], ['z_dir', 'backup']], '08:00', '02:00', 10),
    St('s_mlq', 'WIns Al Malqa', 'WIns الملقا', 24.8120, 46.6120, [['z_mlq', 'primary'], ['z_ysm', 'backup']], '07:00', '01:00', 12),
    St('s_ysm', 'WIns Al Yasmin', 'WIns الياسمين', 24.8320, 46.6520, [['z_ysm', 'primary'], ['z_nrj', 'backup'], ['z_mlq', 'backup']], '00:00', '24:00', 14),
    St('s_nrj', 'WIns Al Narjis', 'WIns النرجس', 24.8720, 46.6750, [['z_nrj', 'primary']], '08:00', '24:00', 11),
    St('s_rwd', 'WIns Al Rawdah', 'WIns الروضة', 24.7350, 46.7700, [['z_rwd', 'primary']], '08:00', '24:00', 13),
    St('s_dir', 'WIns Diriyah', 'WIns الدرعية', 24.7420, 46.5750, [['z_dir', 'primary']], '09:00', '22:00', 15),
  ];
  const P = (id, name, nameAr, category, price, unit, unitAr, was) => ({ id, name, nameAr, category, price, unit, unitAr, was: was || null, listed: true });
  const products = [
    P('p01', 'Tomatoes', 'طماطم', 'Fresh', 6.5, '1 kg', '1 كجم'),
    P('p02', 'Bananas', 'موز', 'Fresh', 7, '1 kg', '1 كجم'),
    P('p03', 'Fresh Full Fat Milk', 'حليب طازج كامل الدسم', 'Fresh', 6.5, '1 L', '1 لتر'),
    P('p04', 'Fresh Eggs', 'بيض طازج', 'Fresh', 23, '30 pcs', '30 حبة', 26),
    P('p05', 'Chicken Breast Fillet', 'صدور دجاج فيليه', 'Fresh', 32, '1 kg', '1 كجم'),
    P('p06', 'Basmati Rice', 'أرز بسمتي', 'Pantry', 45, '5 kg', '5 كجم'),
    P('p07', 'Durum Wheat Pasta', 'مكرونة قمح صلب', 'Pantry', 4.5, '400 g', '400 جم'),
    P('p08', 'Sunflower Oil', 'زيت دوار الشمس', 'Pantry', 22, '1.8 L', '1.8 لتر', 25),
    P('p09', 'Sukkari Dates', 'تمر سكري', 'Pantry', 35, '1 kg', '1 كجم'),
    P('p10', 'Sidr Honey', 'عسل سدر', 'Pantry', 95, '500 g', '500 جم'),
    P('p11', 'Drinking Water', 'مياه شرب', 'Beverages', 9, '6 × 1.5 L', '6 × 1.5 لتر'),
    P('p12', 'Orange Juice', 'عصير برتقال', 'Beverages', 9.5, '1 L', '1 لتر'),
    P('p13', 'Arabic Coffee with Cardamom', 'قهوة عربية بالهيل', 'Beverages', 38, '250 g', '250 جم'),
    P('p14', 'Black Tea', 'شاي أسود', 'Beverages', 18, '100 bags', '100 كيس'),
    P('p15', 'Wireless Earbuds', 'سماعات لاسلكية', 'Electronics', 199, '1 pair', 'زوج', 249),
    P('p16', 'Power Bank 20,000 mAh', 'باور بانك 20,000 مللي أمبير', 'Electronics', 129, '1 pc', 'حبة'),
    P('p17', 'USB-C Fast Charger 35W', 'شاحن سريع USB-C بقدرة 35 واط', 'Electronics', 69, '1 pc', 'حبة'),
    P('p18', 'Smart LED Bulb', 'لمبة LED ذكية', 'Electronics', 49, 'E27, 9W', 'E27، 9 واط'),
    P('p19', 'Dishwashing Liquid', 'سائل غسيل الصحون', 'Home', 11, '1 L', '1 لتر'),
    P('p20', 'Laundry Detergent', 'مسحوق غسيل', 'Home', 39, '3 kg', '3 كجم', 45),
    P('p21', 'Kitchen Paper Towels', 'مناديل مطبخ', 'Home', 17, '6 rolls', '6 لفات'),
    P('p22', 'Argan Oil Shampoo', 'شامبو بزيت الأرجان', 'Beauty', 21, '400 ml', '400 مل'),
    P('p23', 'Sunscreen SPF 50', 'واقي شمس SPF 50', 'Beauty', 65, '50 ml', '50 مل'),
    P('p24', 'Whitening Toothpaste', 'معجون أسنان للتبييض', 'Beauty', 14, '2 × 100 ml', '2 × 100 مل'),
  ];
  const inventory = {};
  const bigStores = ['s_oly', 's_ysm', 's_rwd'];
  stores.forEach((s, i) => {
    inventory[s.id] = {};
    products.forEach((p, j) => {
      if (p.category === 'Electronics' && !bigStores.includes(s.id)) return; // not carried
      const q = (i * 37 + j * 11 + 7) % 43;
      inventory[s.id][p.id] = q < 3 ? 0 : q;
    });
  });
  return { zones, stores, products, inventory, orders: [], cart: {}, customer: null, seq: 1040 };
}

// Older saved data has no Arabic fields: copy them in from the demo data by id.
function migrate(d) {
  const s = seed();
  const fill = (arr, src) => arr.forEach(x => {
    const o = src.find(y => y.id === x.id); if (!o) return;
    ['nameAr', 'unitAr'].forEach(k => { if (x[k] == null && o[k] != null) x[k] = o[k]; });
  });
  fill(d.zones, s.zones); fill(d.stores, s.stores); fill(d.products, s.products);
  return d;
}
function load() {
  try { const raw = localStorage.getItem(KEY); if (raw) return migrate(JSON.parse(raw)); } catch (e) { /* storage blocked */ }
  return seed();
}
function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { /* storage blocked */ } }

let S = load();
const ui = {
  route: 'shop', cat: 'All', q: '', whyOpen: false,
  cartOpen: false, checkout: false,
  adminTab: 'overview', mapMode: 'test', testLoc: null,
  zoneEdit: null, storeEdit: null, armed: null, focus: null,
  pendingLoc: null,
};

/* ---------------- store selection engine ---------------- */
const toMin = v => { const [h, m] = String(v).split(':').map(Number); return h * 60 + (m || 0); };
function isOpen(store, d = new Date()) {
  const o = toMin(store.open), c = toMin(store.close), now = d.getHours() * 60 + d.getMinutes();
  if (c - o >= 1440 || o === c) return true;
  return c > o ? now >= o && now < c : now >= o || now < c; // overnight hours like 08:00 → 02:00
}
const hours = s => ltr(`${s.open}–${s.close}`);
const roleRank = r => (r === 'primary' ? 0 : 1);

/**
 * Resolve which zone(s) a point is in and which store should serve it.
 * Ranking: available stores first → primary coverage before backup → nearest.
 */
function resolve(loc) {
  if (!loc) return null;
  const zones = S.zones
    .filter(z => z.active !== false && z.poly.length >= 3 && pointInPolygon(loc.lat, loc.lng, z.poly))
    .sort((a, b) => areaKm2(a.poly) - areaKm2(b.poly)); // smallest (most specific) zone first
  const candidates = [];
  for (const st of S.stores) {
    const covs = st.coverage.filter(c => zones.some(z => z.id === c.zone)).sort((a, b) => roleRank(a.role) - roleRank(b.role));
    if (!covs.length) continue;
    const best = covs[0];
    const zone = zones.find(z => z.id === best.zone);
    const reasons = []; // HTML-safe strings
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
  const ride = Math.round(c.dist * 3.2 + 4);
  const lo = c.store.prep + ride;
  return [lo, lo + 10];
}
const etaStr = ([lo, hi]) => t('minutes', { r: ltr(`${lo}–${hi}`) });
const current = () => resolve(S.customer);
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
  if (c.kind === 'pin') return t('pinned');
  return c.label || t('pinned');
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
  const el = $('#brand');
  el.innerHTML = BRAND.logoUrl
    ? `<img class="brand-img" src="${esc(BRAND.logoUrl)}" alt="${esc(BRAND.name)}">`
    : `<span class="brand-word">${esc(BRAND.name)}</span>`;
}

/* ---------------- header ---------------- */
function renderHeader() {
  const res = current();
  let label = t('setLocation');
  if (S.customer) {
    const z = res?.zones[0], l = placeName(S.customer);
    label = z ? (l === nm(z) ? nm(z) : `${nm(z)} · ${l}`) : t('outsideSuffix', { l });
  }
  $('#locLabel').textContent = label;
  $('#cartCount').textContent = Object.values(S.cart).reduce((a, b) => a + b, 0);
  $$('.nav a').forEach(a => a.classList.toggle('active', a.dataset.route === ui.route));
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
  if (!S.customer) {
    return `<div class="empty">
      <span class="eyebrow">${t('step1')}</span>
      <h1>${t('tellUs')}</h1>
      <p>${t('tellUsP')}</p>
      <div class="row"><button class="btn btn-brand" data-action="use-gps-direct">${t('detect')}</button><button class="btn" data-action="open-loc">${t('chooseMap')}</button></div>
    </div>`;
  }
  if (!res.zones.length) {
    const n = res.nearest;
    return `<div class="empty">
      <span class="eyebrow">${t('outside')}</span>
      <h1>${t('noDeliverH')}</h1>
      <p>${t('noDeliverP', { c: `<span class="mono">${coords(S.customer)}</span>` })}
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

const priceHtml = (p) => {
  const cur = `<small>${t('currency')}</small>`;
  const num = fmt(p.price);
  const was = p.was ? ` <s class="muted small">${fmt(p.was)}</s>` : '';
  return `<span class="price">${lang === 'ar' ? num + ' ' + cur : cur + num}${was}</span>`;
};

function productCard(p, storeId) {
  const stock = stockOf(storeId, p.id) || 0;
  const qty = S.cart[p.id] || 0;
  const out = stock <= 0;
  const badge = out ? `<span class="badge badge-muted">${t('outOfStock')}</span>`
    : p.was ? `<span class="badge">${ltr('−' + Math.round((1 - p.price / p.was) * 100) + '%')}</span>`
    : stock <= 5 ? `<span class="badge badge-muted">${t('onlyLeft', { n: stock })}</span>` : '';
  const ctrl = out ? `<button class="add-btn" disabled>${t('soldOut')}</button>`
    : qty ? `<div class="stepper"><button data-action="dec" data-id="${p.id}" aria-label="${t('removeOne')}">−</button><span>${qty}</span><button data-action="inc" data-id="${p.id}" aria-label="${t('addOne')}">+</button></div>`
    : `<button class="add-btn" data-action="inc" data-id="${p.id}">${t('add')}</button>`;
  return `<article class="card ${out ? 'is-out' : ''}">
    <div class="tile" style="${tileStyle(p.category)}">${badge}${catIcon(p.category)}</div>
    <div class="card-body"><span class="name">${esc(nm(p))}</span><span class="unit">${esc(nm(p, 'unit'))}</span></div>
    <div class="card-foot">${priceHtml(p)}${ctrl}</div>
  </article>`;
}

function renderShop() {
  const res = current();
  const el = $('#view-shop');
  let html = dispatchBanner(res);
  const store = res?.pick?.store;
  if (store) {
    const q = ui.q.trim().toLowerCase();
    const carried = S.products.filter(p => p.listed !== false && stockOf(store.id, p.id) !== undefined);
    const cats = ['All', ...Object.keys(CAT).filter(c => carried.some(p => p.category === c))];
    if (!cats.includes(ui.cat)) ui.cat = 'All';
    const hay = p => [p.name, p.nameAr, p.category, I18N.ar['cat_' + p.category]].join(' ').toLowerCase();
    const list = carried.filter(p => (ui.cat === 'All' || p.category === ui.cat) && (!q || hay(p).includes(q)));
    list.sort((a, b) => ((stockOf(store.id, b.id) > 0) - (stockOf(store.id, a.id) > 0)));
    html += `<div class="catalog-head">
      <div><span class="eyebrow">${t('inStockAt', { s: esc(nm(store)) })}</span><h2>${ui.cat === 'All' ? t('everything') : catLabel(ui.cat)}${q ? ` ${t('matching', { q: esc(ui.q) })}` : ''}</h2></div>
    </div>
    <div class="chips" role="tablist">${cats.map(c => `<button class="chip ${c === ui.cat ? 'active' : ''}" data-action="cat" data-cat="${c}">${c === 'All' ? '' : catIcon(c)}${c === 'All' ? t('all') : catLabel(c)}<span class="count">${c === 'All' ? carried.length : carried.filter(p => p.category === c).length}</span></button>`).join('')}</div>
    <div style="height:14px"></div>
    ${list.length ? `<div class="grid-products">${list.map(p => productCard(p, store.id)).join('')}</div>`
      : `<div class="empty"><h3>${t('noProducts')}</h3><p>${t('noProductsP')}</p></div>`}`;
  }
  el.innerHTML = html;
}

/* ---------------- cart ---------------- */
function cartLines(storeId) {
  return Object.entries(S.cart).map(([pid, qty]) => {
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
  return { lines, ok, sub, fee, total: sub + fee, zone, store, min: zone?.minOrder || 0 };
}

function renderCart() {
  const d = $('#drawer');
  if (!ui.cartOpen) { d.hidden = true; $('#scrim').hidden = true; return; }
  d.hidden = false; $('#scrim').hidden = false;
  const res = current();
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

  const last = S.lastCustomer || {};
  d.innerHTML = head + `<form class="drawer-body" id="checkoutForm" autocomplete="on">
      ${from}
      <div class="notice" style="background:var(--brand-soft)">${t('arrivesIn', { e: etaStr(eta(res.pick)) })}</div>
      <label class="field"><span>${t('fullName')}</span><input id="coName" name="name" required value="${esc(last.name || '')}"></label>
      <label class="field"><span>${t('mobile')}</span><input id="coPhone" name="phone" type="tel" dir="ltr" required placeholder="05x xxx xxxx" value="${esc(last.phone || '')}"></label>
      <div class="grid-3">
        <label class="field"><span>${t('building')}</span><input id="coBldg" name="building" required value="${esc(last.building || '')}"></label>
        <label class="field"><span>${t('floor')}</span><input id="coFloor" name="floor" value="${esc(last.floor || '')}"></label>
        <label class="field"><span>${t('apt')}</span><input id="coApt" name="apt" value="${esc(last.apt || '')}"></label>
      </div>
      <label class="field"><span>${t('street')}</span><input id="coStreet" name="street" required value="${esc(last.street || '')}"></label>
      <label class="field"><span>${t('note')}</span><textarea id="coNote" name="note"></textarea></label>
      <div class="field"><span>${t('payment')}</span>
        <label class="pay-opt"><input type="radio" name="pay" value="cash" checked> ${t('cod')}</label>
        <label class="pay-opt"><input type="radio" name="pay" value="card-on-delivery"> ${t('cardPos')}</label>
      </div>
      ${totals}
    </form>
    <div class="drawer-foot">
      <button class="btn btn-brand btn-block" type="submit" form="checkoutForm">${t('placeOrder', { t: money(tt.total) })}</button>
      <button class="btn btn-ghost btn-block" data-action="back-cart">${t('backCart')}</button>
    </div>`;
}

function placeOrder(form) {
  const res = current();
  const tt = cartTotals(res);
  if (!tt.store || !tt.ok.length || tt.sub < tt.min) { toast(t('cantOrder')); return; }
  const f = Object.fromEntries(new FormData(form));
  S.lastCustomer = { name: f.name, phone: f.phone, building: f.building, floor: f.floor, apt: f.apt, street: f.street };
  const order = {
    id: 'WN-' + (++S.seq), at: Date.now(), status: 0,
    storeId: tt.store.id, storeName: tt.store.name, storeNameAr: tt.store.nameAr,
    zoneId: tt.zone.id, zoneCode: tt.zone.code, zoneName: tt.zone.name, zoneNameAr: tt.zone.nameAr,
    loc: { ...S.customer }, customer: f, pay: f.pay,
    items: tt.ok.map(l => ({ pid: l.p.id, name: l.p.name, nameAr: l.p.nameAr, unit: l.p.unit, unitAr: l.p.unitAr, category: l.p.category, price: l.p.price, qty: l.qty })),
    sub: tt.sub, fee: tt.fee, total: tt.total, eta: eta(res.pick),
  };
  order.items.forEach(i => { S.inventory[tt.store.id][i.pid] = Math.max(0, (S.inventory[tt.store.id][i.pid] || 0) - i.qty); });
  S.orders.unshift(order);
  S.cart = {};
  ui.checkout = false; ui.cartOpen = false;
  save();
  toast(t('orderPlaced', { id: order.id, s: nm(order, 'storeName') }));
  location.hash = '#orders';
  renderAll();
}

/* ---------------- orders ---------------- */
function orderCard(o, admin = false) {
  const when = new Date(o.at);
  const date = when.toLocaleDateString(lang === 'ar' ? 'ar-SA-u-ca-gregory-nu-latn' : 'en-GB', { day: 'numeric', month: 'short' });
  const count = o.items.reduce((s, i) => s + i.qty, 0);
  return `<article class="order">
    <div class="order-head">
      <div><span class="eyebrow">${date} · ${ltr(`${pad(when.getHours())}:${pad(when.getMinutes())}`)}</span>
        <h3 class="mono" style="font-size:15px">${esc(o.id)}</h3>
        <div class="muted small">${esc(nm(o, 'storeName'))} ${lang === 'ar' ? '←' : '→'} ${esc(nm(o, 'zoneName'))} <span class="mono">(${esc(o.zoneCode)})</span>${admin ? ` · ${esc(o.customer.name)} · <span class="mono">${esc(o.customer.phone)}</span>` : ''}</div>
      </div>
      <div class="order-total"><div class="price">${money(o.total)}</div><div class="muted small">${t('itemsCount', { n: count })} · ${o.pay === 'cash' ? t('cashOD') : t('cardOD')}</div></div>
    </div>
    <div class="track">${[0, 1, 2, 3].map(i => `<div class="${i < o.status || o.status === 3 ? 'done' : i === o.status ? 'done now' : ''}">${t('status' + i)}</div>`).join('')}</div>
    <div class="muted small">${o.items.map(i => `${i.qty}× ${esc(nm(i))}`).join(' · ')}</div>
    ${admin && o.status < 3 ? `<div><button class="btn btn-sm btn-brand" data-action="order-advance" data-id="${o.id}">${t('markAs', { s: t('status' + (o.status + 1)) })}</button></div>` : ''}
  </article>`;
}
function renderOrders() {
  $('#view-orders').innerHTML = `<div class="stack" style="max-width:860px">
    <div><span class="eyebrow">${t('yourOrders')}</span><h1>${t('trackH')}</h1></div>
    ${S.orders.length ? `<div class="orders">${S.orders.map(o => orderCard(o)).join('')}</div>`
      : `<div class="empty"><h3>${t('noOrders')}</h3><p>${t('noOrdersP')}</p><a class="btn btn-brand" href="#shop">${t('startShopping')}</a></div>`}
  </div>`;
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

/* ---------- location picker ---------- */
let locMap, locLayers;
function renderSamples() {
  $('#samples').innerHTML = SAMPLES.map((s, i) => `<button class="chip" data-action="sample" data-i="${i}">${esc(s[lang === 'ar' ? 1 : 0])}</button>`).join('');
}
function openLoc() {
  $('#locModal').hidden = false;
  ui.pendingLoc = S.customer ? { ...S.customer } : null;
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
function fitAll(map) {
  const pts = S.zones.flatMap(z => z.poly);
  if (pts.length) map.fitBounds(L.latLngBounds(pts), { padding: [20, 20] });
}

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
  S.customer = loc; save();
  const after = current();
  if (after?.pick && before && after.pick.store.id !== before) toast(t('toastSwitched', { s: nm(after.pick.store) }));
  else if (after?.pick) toast(t('toastFrom', { s: nm(after.pick.store) }));
  renderAll();
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

  // lines from a store to the zones it covers (dashed = backup)
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
  const tabs = [['overview'], ['zones', S.zones.length], ['stores', S.stores.length], ['products', S.products.length], ['orders', S.orders.length]];
  $('#adminTabs').innerHTML = tabs.map(([id, n]) => `<button class="tab ${ui.adminTab === id ? 'active' : ''}" data-action="admin-tab" data-tab="${id}" role="tab">${t('tab_' + id)}${n != null ? `<span class="count">${n}</span>` : ''}</button>`).join('');
  const wide = ui.adminTab === 'products' || ui.adminTab === 'orders';
  $('#adminShell').classList.toggle('wide', wide);
  renderAdminBody();
  if (!wide) { ensureAdminMap(); redrawAdminMap(); }
}

function renderAdminBody() {
  const fn = { overview: adminOverview, zones: adminZones, stores: adminStores, products: adminProducts, orders: adminOrders }[ui.adminTab];
  $('#adminBody').innerHTML = fn();
  if (ui.adminTab === 'zones' && ui.zoneEdit) updateDrawStatus();
}

function adminOverview() {
  const today = new Date().toDateString();
  const todays = S.orders.filter(o => new Date(o.at).toDateString() === today);
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
  return `<div><span class="eyebrow">${t('operations')}</span><h2>${t('networkOverview')}</h2></div>
    <div class="kpis">
      <div class="kpi"><b>${S.zones.length}</b><span>${t('kpiZones', { n: covered })}</span></div>
      <div class="kpi"><b>${ltr(`${openNow}/${S.stores.length}`)}</b><span>${t('kpiOpen')}</span></div>
      <div class="kpi"><b>${todays.length}</b><span>${t('kpiOrders')}</span></div>
      <div class="kpi"><b class="num">${fmt(todays.reduce((s, o) => s + o.total, 0))}</b><span>${t('kpiRevenue', { c: t('currency') })}</span></div>
    </div>
    <div class="form-card"><div class="section-head"><h3>${t('tester')}</h3></div>${testHtml}</div>
    <div class="form-card">
      <h3>${t('howChosen')}</h3>
      <ol class="small muted how">
        <li>${t('how1')}</li><li>${t('how2')}</li><li>${t('how3')}</li><li>${t('how4')}</li>
      </ol>
    </div>
    <div class="row"><button class="btn btn-sm btn-danger ${ui.armed === 'reset' ? 'armed' : ''}" data-action="reset-demo">${ui.armed === 'reset' ? t('resetConfirm') : t('resetDemo')}</button></div>`;
}

/* ----- zones ----- */
function adminZones() {
  if (ui.zoneEdit) {
    const z = ui.zoneEdit;
    return `<div class="section-head"><h2>${S.zones.some(x => x.id === z.id) ? t('editZone') : t('newZone')}</h2></div>
      <div class="form-card">
        <div class="draw-status" id="drawStatus"></div>
        <div class="grid-2">
          <label class="field"><span>${t('nameEn')}</span><input id="zName" dir="ltr" data-zf="name" value="${esc(z.name)}" placeholder="Sheraton"></label>
          <label class="field"><span>${t('nameAr')}</span><input id="zNameAr" dir="rtl" lang="ar" data-zf="nameAr" value="${esc(z.nameAr || '')}" placeholder="شيراتون"></label>
        </div>
        <div class="grid-2">
          <label class="field"><span>${t('code')}</span><input id="zCode" dir="ltr" data-zf="code" value="${esc(z.code)}" placeholder="SHR-09"></label>
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
          <label class="field"><span>${t('nameEn')}</span><input id="sName" dir="ltr" data-sf="name" value="${esc(s.name)}" placeholder="WIns Dokki"></label>
          <label class="field"><span>${t('nameAr')}</span><input id="sNameAr" dir="rtl" lang="ar" data-sf="nameAr" value="${esc(s.nameAr || '')}" placeholder="WIns الدقي"></label>
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
          <label class="field"><span>${t('prep')}</span><input id="sPrep" type="number" min="1" data-sf="prep" value="${s.prep}"></label>
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
        <label class="field"><span>${t('nameEn')}</span><input id="npName" name="name" dir="ltr" required placeholder="Greek Yogurt"></label>
        <label class="field"><span>${t('nameAr')}</span><input id="npNameAr" name="nameAr" dir="rtl" lang="ar" placeholder="زبادي يوناني"></label>
      </div>
      <div class="grid-3" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr))">
        <label class="field"><span>${t('category')}</span><select id="npCat" name="category">${Object.keys(CAT).map(c => `<option value="${c}">${catLabel(c)}</option>`).join('')}</select></label>
        <label class="field"><span>${t('priceC', { c: t('currency') })}</span><input id="npPrice" name="price" type="number" min="0" step="0.5" required></label>
        <label class="field"><span>${t('unit')}</span><input id="npUnit" name="unit" dir="ltr" placeholder="500 g"></label>
        <label class="field"><span>${t('unitAr')}</span><input id="npUnitAr" name="unitAr" dir="rtl" lang="ar" placeholder="500 جم"></label>
      </div>
      <div class="row"><label class="field" style="flex:1"><span>${t('startStock')}</span><input id="npStock" name="stock" type="number" min="0" value="20"></label><button class="btn btn-brand" type="submit" style="align-self:end">${t('addProductBtn')}</button></div>
    </form>
    <p class="small muted">${t('stockNote')}</p>
    <div class="table-wrap"><table>
      <thead><tr><th>${t('product')}</th><th>${t('listed')}</th><th class="n">${t('price')}</th>${S.stores.map(s => `<th class="n" title="${esc(nm(s))}">${esc(shortStore(s))}</th>`).join('')}<th></th></tr></thead>
      <tbody>${S.products.map(p => `<tr>
        <td><div class="prod-cell"><span class="mini" style="${tileStyle(p.category)}">${catIcon(p.category)}</span><div><b>${esc(nm(p))}</b><div class="small muted">${catLabel(p.category)} · ${esc(nm(p, 'unit'))}</div></div></div></td>
        <td><input type="checkbox" data-listed="${p.id}" ${p.listed !== false ? 'checked' : ''} aria-label="${t('listed')}"></td>
        <td class="n"><input class="stock-in" type="number" min="0" step="0.5" data-price="${p.id}" value="${p.price}" aria-label="${t('price')}"></td>
        ${S.stores.map(s => { const q = stockOf(s.id, p.id); return `<td class="n"><input class="stock-in ${q === 0 ? 'zero' : q === undefined ? 'na' : ''}" type="number" min="0" placeholder="—" data-stock="${s.id}|${p.id}" value="${q ?? ''}" aria-label="${esc(t('stockAt', { s: nm(s) }))}"></td>`; }).join('')}
        <td><button class="btn btn-sm btn-danger ${ui.armed === 'p' + p.id ? 'armed' : ''}" data-action="prod-del" data-id="${p.id}">${ui.armed === 'p' + p.id ? t('confirm') : t('del')}</button></td>
      </tr>`).join('')}</tbody>
    </table></div>`;
}

/* ----- orders ----- */
function adminOrders() {
  const active = S.orders.filter(o => o.status < 3);
  return `<div class="section-head"><div><span class="eyebrow">${t('dispatchEy')}</span><h2>${t('tab_orders')}</h2></div><span class="muted small">${t('inProgress', { n: active.length })}</span></div>
    ${S.orders.length ? `<div class="orders" style="max-width:none">${S.orders.map(o => orderCard(o, true)).join('')}</div>`
      : `<div class="empty"><h3>${t('noOrders')}</h3><p>${t('noOrdersAdminP')}</p></div>`}`;
}

/* ---------------- render ---------------- */
function renderAll() {
  renderHeader();
  $('#view-shop').hidden = ui.route !== 'shop';
  $('#view-orders').hidden = ui.route !== 'orders';
  $('#view-admin').hidden = ui.route !== 'admin';
  if (ui.route === 'shop') renderShop();
  if (ui.route === 'orders') renderOrders();
  if (ui.route === 'admin') renderAdmin();
  renderCart();
}
function route() {
  const r = location.hash.slice(1) || 'shop';
  ui.route = ['shop', 'orders', 'admin'].includes(r) ? r : 'shop';
  renderAll();
  window.scrollTo(0, 0);
}
function setLang(next) {
  lang = next;
  try { localStorage.setItem(LANG_KEY, lang); } catch (e) { /* storage blocked */ }
  applyStatic();
  renderAll();
  if (!$('#locModal').hidden) { renderSamples(); updateLocModal(false); }
  // Leaflet needs a size refresh after the page direction flips
  setTimeout(() => { locMap?.invalidateSize(); adminMap?.invalidateSize(); }, 30);
}

/* ---------------- events ---------------- */
function setQty(pid, delta) {
  const store = current()?.pick?.store;
  const next = (S.cart[pid] || 0) + delta;
  if (delta > 0 && store && next > (stockOf(store.id, pid) || 0)) { toast(t('maxStock')); return; }
  if (next <= 0) delete S.cart[pid]; else S.cart[pid] = next;
  save();
  if (delta > 0) { const b = $('#cartBtn'); b.classList.remove('bump'); void b.offsetWidth; b.classList.add('bump'); }
  renderHeader();
  if (ui.route === 'shop') renderShop();
  renderCart();
}

const actions = {
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

  'admin-tab': el => { ui.adminTab = el.dataset.tab; ui.zoneEdit = null; ui.storeEdit = null; ui.mapMode = 'test'; ui.focus = null; renderAdmin(); },
  'test-clear': () => { ui.testLoc = null; renderAdmin(); },
  'test-as-customer': () => { setCustomer({ ...ui.testLoc, kind: 'pin' }); location.hash = '#shop'; },
  'reset-demo': () => {
    if (ui.armed !== 'reset') { ui.armed = 'reset'; renderAdminBody(); return; }
    S = seed(); ui.armed = null; ui.testLoc = null; save(); toast(t('restored')); renderAll();
  },

  'zone-new': () => {
    ui.zoneEdit = { id: uid('z'), code: `ZN-${pad(S.zones.length + 1)}`, name: '', nameAr: '', color: '#CC9F50', fee: 20, minOrder: 120, active: true, poly: [] };
    ui.mapMode = 'draw'; renderAdmin();
  },
  'zone-edit': el => { ui.zoneEdit = clone(S.zones.find(z => z.id === el.dataset.id)); ui.mapMode = 'draw'; renderAdmin(); adminMap.fitBounds(L.latLngBounds(ui.zoneEdit.poly), { padding: [60, 60] }); },
  'zone-undo': () => { ui.zoneEdit.poly.pop(); redrawAdminMap(); updateDrawStatus(); },
  'zone-clear': () => { ui.zoneEdit.poly = []; redrawAdminMap(); updateDrawStatus(); },
  'zone-cancel': () => { ui.zoneEdit = null; ui.mapMode = 'test'; renderAdmin(); },
  'zone-save': () => {
    const z = ui.zoneEdit;
    if (!z.name.trim() && !(z.nameAr || '').trim()) { toast(t('nameZone')); $('#zName')?.focus(); return; }
    if (!z.name.trim()) z.name = z.nameAr;
    if (z.poly.length < 3) { toast(t('need3')); return; }
    const i = S.zones.findIndex(x => x.id === z.id);
    if (i >= 0) S.zones[i] = z; else S.zones.push(z);
    ui.zoneEdit = null; ui.mapMode = 'test'; save(); toast(t('zoneSaved', { z: nm(z) })); renderAll();
  },
  'zone-del': el => {
    const id = el.dataset.id;
    if (ui.armed !== 'z' + id) { ui.armed = 'z' + id; renderAdminBody(); return; }
    S.zones = S.zones.filter(z => z.id !== id);
    S.stores.forEach(s => (s.coverage = s.coverage.filter(c => c.zone !== id)));
    ui.armed = null; save(); toast(t('zoneDeleted')); renderAll();
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
  'store-save': () => {
    const s = ui.storeEdit;
    if (!s.name.trim() && !(s.nameAr || '').trim()) { toast(t('nameStore')); $('#sName')?.focus(); return; }
    if (!s.name.trim()) s.name = s.nameAr;
    if (s.lat == null) { toast(t('pickStoreLoc')); return; }
    if (s.close === '23:59') s.close = '24:00';
    const i = S.stores.findIndex(x => x.id === s.id);
    if (i >= 0) S.stores[i] = s;
    else {
      S.stores.push(s);
      S.inventory[s.id] = {};
      S.products.filter(p => p.category !== 'Electronics').forEach(p => (S.inventory[s.id][p.id] = 20));
    }
    ui.storeEdit = null; ui.mapMode = 'test'; save(); toast(t('saved', { s: nm(s) })); renderAll();
  },
  'store-del': el => {
    const id = el.dataset.id;
    if (ui.armed !== 's' + id) { ui.armed = 's' + id; renderAdminBody(); return; }
    S.stores = S.stores.filter(s => s.id !== id); delete S.inventory[id];
    ui.armed = null; ui.focus = null; save(); toast(t('storeDeleted')); renderAll();
  },
  'prod-del': el => {
    const id = el.dataset.id;
    if (ui.armed !== 'p' + id) { ui.armed = 'p' + id; renderAdminBody(); return; }
    S.products = S.products.filter(p => p.id !== id);
    Object.values(S.inventory).forEach(inv => delete inv[id]);
    delete S.cart[id];
    ui.armed = null; save(); toast(t('productDeleted')); renderAll();
  },
  'order-advance': el => {
    const o = S.orders.find(x => x.id === el.dataset.id);
    if (!o) return;
    if (o.status < 3) o.status++;
    save(); toast(`${o.id}: ${t('status' + o.status)}`); renderAll();
  },
};

document.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el) { if (ui.armed) { ui.armed = null; if (ui.route === 'admin') renderAdminBody(); } return; }
  const a = el.dataset.action;
  // buttons inside a clickable store row shouldn't also trigger the row
  if (a === 'store-focus' && e.target.closest('button')) return;
  if (!/^(zone-del|store-del|prod-del|reset-demo)$/.test(a) && ui.armed) ui.armed = null;
  if (actions[a]) { e.preventDefault(); actions[a](el); }
});

document.addEventListener('input', e => {
  const el = e.target;
  if (el.id === 'search') { ui.q = el.value; if (ui.route !== 'shop') location.hash = '#shop'; else renderShop(); return; }
  const val = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;
  if (el.dataset.zf && ui.zoneEdit) { ui.zoneEdit[el.dataset.zf] = val; if (el.dataset.zf === 'color') redrawAdminMap(); }
  if (el.dataset.sf && ui.storeEdit) ui.storeEdit[el.dataset.sf] = val;
});

document.addEventListener('change', e => {
  const el = e.target;
  if (el.dataset.stock) {
    const [sid, pid] = el.dataset.stock.split('|');
    S.inventory[sid] = S.inventory[sid] || {};
    if (el.value === '') delete S.inventory[sid][pid]; else S.inventory[sid][pid] = Math.max(0, Math.round(+el.value));
    el.classList.toggle('zero', el.value !== '' && +el.value === 0);
    el.classList.toggle('na', el.value === '');
    save();
  }
  if (el.dataset.price) { const p = S.products.find(x => x.id === el.dataset.price); if (p && +el.value >= 0) { p.price = +el.value; save(); } }
  if (el.dataset.listed) { const p = S.products.find(x => x.id === el.dataset.listed); if (p) { p.listed = el.checked; save(); } }
});

document.addEventListener('submit', e => {
  e.preventDefault();
  if (e.target.id === 'checkoutForm') placeOrder(e.target);
  if (e.target.id === 'newProduct') {
    const f = Object.fromEntries(new FormData(e.target));
    const id = uid('p');
    const name = f.name.trim() || f.nameAr.trim();
    S.products.unshift({
      id, name, nameAr: f.nameAr.trim() || null, category: f.category, price: +f.price,
      unit: f.unit.trim() || '1 pc', unitAr: f.unitAr.trim() || null, was: null, listed: true,
    });
    S.stores.forEach(s => { (S.inventory[s.id] = S.inventory[s.id] || {})[id] = Math.max(0, +f.stock || 0); });
    save(); toast(t('productAdded', { p: nm(S.products[0]) })); renderAdminBody();
  }
});

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (!$('#locModal').hidden) closeLoc();
  else if (ui.cartOpen) actions['close-cart']();
  else if (ui.zoneEdit) actions['zone-cancel']();
});

window.addEventListener('hashchange', route);

/* ---------------- boot ---------------- */
applyStatic();
renderBrand();
route();
// Auto-detect on first visit; if that fails, let the customer choose on the map.
if (!S.customer) {
  detectLocation(loc => {
    if (loc) setCustomer(loc);
    else if (ui.route === 'shop') openLoc();
  });
}
