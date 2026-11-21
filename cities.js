// AVAILO City system — location-based listings (BookMyShow model, 21 Nov 2026).
//
// RULES (user point 3, 21 Nov 2026):
// - The service launches city by city. The homepage shows ONLY the selected
//   city's services; a Vijayawada service must NEVER appear in Guntur or
//   anywhere else.
// - TODAY only Vijayawada is LIVE, with exactly ONE restaurant (Khaleel Bhai
//   Family Restaurant — the existing dine.html; the menu is NOT duplicated
//   here). Guntur, Sattenapalli, Pedakurapadu, Vinukonda and Chilakaluripet
//   exist as "త్వరలో" (coming soon) entries: NO invented restaurants, NO
//   invented prices, NO invented phone numbers.
// - First visit: the visitor picks a city, or uses browser geolocation (with
//   permission). If geolocation is denied/unavailable, the manual picker is
//   the fallback. The picker MUST appear — NEVER silently assume Vijayawada
//   for a visitor in another city.
// - The choice is remembered in localStorage ('availo_city'); a "మార్చు"
//   (change) control re-opens the picker.
// - A QR scan goes STRAIGHT to dine.html regardless of city/location:
//   dine.html has NO city gate and this file is NOT loaded there.
// - Gate Pass is apartment-specific: it stays visible in every city, with a
//   note that it works only where Availo operates. Coverage is never invented.
//
// DATA PATTERN: same as rates.js — one global data array + render functions.
// `lat`/`lng` are the town centres; `radiusKm` is the service area. When a
// point falls inside MORE THAN ONE radius (Vijayawada 25 km and Guntur 20 km
// overlap around Mangalagiri), the NEAREST centre wins.
var AVAILO_CITIES = [
  { id: 'vijayawada',
    name: { te: 'విజయవాడ', en: 'Vijayawada', hi: 'विजयवाड़ा' },
    lat: 16.5062, lng: 80.6480, radiusKm: 25, live: true,
    // The ONLY live restaurant on the site today. Reuses dine.html as-is.
    restaurants: [ { name: 'Khaleel Bhai Family Restaurant', url: 'dine.html' } ] },
  { id: 'guntur',
    name: { te: 'గుంటూరు', en: 'Guntur', hi: 'गुंटूर' },
    lat: 16.3067, lng: 80.4365, radiusKm: 20, live: false, restaurants: [] },
  { id: 'sattenapalli',
    name: { te: 'సత్తెనపల్లి', en: 'Sattenapalli', hi: 'सत्तेनपल्लि' },
    lat: 16.3962, lng: 80.1730, radiusKm: 10, live: false, restaurants: [] },
  { id: 'pedakurapadu',
    name: { te: 'పెదకూరపాడు', en: 'Pedakurapadu', hi: 'पेदकूरपाडु' },
    lat: 16.4833, lng: 80.3167, radiusKm: 10, live: false, restaurants: [] },
  { id: 'vinukonda',
    name: { te: 'వినుకొండ', en: 'Vinukonda', hi: 'विनुकोंडा' },
    lat: 16.0500, lng: 79.7333, radiusKm: 10, live: false, restaurants: [] },
  { id: 'chilakaluripet',
    name: { te: 'చిలకలూరిపేట', en: 'Chilakaluripet', hi: 'चिलकलूरीपेट' },
    lat: 16.0894, lng: 80.1647, radiusKm: 10, live: false, restaurants: [] }
];

var AVAILO_CITY_STORAGE_KEY = 'availo_city';

