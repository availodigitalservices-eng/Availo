// Dine hotel voice flow — today's special (GAP 1) + most-ordered today
// (GAP 2), 25 Nov 2026, + UPI payee = AVAILO wiring check.
//
// GAP 1: the owner sets ONE special per day on dine-owner.html (dish +
// optional note); it is saved under
//   availo-kitchen-v1/dineSpecial/khaleel/{YYYY-MM-DD}  {dish, note, updatedAt}
// and shows live on the customer menu (dine.html) and in Mayura's answers.
// GAP 2: Mayura answers "what are people eating most today" ONLY from
// TODAY's live dine orders (availo-kitchen-v1/dineOrders/khaleel),
// aggregated by getPopularToday() — never an invented dish or count.
// UPI: the payee is AVAILO (owner decision 25 Nov 2026), never the
// restaurant; HOTEL_UPI_ID stays EMPTY until the user shares AVAILO's
// own UPI ID, and the "not set" note must say so.
//
// Run:  node dine-special-popular.test.js   (from this directory)
//        npm test                            (runs all test files)

const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const vm = require('node:vm');

const INDEX_HTML = path.join(__dirname, '..', 'index.html');
const DINE_HTML = path.join(__dirname, '..', 'dine.html');
const OWNER_HTML = path.join(__dirname, '..', 'dine-owner.html');
const CODE_GS = path.join(__dirname, '..', 'sheets-apps-script', 'Code.gs');
const SPECIAL_PATH = 'availo-kitchen-v1/dineSpecial/khaleel';
const ORDERS_PATH = 'availo-kitchen-v1/dineOrders/khaleel';