var AVAILO_CITY_STRINGS = {
  te: {
    pickerTitle: 'మీ నగరం ఎంచుకోండి',
    pickerSub: 'మీ ప్రాంతంలో AVAILO సేవలు చూడటానికి నగరం ఎంచుకోండి.',
    useLocation: '📍 నా లొకేషన్ వాడండి',
    orPick: 'లేదా నగరం ఎంచుకోండి',
    liveTag: 'లైవ్', soonTag: 'త్వరలో', change: 'మార్చు', close: 'మూసివేయి',
    geoOutside: 'మీ ప్రాంతం ప్రస్తుత జాబితాలో లేదు — దగ్గరి నగరం ఎంచుకోండి.',
    geoDenied: 'లొకేషన్ అందుబాటులో లేదు — నగరం ఎంచుకోండి.',
    geoWorking: 'లొకేషన్ చూస్తున్నాం…',
    bannerSoon: '{city}లో AVAILO సేవలు త్వరలో వస్తాయి.',
    gateNote: 'గేట్ పాస్ అవైలో పనిచేస్తున్న అపార్ట్‌మెంట్లలో మాత్రమే అందుబాటులో ఉంటుంది.'
  },
  en: {
    pickerTitle: 'Choose your city',
    pickerSub: 'Pick your city to see AVAILO services in your area.',
    useLocation: '📍 Use my location',
    orPick: 'Or pick a city',
    liveTag: 'Live', soonTag: 'Coming soon', change: 'Change', close: 'Close',
    geoOutside: 'Your area is not in the list yet — pick the nearest city.',
    geoDenied: 'Location not available — please pick a city.',
    geoWorking: 'Detecting location…',
    bannerSoon: 'AVAILO services are coming soon to {city}.',
    gateNote: 'Gate Pass is available only in apartments where Availo operates.'
  },
  hi: {
    pickerTitle: 'अपना शहर चुनें',
    pickerSub: 'अपने क्षेत्र में AVAILO सेवाएँ देखने के लिए शहर चुनें।',
    useLocation: '📍 मेरा स्थान उपयोग करें',
    orPick: 'या शहर चुनें',
    liveTag: 'लाइव', soonTag: 'जल्द', change: 'बदलें', close: 'बंद करें',
    geoOutside: 'आपका क्षेत्र अभी सूची में नहीं है — निकटतम शहर चुनें।',
    geoDenied: 'स्थान उपलब्ध नहीं है — कृपया शहर चुनें।',
    geoWorking: 'स्थान पता कर रहे हैं…',
    bannerSoon: 'AVAILO सेवाएँ जल्द ही {city} में आएँगी।',
    gateNote: 'गेट पास केवल उन अपार्टमेंटों में उपलब्ध है जहाँ AVAILO काम करता है।'
  }
};

// --- Pure helpers (no DOM) ---------------------------------------------------

// Haversine distance in km between two lat/lng points.
function availoCityDistanceKm(lat1, lng1, lat2, lng2) {
  var R = 6371;
  var dLat = (lat2 - lat1) * Math.PI / 180;
  var dLng = (lng2 - lng1) * Math.PI / 180;
  var a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
    * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.sqrt(a));
}

function availoCityGet(id) {
  for (var i = 0; i < AVAILO_CITIES.length; i++) {
    if (AVAILO_CITIES[i].id === id) return AVAILO_CITIES[i];
  }
  return null;
}

function availoCityLiveCities() {
  var out = [];
  for (var i = 0; i < AVAILO_CITIES.length; i++) {
    if (AVAILO_CITIES[i].live) out.push(AVAILO_CITIES[i]);
  }
  return out;
}

// Nearest city whose service radius contains (lat, lng); null if none.
// Live and coming-soon cities both match — the caller decides what to do
// with a coming-soon match (the picker opens with it preselected).
function availoCityMatch(lat, lng) {
  var best = null, bestDist = Infinity;
  for (var i = 0; i < AVAILO_CITIES.length; i++) {
    var c = AVAILO_CITIES[i];
    var d = availoCityDistanceKm(lat, lng, c.lat, c.lng);
    if (d <= c.radiusKm && d < bestDist) { best = c; bestDist = d; }
  }
  return best;
}

// Live services of a city: today only Vijayawada has any (its restaurants).
// Every other city returns an empty list — never an invented listing.
function availoCityLiveServices(cityId) {
  var c = availoCityGet(cityId);
  if (!c || !c.live) return [];
  return (c.restaurants || []).slice();
}

// --- Storage -----------------------------------------------------------------

function availoCityGetSaved() {
  try {
    var id = window.localStorage.getItem(AVAILO_CITY_STORAGE_KEY);
    if (!id) return null;
    var c = availoCityGet(id);
    if (!c) { window.localStorage.removeItem(AVAILO_CITY_STORAGE_KEY); return null; }
    return c;
  } catch (e) { return null; }
}

function availoCitySet(id) {
  var c = availoCityGet(id);
  if (!c) return false;
  try { window.localStorage.setItem(AVAILO_CITY_STORAGE_KEY, id); } catch (e) {}
  availoCityHidePicker();
  availoCityApply(id);
  return true;
}

// --- Language ----------------------------------------------------------------

function availoCityLang() {
  var l = null;
  try {
    l = document.documentElement.getAttribute('lang');
    if (!l) l = window.localStorage.getItem('availo_lang');
  } catch (e) {}
  return (l === 'en' || l === 'hi') ? l : 'te';
}

function availoCityT(key) {
  var strings = AVAILO_CITY_STRINGS[availoCityLang()] || AVAILO_CITY_STRINGS.te;
  return strings[key] || AVAILO_CITY_STRINGS.te[key] || key;
}