function inlineScript(file) {
    const html = fs.readFileSync(file, 'utf8');
    const m = html.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(m, 'inline script block not found in ' + file);
    return { html, script: m[1] };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function localYmd(d) {
    const x = d || new Date();
    const p = (n) => String(n).padStart(2, '0');
    return x.getFullYear() + '-' + p(x.getMonth() + 1) + '-' + p(x.getDate());
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ---------------------------------------------------------------------------
// Shared fake Firebase RTDB (copied from dine-owner.test.js): a listener on
// a parent node fires when any child under it changes, and reading a
// parent returns an object of its children. `setPath(path, value)`
// seeds/replaces a whole subtree; the ref API writes through the same path.
// ---------------------------------------------------------------------------
function makeFirebaseMock() {
    const store = {};
    const listeners = {};
    const writes = [];
    function getValue(path) {
        if (path in store) return store[path];
        const prefix = path ? path + '/' : '';
        const out = {};
        let found = false;
        for (const key of Object.keys(store)) {
            if (!key.startsWith(prefix)) continue;
            const rest = key.slice(prefix.length);
            const first = rest.split('/')[0];
            if (!(first in out)) {
                out[first] = rest.indexOf('/') === -1 ? store[key] : getValue(path + '/' + first);
            }
            found = true;
        }
        return found ? out : null;
    }
    function fire(path) {
        const parts = path.split('/').filter(Boolean);
        for (let i = parts.length; i >= 0; i--) {
            const p = parts.slice(0, i).join('/');
            (listeners[p] || []).forEach(cb => cb({ val: () => getValue(p) }));
        }
    }
    function setPath(path, value) {
        for (const key of Object.keys(store)) {
            if (key === path || key.startsWith(path + '/')) delete store[key];
        }
        if (value !== null && typeof value === 'object') {
            (function flatten(obj, base) {
                for (const k of Object.keys(obj)) {
                    const p = base ? base + '/' + k : k;
                    if (obj[k] !== null && typeof obj[k] === 'object') flatten(obj[k], p);
                    else store[p] = obj[k];
                }
            })(value, path);
        } else if (value !== null && value !== undefined) {
            store[path] = value;
        }
        fire(path);
    }
    const fakeDb = {
        ref: (path) => ({
            on: (evt, cb) => {
                (listeners[path] = listeners[path] || []).push(cb);
                cb({ val: () => getValue(path) });
            },
            off: () => {},
            set: (v) => { writes.push({ op: 'set', path, value: v }); setPath(path, v); return Promise.resolve(); },
            remove: () => { writes.push({ op: 'remove', path }); setPath(path, null); return Promise.resolve(); },
            push: () => ({ key: 'mock-key' }),
        }),
    };
    return { firebase: { apps: [], initializeApp: () => {}, database: () => fakeDb }, store, writes, fire, setPath };
}

// ---------------------------------------------------------------------------
// Part A — index.html (Mayura live data). Same loader shape as
// mayura-conversational.test.js, but fetch is routed: RTDB REST reads
// return the canned live data, the Apps Script URL returns the proxy reply.
// ---------------------------------------------------------------------------
function loadIndexPage(fetchImpl) {
    const { html, script } = inlineScript(INDEX_HTML);
    const fetchCalls = [];
    const spoken = [];
    const dom = new JSDOM(html, {
        url: 'https://availoservices.in/',
        runScripts: 'outside-only',
        pretendToBeVisual: true,
        beforeParse(window) {
            window.AVAILO_SHEETS_URL = 'https://script.google.com/macros/s/TEST/exec';
            window.fetch = async (url, opts) => { fetchCalls.push({ url, opts }); return fetchImpl(url, opts); };
            window.speechSynthesis = {
                getVoices: () => [],
                speak: u => { spoken.push(u); },
                cancel: () => {},
                onvoiceschanged: null,
            };
            window.SpeechSynthesisUtterance = class {
                constructor(text) { this.text = text; this.lang = ''; this.voice = null; this.pitch = 1; this.rate = 1; this.onend = null; this.onerror = null; }
            };
            window.SpeechRecognition = undefined;
            window.webkitSpeechRecognition = undefined;
        },
    });
    dom.window.eval(script);
    return { window: dom.window, document: dom.window.document, fetchCalls, spoken };
}

function lastChatText(document) {
    const log = document.getElementById('mayuraChatLog');
    assert.ok(log, 'mayuraChatLog must exist');
    assert.ok(log.children.length >= 2, 'user + Mayura messages expected, got ' + log.children.length);
    return log.children[log.children.length - 1].textContent;
}

test('getPopularToday: ranks by plates desc, revenue tiebreak, name tiebreak, caps at 5', () => {
    const { window } = loadIndexPage(() => { throw new Error('no fetch expected'); });
    try {
        const now = Date.now();
        const orders = [
            { items: [{ id: 'a', name: 'బిర్యానీ', qty: 2, price: 100 }], createdAt: now },
            { items: [{ id: 'b', name: 'దోస', qty: 2, price: 200 }], createdAt: now },
            { items: [{ id: 'c', name: 'నాన్', qty: 2, price: 50 }], createdAt: now },
            { items: [{ id: 'a', name: 'బిర్యానీ', qty: 1, price: 100 }], createdAt: now },
            { items: [{ id: 'd', name: 'ఇడ్లీ', qty: 1, price: 30 }], createdAt: now },
            { items: [{ id: 'e', name: 'వడ', qty: 1, price: 20 }], createdAt: now },
            { items: [{ id: 'f', name: 'పూరీ', qty: 1, price: 25 }], createdAt: now },
            { items: [{ id: 'g', name: 'ఉప్మా', qty: 1, price: 15 }], createdAt: now },
        ];
        const top = window.getPopularToday(orders, now);
        assert.equal(top.length, 5, 'capped at 5');
        assert.equal(top[0].id, 'a', 'biryani 3 plates first');
        assert.equal(top[0].qty, 3);
        assert.equal(top[1].id, 'b', 'dosa beats naan on revenue at 2 plates');
        assert.equal(top[2].id, 'c');
        assert.equal(top[3].id, 'd', 'idli beats vada/poori/upma on revenue at 1 plate');
    } finally { window.close(); }
});

test('getPopularToday: ignores yesterday orders, records without items, empty input', () => {
    const { window } = loadIndexPage(() => { throw new Error('no fetch expected'); });
    try {
        const now = Date.now();
        const orders = {
            'AV-OLD': { items: [{ id: 'dosa', name: 'మసాలా దోస', qty: 9, price: 90 }], createdAt: now - 26 * 3600 * 1000 },
            'AV-EMPTY': { items: [], createdAt: now },
            'AV-NOITEMS': { createdAt: now },
            'AV-TODAY': { items: [{ id: 'biryani', name: 'చికెన్ బిర్యానీ', qty: 2, price: 240 }], createdAt: now },
        };
        const top = window.getPopularToday(orders, now);
        assert.equal(top.length, 1, 'only today\'s order with items counts');
        assert.equal(top[0].id, 'biryani');
        assert.equal(top[0].qty, 2);
        // Cross-realm arrays from the jsdom window fail deepEqual on
        // prototype, so assert on plain values instead.
        assert.equal(window.getPopularToday(null, now).length, 0);
        assert.equal(window.getPopularToday({}, now).length, 0);
        assert.equal(window.getPopularToday([], now).length, 0);
    } finally { window.close(); }
});

test('canned special: with live data set, answer names the dish and note', () => {
    const { window } = loadIndexPage(() => { throw new Error('no fetch expected'); });
    try {
        const live = { fetched: true, special: { dish: 'చికెన్ దమ్ బిర్యానీ', note: 'ఈరోజు మాత్రమే' }, popular: [] };
        const a = window.mayuraCannedAnswer('ఈరోజు స్పెషల్ ఏంటి?', 'te', live);
        assert.ok(a.includes('చికెన్ దమ్ బిర్యానీ'), 'dish: ' + a);
        assert.ok(a.includes('ఈరోజు మాత్రమే'), 'note: ' + a);
        assert.ok(!a.includes('₹'), 'no invented price in the special answer');
        const en = window.mayuraCannedAnswer('what is today\'s special?', 'en', live);
        assert.ok(en.includes('చికెన్ దమ్ బిర్యానీ'), 'English answer keeps the dish name: ' + en);
    } finally { window.close(); }
});

test('canned special: live read OK but no special set today says so, never invents', () => {
    const { window } = loadIndexPage(() => { throw new Error('no fetch expected'); });
    try {
        const live = { fetched: true, special: null, popular: [] };
        const a = window.mayuraCannedAnswer('ఈరోజు స్పెషల్ ఏంటి?', 'te', live);
        assert.ok(a.includes('ఇంకా పెట్టలేదు'), 'no-special answer: ' + a);
        assert.ok(!/బిర్యానీ|దోస|నాన్/.test(a), 'no dish invented: ' + a);
    } finally { window.close(); }
});

test('canned special: no live read (or failed read) says it could not be checked', () => {
    const { window } = loadIndexPage(() => { throw new Error('no fetch expected'); });
    try {
        const a = window.mayuraCannedAnswer('ఈరోజు స్పెషల్ ఏంటి?', 'te');
        assert.ok(a.includes('చూడలేకపోయాను'), 'unknown answer: ' + a);
        const b = window.mayuraCannedAnswer('ఈరోజు స్పెషల్ ఏంటి?', 'te', { fetched: false, special: null, popular: [] });
        assert.ok(b.includes('చూడలేకపోయాను'), 'failed-read answer: ' + b);
    } finally { window.close(); }
});

test('canned popular: with live orders, answer lists top dishes with counts', () => {
    const { window } = loadIndexPage(() => { throw new Error('no fetch expected'); });
    try {
        const live = {
            fetched: true, special: null,
            popular: [
                { id: 'biryani', name: 'చికెన్ బిర్యానీ', qty: 5, revenue: 1200 },
                { id: 'naan', name: 'బటర్ నాన్', qty: 2, revenue: 80 },
            ],
        };
        const a = window.mayuraCannedAnswer('ఈరోజు ఎక్కువగా ఏం ఆర్డర్ అవుతుంది?', 'te', live);
        assert.ok(a.includes('చికెన్ బిర్యానీ (5)'), 'top dish with count: ' + a);
        assert.ok(a.includes('బటర్ నాన్ (2)'), 'second dish: ' + a);
    } finally { window.close(); }
});

test('canned popular: live read OK but no orders yet today says so', () => {
    const { window } = loadIndexPage(() => { throw new Error('no fetch expected'); });
    try {
        const live = { fetched: true, special: null, popular: [] };
        const a = window.mayuraCannedAnswer('ఈరోజు ఎక్కువగా ఏం ఆర్డర్ అవుతుంది?', 'te', live);
        assert.ok(a.includes('ఇంకా ఏ ఆర్డర్ రాలేదు'), 'no-orders answer: ' + a);
        const b = window.mayuraCannedAnswer('ఈరోజు ఎక్కువగా ఏం ఆర్డర్ అవుతుంది?', 'te');
        assert.ok(b.includes('చూడలేకపోయాను'), 'unknown answer: ' + b);
    } finally { window.close(); }
});

test('canned popular: a high-price question is NOT a popular-dish question', () => {
    const { window } = loadIndexPage(() => { throw new Error('no fetch expected'); });
    try {
        const live = { fetched: true, special: null, popular: [{ id: 'biryani', name: 'చికెన్ బిర్యానీ', qty: 5, revenue: 1200 }] };
        const a = window.mayuraCannedAnswer('బిర్యానీ ధర ఎక్కువా?', 'te', live);
        assert.ok(a.includes('ధరలు ఇంకా ఖరారు కాలేదు'), 'rates answer, not popular: ' + a);
        assert.ok(!a.includes('చికెన్ బిర్యానీ (5)'), 'no popular dish leaked into a rates question: ' + a);
    } finally { window.close(); }
});

test('canned: a question with both special and popular keywords answers both', () => {
    const { window } = loadIndexPage(() => { throw new Error('no fetch expected'); });
    try {
        const live = {
            fetched: true, special: { dish: 'చికెన్ దమ్ బిర్యానీ', note: '' },
            popular: [{ id: 'biryani', name: 'చికెన్ బిర్యానీ', qty: 4, revenue: 960 }],
        };
        const a = window.mayuraCannedAnswer('ఈరోజు స్పెషల్ ఏంటి, ఎక్కువగా ఏం ఆర్డర్ అవుతుంది?', 'te', live);
        assert.ok(a.includes('చికెన్ దమ్ బిర్యానీ'), 'special part: ' + a);
        assert.ok(a.includes('(4)'), 'popular part: ' + a);
    } finally { window.close(); }
});

test('mayuraAsk special question: reads the live special, sends it to the proxy, AI answer shown', async () => {
    const special = { dish: 'చికెన్ దమ్ బిర్యానీ', note: 'ఈరోజు మాత్రమే', updatedAt: Date.now() };
    const { window, document, fetchCalls } = loadIndexPage((url) => {
        if (String(url).includes('firebasedatabase.app')) return { ok: true, json: async () => special };
        return { ok: true, json: async () => ({ ok: true, answer: 'AI: special is biryani.', source: 'ai' }) };
    });
    try {
        window.mayuraAsk('ఈరోజు స్పెషల్ ఏంటి?');
        await sleep(900);
        const specialCalls = fetchCalls.filter(c => String(c.url).includes('firebasedatabase.app'));
        assert.equal(specialCalls.length, 1, 'one RTDB read for the special');
        assert.ok(specialCalls[0].url.includes('/dineSpecial/khaleel/'), 'special node: ' + specialCalls[0].url);
        assert.ok(specialCalls[0].url.includes(localYmd()), 'today\'s key in the URL: ' + specialCalls[0].url);
        const proxyCalls = fetchCalls.filter(c => String(c.url).includes('script.google.com'));
        assert.equal(proxyCalls.length, 1, 'one proxy call');
        const body = JSON.parse(proxyCalls[0].opts.body);
        assert.equal(body.live.fetched, true, 'live sent to proxy');
        assert.equal(body.live.special.dish, 'చికెన్ దమ్ బిర్యానీ', 'live dish in proxy body');
        assert.ok(lastChatText(document).includes('AI: special is biryani.'), 'AI answer shown: ' + lastChatText(document));
    } finally { window.close(); }
});

test('mayuraAsk popular question: AI down falls back to the live canned popular answer', async () => {
    const now = Date.now();
    const orders = {
        'AV-1': { items: [{ id: 'biryani', name: 'చికెన్ బిర్యానీ', qty: 3, price: 240 }, { id: 'naan', name: 'బటర్ నాన్', qty: 2, price: 40 }], createdAt: now },
        'AV-2': { items: [{ id: 'biryani', name: 'చికెన్ బిర్యానీ', qty: 2, price: 240 }], createdAt: now },
        'AV-OLD': { items: [{ id: 'dosa', name: 'మసాలా దోస', qty: 9, price: 90 }], createdAt: now - 26 * 3600 * 1000 },
    };
    const { window, document, fetchCalls } = loadIndexPage((url) => {
        if (String(url).includes('firebasedatabase.app')) return { ok: true, json: async () => orders };
        return { ok: true, json: async () => ({ ok: false, error: 'ai_unavailable' }) };
    });
    try {
        window.mayuraAsk('ఈరోజు ఎక్కువగా ఏం ఆర్డర్ అవుతుంది?');
        await sleep(900);
        const orderCalls = fetchCalls.filter(c => String(c.url).includes('firebasedatabase.app'));
        assert.equal(orderCalls.length, 1, 'one RTDB read for orders');
        assert.ok(orderCalls[0].url.includes('/dineOrders/khaleel.json'), 'orders node: ' + orderCalls[0].url);
        const body = JSON.parse(fetchCalls.find(c => String(c.url).includes('script.google.com')).opts.body);
        assert.equal(body.live.popular[0].name, 'చికెన్ బిర్యానీ', 'live popular sent to proxy');
        assert.equal(body.live.popular[0].qty, 5, 'live count aggregated (3+2)');
        const ans = lastChatText(document);
        assert.ok(ans.includes('చికెన్ బిర్యానీ (5)'), 'canned fallback with live count: ' + ans);
        assert.ok(ans.includes('బటర్ నాన్ (2)'), 'second dish: ' + ans);
        assert.ok(!ans.includes('మసాలా దోస'), 'yesterday\'s dish never offered: ' + ans);
    } finally { window.close(); }
});

test('mayuraAsk non-live question: exactly one fetch call (the proxy), no RTDB read', async () => {
    const { window, document, fetchCalls } = loadIndexPage((url) => {
        if (String(url).includes('firebasedatabase.app')) throw new Error('RTDB must not be read for a gate question');
        return { ok: true, json: async () => ({ ok: true, answer: 'గేట్ పాస్ కోసం QR స్కాన్ చేయండి.', source: 'ai' }) };
    });
    try {
        window.mayuraAsk('గేట్ పాస్ ఎలా తీసుకోవాలి?');
        await sleep(900);
        assert.equal(fetchCalls.length, 1, 'one call only: ' + JSON.stringify(fetchCalls.map(c => c.url)));
        assert.ok(fetchCalls[0].url.includes('script.google.com'), 'the one call is the proxy');
        assert.ok(lastChatText(document).includes('గేట్ పాస్ కోసం QR స్కాన్ చేయండి.'), 'AI answer shown');
    } finally { window.close(); }
});

test('mayuraAsk special question with the RTDB read failing: honest unknown answer, proxy still gets fetched:false', async () => {
    const { window, document, fetchCalls } = loadIndexPage((url) => {
        if (String(url).includes('firebasedatabase.app')) throw new Error('network down');
        return { ok: true, json: async () => ({ ok: false, error: 'ai_unavailable' }) };
    });
    try {
        window.mayuraAsk('ఈరోజు స్పెషల్ ఏంటి?');
        await sleep(900);
        const body = JSON.parse(fetchCalls.find(c => String(c.url).includes('script.google.com')).opts.body);
        assert.equal(body.live.fetched, false, 'failed read reported as unfetched, never as "no special"');
        const ans = lastChatText(document);
        assert.ok(ans.includes('చూడలేకపోయాను'), 'honest unknown answer: ' + ans);
        assert.ok(!/బిర్యానీ|దోస/.test(ans), 'no dish invented: ' + ans);
    } finally { window.close(); }
});

test('UPI wiring: HOTEL_UPI_ID stays EMPTY, payee is AVAILO, never the restaurant', () => {
    const src = fs.readFileSync(DINE_HTML, 'utf8');
    assert.ok(/let HOTEL_UPI_ID = ''/.test(src), 'HOTEL_UPI_ID must stay EMPTY until the user shares AVAILO\'s UPI ID');
    // The old wording claimed the restaurant was the payee / the one to
    // ask. The new comment at the config ("NEVER set the restaurant's
    // UPI ID here") is intentional and must stay — assert only that the
    // old claims are gone.
    assert.ok(!src.includes("The restaurant's UPI ID is NOT on file"), 'old "restaurant\'s UPI ID is NOT on file" claim must be gone');
    assert.ok(!src.includes("only when the restaurant's UPI ID is configured"), 'old "restaurant\'s UPI ID is configured" claim must be gone');
    assert.ok(/AVAILO's own UPI ID/.test(src), 'the config comment must say the payee is AVAILO');
    assert.ok(/AVAILO Digital Services/.test(src), 'HOTEL_UPI_NAME example must be AVAILO Digital Services');
    assert.ok(src.includes('UPI ID సెట్ చేయలేదు — AVAILO UPI ID కోసం WhatsAppలో అడగండి'), 'payUpiNotSet must point at AVAILO');
    assert.ok(!src.includes('UPI ID సెట్ చేయలేదు — రెస్టారెంట్‌ను అడగండి'), 'the old UPI "ask the restaurant" note must be gone (the table-booking bookNotSet note keeps its own wording)');
});

// ---------------------------------------------------------------------------
// Part B — dine.html: the today's-special banner (no Firebase needed here;
// kitchenDb is null in the test, so initTodaySpecial fails open).
// ---------------------------------------------------------------------------
function loadDinePage() {
    const { html, script } = inlineScript(DINE_HTML);
    const spoken = [];
    const dom = new JSDOM(html, {
        url: 'https://availoservices.in/dine.html',
        runScripts: 'outside-only',
        pretendToBeVisual: true,
        beforeParse(window) {
            window.speechSynthesis = {
                getVoices: () => [],
                speak: u => { spoken.push(u); },
                cancel: () => {},
                onvoiceschanged: null,
            };
            window.SpeechSynthesisUtterance = class {
                constructor(text) { this.text = text; this.lang = ''; this.voice = null; this.pitch = 1; this.rate = 1; this.onend = null; this.onerror = null; }
            };
            window.Audio = class { constructor() {} play() { return Promise.resolve(); } pause() {} };
            window.open = () => null;
            window.alert = () => {};
            window.sendToSheet = () => {};
        },
    });
    dom.window.eval(script);
    return { window: dom.window, document: dom.window.document };
}

test('dine banner: hidden by default, shows dish + note when a special is set', () => {
    const { window, document } = loadDinePage();
    try {
        const banner = document.getElementById('todaySpecialBanner');
        assert.ok(banner, 'banner element must exist');
        assert.equal(banner.style.display, 'none', 'hidden when no special is set');
        window.renderTodaySpecial({ dish: 'చికెన్ దమ్ బిర్యానీ', note: 'ఈరోజు మాత్రమే', updatedAt: Date.now() });
        assert.equal(banner.style.display, 'block', 'shown once a special is set');
        assert.equal(document.getElementById('todaySpecialDish').textContent, 'చికెన్ దమ్ బిర్యానీ');
        assert.ok(document.getElementById('todaySpecialNote').textContent.includes('ఈరోజు మాత్రమే'), 'note shown');
        window.renderTodaySpecial(null);
        assert.equal(banner.style.display, 'none', 'hidden again when the special is cleared');
        window.renderTodaySpecial({});
        assert.equal(banner.style.display, 'none', 'hidden for an empty record');
    } finally { window.close(); }
});

test('dine banner: owner-typed markup is shown as text, never injected as HTML', () => {
    const { window, document } = loadDinePage();
    try {
        window.renderTodaySpecial({ dish: '<img src=x onerror=alert(1)>', note: '<b>bold</b>' });
        const banner = document.getElementById('todaySpecialBanner');
        assert.equal(banner.style.display, 'block');
        assert.equal(banner.querySelectorAll('img').length, 0, 'no img element may be created from dish text');
        assert.equal(banner.querySelectorAll('b').length, 1, 'only the banner\'s own <b> for the dish');
        assert.ok(document.getElementById('todaySpecialDish').textContent.includes('<img'), 'dish shown literally as text');
    } finally { window.close(); }
});

test('dineTodayKey: returns local YYYY-MM-DD for a given date', () => {
    const { window } = loadDinePage();
    try {
        assert.equal(window.dineTodayKey(new Date(2026, 10, 25, 9, 30)), '2026-11-25');
        assert.equal(window.dineTodayKey(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
        assert.match(window.dineTodayKey(), /^\d{4}-\d{2}-\d{2}$/, 'today defaults to now');
    } finally { window.close(); }
});

// ---------------------------------------------------------------------------
// Part C — dine-owner.html: setting / clearing today's special.
// ---------------------------------------------------------------------------
function loadOwnerPage(opts) {
    const { html, script } = inlineScript(OWNER_HTML);
    const fb = (opts && opts.firebase) || makeFirebaseMock();
    const dom = new JSDOM(html, {
        url: 'https://availoservices.in/dine-owner.html',
        runScripts: 'outside-only',
        pretendToBeVisual: true,
        beforeParse(window) {
            window.firebase = fb.firebase;
        },
    });
    dom.window.eval(script);
    return { window: dom.window, document: dom.window.document, fb };
}

test('owner page: special box exists with dish + note inputs and save/clear buttons', () => {
    const { window, document } = loadOwnerPage();
    try {
        assert.ok(document.getElementById('specialDishInput'), 'dish input');
        assert.ok(document.getElementById('specialNoteInput'), 'note input');
        assert.ok(document.getElementById('specialCurrent'), 'current-special line');
        assert.ok(document.getElementById('specialMsg'), 'status message line');
        assert.ok(document.getElementById('specialCurrent').textContent.includes('ఇంకా పెట్టలేదు'), 'starts as "no special yet"');
    } finally { window.close(); }
});

test('owner save: writes dish + note + updatedAt under dineSpecial/khaleel/{today}', async () => {
    const { window, document, fb } = loadOwnerPage();
    try {
        document.getElementById('specialDishInput').value = 'చికెన్ దమ్ బిర్యానీ';
        document.getElementById('specialNoteInput').value = 'ఈరోజు మాత్రమే';
        window.saveTodaySpecial();
        await sleep(50);
        const today = localYmd();
        const writes = fb.writes.filter(w => w.op === 'set' && w.path === SPECIAL_PATH + '/' + today);
        assert.equal(writes.length, 1, 'one write to today\'s node: ' + JSON.stringify(fb.writes));
        assert.equal(writes[0].value.dish, 'చికెన్ దమ్ బిర్యానీ');
        assert.equal(writes[0].value.note, 'ఈరోజు మాత్రమే');
        assert.ok(typeof writes[0].value.updatedAt === 'number', 'updatedAt stamped');
        assert.ok(document.getElementById('specialCurrent').textContent.includes('చికెన్ దమ్ బిర్యానీ'), 'live listener shows the saved special');
        assert.ok(document.getElementById('specialMsg').textContent.includes('సేవ్ అయ్యింది'), 'success message: ' + document.getElementById('specialMsg').textContent);
    } finally { window.close(); }
});

test('owner save: empty dish writes nothing and shows the type-first error', async () => {
    const { window, document, fb } = loadOwnerPage();
    try {
        document.getElementById('specialDishInput').value = '   ';
        window.saveTodaySpecial();
        await sleep(50);
        assert.equal(fb.writes.filter(w => w.path.startsWith(SPECIAL_PATH)).length, 0, 'no write for an empty dish');
        assert.ok(document.getElementById('specialMsg').textContent.includes('వంట పేరు రాయండి'), 'error message: ' + document.getElementById('specialMsg').textContent);
    } finally { window.close(); }
});

test('owner clear: removes today\'s record and the current line goes back to "not set"', async () => {
    const { window, document, fb } = loadOwnerPage();
    try {
        const today = localYmd();
        fb.setPath(SPECIAL_PATH + '/' + today, { dish: 'చికెన్ దమ్ బిర్యానీ', note: '', updatedAt: Date.now() });
        assert.ok(document.getElementById('specialCurrent').textContent.includes('చికెన్ దమ్ బిర్యానీ'), 'seeded special shows');
        assert.equal(document.getElementById('specialDishInput').value, 'చికెన్ దమ్ బిర్యానీ', 'dish input prefilled from the live record');
        window.clearTodaySpecial();
        await sleep(50);
        const removes = fb.writes.filter(w => w.op === 'remove' && w.path === SPECIAL_PATH + '/' + today);
        assert.equal(removes.length, 1, 'one remove of today\'s node');
        assert.ok(document.getElementById('specialCurrent').textContent.includes('ఇంకా పెట్టలేదు'), 'back to "not set"');
    } finally { window.close(); }
});

// ---------------------------------------------------------------------------
// Part D — server (Code.gs mayuraAnswer_): the live block in the Gemini
// prompt. Same vm sandbox shape as mayura-conversational.test.js Part B.
// ---------------------------------------------------------------------------
const CODE_GS_SOURCE = fs.readFileSync(CODE_GS, 'utf8');

function loadCodeGs(opts) {
    opts = opts || {};
    const fetchCalls = [];
    const appendRowCalls = [];
    const sandbox = {
        console,
        JSON,
        PropertiesService: {
            getScriptProperties: () => ({
                getProperty: (k) => (k === 'GEMINI_API_KEY' ? (opts.key || null) : null),
            }),
        },
        UrlFetchApp: {
            fetch: (url, req) => {
                fetchCalls.push({ url, req });
                if (opts.fetchThrows) throw new Error('network down');
                return { getContentText: () => JSON.stringify(opts.gemini || {}) };
            },
        },
        ContentService: {
            MimeType: { JSON: 'application/json' },
            createTextOutput: (s) => {
                const out = { __json: s, setMimeType: () => out };
                return out;
            },
        },
        SpreadsheetApp: {
            getActiveSpreadsheet: () => ({
                getSheetByName: () => ({
                    getDataRange: () => ({ getDisplayValues: () => [] }),
                    appendRow: (row) => { appendRowCalls.push(row); },
                }),
                insertSheet: () => ({ appendRow: (row) => { appendRowCalls.push(row); } }),
            }),
        },
        LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
        DriveApp: {},
        Utilities: {},
    };
    vm.createContext(sandbox);
    vm.runInContext(CODE_GS_SOURCE, sandbox);
    return { sandbox, fetchCalls, appendRowCalls };
}

function doPostJson(sandbox, payload) {
    const out = sandbox.doPost({ postData: { contents: JSON.stringify(payload) } });
    return JSON.parse(out.__json);
}

function geminiPrompt(fetchCalls) {
    assert.equal(fetchCalls.length, 1, 'exactly one Gemini call, no server-side RTDB fetch');
    return JSON.parse(fetchCalls[0].req.payload).contents[0].parts[0].text;
}

test('server: prompt carries the live special and most-ordered dishes when live is fetched', () => {
    const { sandbox, fetchCalls } = loadCodeGs({
        key: 'TEST_KEY_123',
        gemini: { candidates: [{ content: { parts: [{ text: 'స్పెషల్ బిర్యానీ.' }] } }] },
    });
    const r = doPostJson(sandbox, {
        form: 'Mayura', question: 'ఈరోజు స్పెషల్ ఏంటి?', lang: 'te',
        live: {
            fetched: true,
            special: { dish: 'చికెన్ దమ్ బిర్యానీ', note: 'ఈరోజు మాత్రమే' },
            popular: [
                { id: 'biryani', name: 'చికెన్ బిర్యానీ', qty: 5, revenue: 1200 },
                { id: 'naan', name: 'బటర్ నాన్', qty: 2, revenue: 80 },
            ],
        },
    });
    assert.equal(r.ok, true);
    const prompt = geminiPrompt(fetchCalls);
    assert.ok(prompt.includes("Today's special: చికెన్ దమ్ బిర్యానీ"), 'special in prompt: ' + prompt);
    assert.ok(prompt.includes('ఈరోజు మాత్రమే'), 'note in prompt');
    assert.ok(prompt.includes('Most ordered today: చికెన్ బిర్యానీ (5 plates), బటర్ నాన్ (2 plates)'), 'popular in prompt: ' + prompt);
    assert.ok(prompt.includes('never invent a dish'), 'never-invent rule in the live block');
});

test('server: prompt says "none set today" and "no orders yet" when live is fetched but empty', () => {
    const { sandbox, fetchCalls } = loadCodeGs({
        key: 'TEST_KEY_123',
        gemini: { candidates: [{ content: { parts: [{ text: 'స్పెషల్ లేదు.' }] } }] },
    });
    const r = doPostJson(sandbox, {
        form: 'Mayura', question: 'ఈరోజు స్పెషల్ ఏంటి?', lang: 'te',
        live: { fetched: true, special: null, popular: [] },
    });
    assert.equal(r.ok, true);
    const prompt = geminiPrompt(fetchCalls);
    assert.ok(prompt.includes("Today's special: none set today."), 'none-set line: ' + prompt);
    assert.ok(prompt.includes('Most ordered today: no orders yet today.'), 'no-orders line: ' + prompt);
});

test('server: prompt says live data could not be checked when no live block is sent', () => {
    const { sandbox, fetchCalls } = loadCodeGs({
        key: 'TEST_KEY_123',
        gemini: { candidates: [{ content: { parts: [{ text: 'మెనూ ఉంది.' }] } }] },
    });
    const r = doPostJson(sandbox, { form: 'Mayura', question: 'మెనూ ఏంటి?', lang: 'te' });
    assert.equal(r.ok, true);
    const prompt = geminiPrompt(fetchCalls);
    assert.ok(prompt.includes('could not be checked'), 'unfetched line: ' + prompt);
    assert.ok(!prompt.includes("Today's special:"), 'no invented special in the prompt: ' + prompt);
});

// --- Runner -----------------------------------------------------------------

(async () => {
    let passed = 0;
    for (const { name, fn } of tests) {
        try {
            await fn();
            passed++;
            console.log('PASS  ' + name);
        } catch (e) {
            console.log('FAIL  ' + name);
            console.log('      ' + (e && e.message ? e.message.split('\n')[0] : e));
        }
    }
    console.log(`\n${passed}/${tests.length} tests passed`);
    process.exit(passed === tests.length ? 0 : 1);
})();