// --- DOM: style, bar, banner, gate note --------------------------------------

function availoCityInjectStyle() {
  if (document.getElementById('availoCityStyle')) return;
  var s = document.createElement('style');
  s.id = 'availoCityStyle';
  s.textContent =
    '#availoCityBar{display:flex;align-items:center;justify-content:space-between;gap:10px;background:#071426;color:#fff;padding:8px 16px;font-size:13.5px;font-weight:700;}' +
    '#availoCityBar button{background:#0ea5e9;color:#fff;border:none;border-radius:999px;padding:5px 12px;font-size:12.5px;font-weight:800;cursor:pointer;}' +
    '.availo-city-soon-badge{display:inline-block;background:#fef3c7;color:#92400e;font-weight:800;font-size:12px;padding:3px 9px;border-radius:999px;margin-bottom:8px;}' +
    '.availo-city-disabled{opacity:.55 !important;}' +
    '#availoCityBanner{background:#fffbeb;border:1.5px solid #f59e0b;color:#92400e;border-radius:12px;padding:10px 14px;font-size:13.5px;font-weight:700;margin:0 0 14px;}' +
    '#availoCityGateNote{font-size:12px;color:#64748b;margin:0 0 12px;line-height:1.6;}' +
    '#availoCityPicker{position:fixed;inset:0;background:rgba(7,20,38,.72);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;}' +
    '#availoCityPickerCard{background:#fff;border-radius:16px;max-width:430px;width:100%;padding:20px;box-shadow:0 12px 40px rgba(0,0,0,.35);}' +
    '#availoCityPickerCard h2{font-size:18px;font-weight:800;color:#071426;margin:0 0 6px;}' +
    '#availoCityPickerCard p{font-size:13.5px;color:#475569;line-height:1.6;margin:0 0 12px;}' +
    '.availo-city-geo{width:100%;background:#16a34a;color:#fff;border:none;border-radius:10px;padding:12px;font-size:14.5px;font-weight:800;cursor:pointer;margin-bottom:12px;}' +
    '.availo-city-chip{display:flex;align-items:center;justify-content:space-between;width:100%;background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:10px;padding:11px 12px;font-size:14.5px;font-weight:700;color:#0f2a5c;cursor:pointer;margin-bottom:8px;text-align:left;}' +
    '.availo-city-chip:hover{border-color:#0ea5e9;}' +
    '.availo-city-tag{font-size:11px;font-weight:800;padding:2px 8px;border-radius:999px;}' +
    '.availo-city-tag-live{background:#dcfce7;color:#166534;}' +
    '.availo-city-tag-soon{background:#fef3c7;color:#92400e;}' +
    '#availoCityPickerNote{font-size:12.5px;color:#b45309;min-height:18px;margin-top:4px;line-height:1.5;}' +
    '#availoCityPickerClose{width:100%;background:#f1f5f9;color:#334155;border:none;border-radius:10px;padding:10px;font-size:13.5px;font-weight:700;cursor:pointer;margin-top:10px;}';
  document.head.appendChild(s);
}

function availoCityRenderBar() {
  var saved = availoCityGetSaved();
  var old = document.getElementById('availoCityBar');
  if (!saved) { if (old) old.remove(); return; }
  var lang = availoCityLang();
  var label = '📍 ' + (saved.name[lang] || saved.name.te);
  if (old) {
    var span = old.querySelector('span');
    if (span) span.textContent = label;
    var btn = old.querySelector('button');
    if (btn) btn.textContent = availoCityT('change');
    return;
  }
  var bar = document.createElement('div');
  bar.id = 'availoCityBar';
  var s = document.createElement('span');
  s.textContent = label;
  var b = document.createElement('button');
  b.type = 'button';
  b.textContent = availoCityT('change');
  b.onclick = function () { availoCityShowPicker(saved.id); };
  bar.appendChild(s);
  bar.appendChild(b);
  var header = document.querySelector('header');
  if (header && header.parentNode) header.parentNode.insertBefore(bar, header.nextSibling);
  else if (document.body.firstChild) document.body.insertBefore(bar, document.body.firstChild);
  else document.body.appendChild(bar);
}

// --- DOM: gating ---------------------------------------------------------------
// The three gated homepage services, found by their Telugu heading (the same
// data-te text the page already uses). NRI Care and Smart Cube are NOT gated
// (out of scope for the city launch).
var AVAILO_CITY_GATED = [
  { headingTe: 'AVAILO హోమ్ సర్వీసెస్', actionSelector: 'a[onclick*="waLink"]' },
  { headingTe: 'AVAILO డైన్ & స్టే', actionSelector: 'a[href="dine.html"]' },
  { headingTe: 'AVAILO సెలూన్', actionSelector: 'a[href="salon.html"]' }
];

function availoCityFindCard(headingTe) {
  var heads = document.querySelectorAll('h3[data-te]');
  for (var i = 0; i < heads.length; i++) {
    if (heads[i].getAttribute('data-te') === headingTe) {
      var el = heads[i];
      while (el && !(el.classList && el.classList.contains('srv-card'))) el = el.parentNode;
      return el;
    }
  }
  return null;
}

function availoCityGateCard(card, cityName) {
  if (!card) return;
  card.classList.add('availo-city-soon');
  var body = card.querySelector('.srv-card-body') || card;
  if (!body.querySelector('.availo-city-soon-badge')) {
    var badge = document.createElement('span');
    badge.className = 'availo-city-soon-badge';
    badge.textContent = availoCityT('soonTag');
    body.insertBefore(badge, body.firstChild);
  }
}

function availoCityUngateCard(card) {
  if (!card) return;
  card.classList.remove('availo-city-soon');
  var badge = card.querySelector('.availo-city-soon-badge');
  if (badge) badge.remove();
}

function availoCityGateButton(btn, gate) {
  if (!btn) return;
  if (gate) {
    if (!btn.getAttribute('data-availo-orig-text')) {
      btn.setAttribute('data-availo-orig-text', btn.textContent);
    }
    btn.textContent = availoCityT('soonTag');
    btn.setAttribute('aria-disabled', 'true');
    btn.classList.add('availo-city-disabled');
    btn.style.pointerEvents = 'none';
  } else {
    var orig = btn.getAttribute('data-availo-orig-text');
    if (orig !== null && orig !== undefined) btn.textContent = orig;
    btn.removeAttribute('data-availo-orig-text');
    btn.removeAttribute('aria-disabled');
    btn.classList.remove('availo-city-disabled');
    btn.style.pointerEvents = '';
  }
}

function availoCityRenderBanner(city) {
  var old = document.getElementById('availoCityBanner');
  if (old) old.remove();
  if (!city || city.live) return;
  var section = document.getElementById('services');
  if (!section) return;
  var banner = document.createElement('div');
  banner.id = 'availoCityBanner';
  var name = city.name[availoCityLang()] || city.name.te;
  banner.textContent = '📍 ' + availoCityT('bannerSoon').replace('{city}', name);
  section.insertBefore(banner, section.firstChild);
}

function availoCityRenderGateNote(city) {
  var old = document.getElementById('availoCityGateNote');
  if (old) old.remove();
  if (!city || city.live) return;
  var gate = document.getElementById('gate-section');
  if (!gate) return;
  var body = gate.querySelector('div[style*="padding: 16px"]') || gate;
  var note = document.createElement('p');
  note.id = 'availoCityGateNote';
  note.textContent = availoCityT('gateNote');
  body.insertBefore(note, body.firstChild);
}

// Applies one city's listing state to the homepage. Idempotent and
// reversible: switching back to a live city restores every button's
// original text and re-enables it.
function availoCityApply(cityId) {
  var city = availoCityGet(cityId);
  if (!city) return false;
  availoCityInjectStyle();
  var live = !!city.live;
  for (var i = 0; i < AVAILO_CITY_GATED.length; i++) {
    var spec = AVAILO_CITY_GATED[i];
    var card = availoCityFindCard(spec.headingTe);
    if (!card) continue;
    if (live) {
      availoCityUngateCard(card);
    } else {
      availoCityGateCard(card, city.name[availoCityLang()] || city.name.te);
    }
    var btns = card.querySelectorAll(spec.actionSelector);
    for (var j = 0; j < btns.length; j++) availoCityGateButton(btns[j], !live);
  }
  availoCityRenderBanner(city);
  availoCityRenderGateNote(city);
  availoCityRenderBar();
  return true;
}

// --- DOM: picker ---------------------------------------------------------------

function availoCityShowPicker(preselectId) {
  availoCityInjectStyle();
  var saved = availoCityGetSaved();
  var overlay = document.getElementById('availoCityPicker');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'availoCityPicker';
    var card = document.createElement('div');
    card.id = 'availoCityPickerCard';
    card.innerHTML =
      '<h2 data-availo-city-text="pickerTitle"></h2>' +
      '<p data-availo-city-text="pickerSub"></p>' +
      '<button type="button" class="availo-city-geo" id="availoCityGeoBtn" data-availo-city-text="useLocation"></button>' +
      '<p data-availo-city-text="orPick" style="font-weight:700;color:#0f2a5c;"></p>' +
      '<div id="availoCityChips"></div>' +
      '<div id="availoCityPickerNote"></div>' +
      '<button type="button" id="availoCityPickerClose" data-availo-city-text="close" style="display:none;"></button>';
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    var geoBtn = document.getElementById('availoCityGeoBtn');
    if (geoBtn) geoBtn.onclick = function () { availoCityUseLocation(); };
    var closeBtn = document.getElementById('availoCityPickerClose');
    if (closeBtn) closeBtn.onclick = function () { availoCityHidePicker(); };
  }
  // (Re)build the city chips in the current language.
  var chips = document.getElementById('availoCityChips');
  if (chips) {
    chips.innerHTML = '';
    for (var i = 0; i < AVAILO_CITIES.length; i++) {
      (function (c) {
        var chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'availo-city-chip';
        chip.setAttribute('data-availo-city-id', c.id);
        var lang = availoCityLang();
        var nm = document.createElement('span');
        nm.textContent = c.name[lang] || c.name.te;
        var tag = document.createElement('span');
        tag.className = 'availo-city-tag ' + (c.live ? 'availo-city-tag-live' : 'availo-city-tag-soon');
        tag.textContent = c.live ? availoCityT('liveTag') : availoCityT('soonTag');
        chip.appendChild(nm);
        chip.appendChild(tag);
        chip.onclick = function () { availoCitySet(c.id); };
        if (preselectId && c.id === preselectId) {
          chip.style.borderColor = '#0ea5e9';
          chip.style.background = '#f0f9ff';
        }
        chips.appendChild(chip);
      })(AVAILO_CITIES[i]);
    }
  }
  // Text (re-rendered on every open, so a language switch is picked up).
  var texts = overlay.querySelectorAll('[data-availo-city-text]');
  for (var t = 0; t < texts.length; t++) {
    texts[t].textContent = availoCityT(texts[t].getAttribute('data-availo-city-text'));
  }
  var close = document.getElementById('availoCityPickerClose');
  if (close) close.style.display = saved ? '' : 'none';
  overlay.style.display = 'flex';
  return overlay;
}

function availoCityHidePicker() {
  var overlay = document.getElementById('availoCityPicker');
  if (overlay) overlay.style.display = 'none';
}

function availoCityPickerNote(text) {
  var n = document.getElementById('availoCityPickerNote');
  if (n) n.textContent = text || '';
}

// Browser geolocation (permission-gated). A match — live or coming-soon — is
// selected straight away; outside every radius the picker stays open for a
// manual choice. Denied/unavailable also falls back to the manual picker.
function availoCityUseLocation() {
  if (!navigator || !navigator.geolocation || !navigator.geolocation.getCurrentPosition) {
    availoCityPickerNote(availoCityT('geoDenied'));
    return;
  }
  availoCityPickerNote(availoCityT('geoWorking'));
  navigator.geolocation.getCurrentPosition(
    function (pos) {
      var match = availoCityMatch(pos.coords.latitude, pos.coords.longitude);
      if (match) { availoCitySet(match.id); }
      else {
        availoCityPickerNote(availoCityT('geoOutside'));
        availoCityShowPicker(null);
      }
    },
    function () {
      availoCityPickerNote(availoCityT('geoDenied'));
      availoCityShowPicker(null);
    },
    { timeout: 8000, maximumAge: 60000 }
  );
}

// Re-render bar/banner/note/picker text after a language switch.
function availoCityRefresh() {
  var saved = availoCityGetSaved();
  if (saved) availoCityApply(saved.id);
  else {
    var overlay = document.getElementById('availoCityPicker');
    if (overlay && overlay.style.display !== 'none') availoCityShowPicker(null);
  }
  availoCityRenderBar();
}

function availoCityWatchLang() {
  if (typeof MutationObserver === 'undefined') return;
  if (availoCityWatchLang._done) return;
  availoCityWatchLang._done = true;
  var obs = new MutationObserver(function (mutations) {
    for (var i = 0; i < mutations.length; i++) {
      if (mutations[i].attributeName === 'lang') { availoCityRefresh(); break; }
    }
  });
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
}

// --- Boot ----------------------------------------------------------------------

function availoCityInit() {
  availoCityInjectStyle();
  var saved = availoCityGetSaved();
  if (saved) availoCityApply(saved.id);
  else availoCityShowPicker(null);
  availoCityWatchLang();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', availoCityInit);
  } else {
    availoCityInit();
  }
}
