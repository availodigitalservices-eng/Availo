// Dine analytics audit fixes (23 Nov 2026, PRE-LIVE-AUDIT-2026-11-23 §4):
//   M-A1 — weekly report card had no WhatsApp share / print button
//          (daily card only). Added the same row + whatsappWeeklyText().
//   M-A2 — computeDashboard counted owner-hidden reviews in reviewCount
//          while the menu / daily rating exclude them. Now only !hidden.
//   M-A3 — Firebase unreachable (SDK present) left every section stuck
//          on "…" forever: the listeners' error callbacks were empty and
//          analyticsLoaded was set true only on success. Error (and
//          offline) now sets analyticsLoaded + re-renders, so the page
//          shows its empty states instead.
//
// Run:  node analytics-audit-fixes.test.js   (from this directory)
//        npm test                            (runs all test files)

const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const ANALYTICS_HTML = path.join(__dirname, '..', 'analytics.html');
const DINE_ORDERS_PATH = 'availo-kitchen-v1/dineOrders/khaleel';
const RATINGS_PATH = 'availo-kitchen-v1/ratings/khaleel';
const REVIEWS_PATH = 'availo-kitchen-v1/reviews/khaleel';
const TABLE_BOOKINGS_PATH = 'availo-kitchen-v1/tableBookings/khaleel';
const BUTTER_MILK = 'VEG_BEVERAGES-butter-milk';
const CHICKEN_65 = 'NONVEG_STARTERS-chicken-65';
const PANNER_65 = 'VEG_STARTERS-panner-65';

// Extract the single inline <script> (no src) from a page.
function inlineScript(file) {
    const html = fs.readFileSync(file, 'utf8');
    const m = html.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(m, 'inline script block not found in ' + file);
    return { html, script: m[1] };
}

// Fake Firebase RTDB (in-memory) — same model as dine-analytics.test.js:
// a listener on a parent node fires when any child under it changes, and
// reading a parent returns an object of its children. Children stored
// under sequential numeric keys (0, 1, 2, ...) come back as a real Array.
function makeFirebaseMock() {
    const store = {};
    const listeners = {};
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
        if (!found) return null;
        const keys = Object.keys(out);
        if (keys.length && keys.every(k => /^\d+$/.test(k))) {
            const idx = keys.map(Number).sort((a, b) => a - b);
            if (idx[0] === 0 && idx.every((v, i) => v === i)) return idx.map(i => out[String(i)]);
        }
        return out;
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
            set: (v) => { setPath(path, v); return Promise.resolve(); },
            update: (v) => { setPath(path, Object.assign({}, getValue(path) || {}, v)); return Promise.resolve(); },
            remove: () => { setPath(path, null); return Promise.resolve(); },
            push: () => ({ key: 'mock-key' }),
        }),
    };
    const firebase = {
        apps: [],
        initializeApp: () => {},
        database: () => fakeDb,
    };
    return { firebase, store, setPath };
}

// M-A3 mock 1: the SDK is present and .info/connected says connected,
// but every data read fails — the listeners' error callbacks fire.
function makeFailingFirebaseMock() {
    const fakeDb = {
        ref: (path) => ({
            on: (evt, cb, errCb) => {
                if (path === '.info/connected') cb({ val: () => true });
                else if (errCb) errCb(new Error('permission denied'));
                else cb({ val: () => null });
            },
            off: () => {},
        }),
    };
    const firebase = {
        apps: [],
        initializeApp: () => {},
        database: () => fakeDb,
    };
    return { firebase };
}

// M-A3 mock 2: the SDK is present but the client is offline —
// .info/connected fires false and the data listeners never fire at all
// (neither success nor error).
function makeOfflineFirebaseMock() {
    const fakeDb = {
        ref: (path) => ({
            on: (evt, cb) => {
                if (path === '.info/connected') cb({ val: () => false });
                // Data listeners: registered, never called.
            },
            off: () => {},
        }),
    };
    const firebase = {
        apps: [],
        initializeApp: () => {},
        database: () => fakeDb,
    };
    return { firebase };
}

// Fresh analytics page per test. `seed` runs against the mock BEFORE the
// page loads, so the listeners fire with the seeded data on registration.
function loadAnalyticsPage(opts) {
    const { html, script } = inlineScript(ANALYTICS_HTML);
    const fb = (opts && opts.firebase) || makeFirebaseMock();
    if (opts && opts.seed) opts.seed(fb);
    if (fb.setPath) fb.setPath('.info/connected', true);
    const dom = new JSDOM(html, {
        url: 'https://availoservices.in/analytics.html',
        runScripts: 'outside-only',
        pretendToBeVisual: true,
        beforeParse(window) {
            window.firebase = fb.firebase;
        },
    });
    dom.window.eval(script);
    return { window: dom.window, document: dom.window.document, fb };
}

function order(o) {
    return Object.assign({
        table: '1',
        items: [],
        total: 0,
        status: 'received',
        createdAt: Date.now(),
        mode: 'dine-in',
        payment: 'cash',
    }, o);
}

// Same demo seed as dine-analytics.test.js: 1 order today, 1 two days
// ago, 1 forty days ago; 5 visible reviews; 4 bookings.
function seedDemoData(fb) {
    const NOW = Date.now();
    const DAY = 864e5;
    fb.setPath(DINE_ORDERS_PATH + '/AV-DINE-TODAY', order({
        createdAt: NOW,
        items: [
            { id: BUTTER_MILK, name: 'Butter Milk', qty: 2, price: 56.19 },
            { id: CHICKEN_65, name: 'Chicken 65', qty: 1, price: 408.57 },
        ],
        total: 470.95, coupon: 'AVAILO10', discount: 50,
    }));
    fb.setPath(DINE_ORDERS_PATH + '/AV-DINE-2DAYS', order({
        createdAt: NOW - 2 * DAY,
        items: [{ id: PANNER_65, name: 'Panner 65', qty: 3, price: 418.10 }],
        total: 1254.30,
    }));
    fb.setPath(DINE_ORDERS_PATH + '/AV-DINE-40DAYS', order({
        createdAt: NOW - 40 * DAY,
        items: [{ id: 'BIRYANI_VEG-egg-biryani', name: 'Egg Biryani', qty: 1, price: 351.43 }],
        total: 351.43,
    }));
    fb.setPath(RATINGS_PATH + '/' + BUTTER_MILK, { sum: 9, count: 2 });
    fb.setPath(RATINGS_PATH + '/' + CHICKEN_65, { sum: 14, count: 3 });
    for (let i = 1; i <= 5; i++) {
        fb.setPath(REVIEWS_PATH + '/r' + i, { itemId: BUTTER_MILK, stars: 5, text: '', name: '', createdAt: NOW - i * 1000 });
    }
    fb.setPath(TABLE_BOOKINGS_PATH + '/AV-TABLE-1', { date: '2026-11-21', slot: '12:00', table: 'T1', partySize: 4, status: 'booked', createdAt: NOW });
    fb.setPath(TABLE_BOOKINGS_PATH + '/AV-TABLE-2', { date: '2026-11-21', slot: '19:00', table: 'T2', partySize: 2, status: 'booked', createdAt: NOW - 60000 });
    fb.setPath(TABLE_BOOKINGS_PATH + '/AV-TABLE-3', { date: '2026-11-19', slot: '13:00', table: 'T3', partySize: 6, status: 'seated', createdAt: NOW - 2 * DAY });
    fb.setPath(TABLE_BOOKINGS_PATH + '/AV-TABLE-4', { date: '2026-10-12', slot: '12:00', table: 'T4', partySize: 2, status: 'booked', createdAt: NOW - 40 * DAY });
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// --- M-A1: weekly WhatsApp text ----------------------------------------------

test('M-A1 whatsappWeeklyText: Telugu totals + one line per day, honest empty week', () => {
    const { window } = loadAnalyticsPage();
    try {
        const NOW = new Date(2026, 10, 21, 15, 30, 0).getTime();
        const at = (y, mo, d, h) => new Date(y, mo, d, h || 0).getTime();
        const w = window.weeklyReport([
            order({ createdAt: at(2026, 10, 21, 12), total: 470.95 }),
            order({ createdAt: at(2026, 10, 19, 12), total: 1254.30 }),
            order({ createdAt: at(2026, 10, 15, 0, 0), total: 100 }),
            order({ createdAt: at(2026, 10, 14, 23, 59), total: 999 }), // 7 days ago — out
        ], NOW);
        const te = window.whatsappWeeklyText(w);
        assert.ok(te.includes('15 Nov – 21 Nov'), 'date range in text, got: ' + te);
        assert.ok(te.includes('3'), 'total orders 3');
        assert.ok(te.includes('₹1,825.25'), 'total revenue 470.95 + 1254.30 + 100');
        assert.ok(te.includes('19 Nov'), 'per-day line for 19 Nov');
        assert.ok(te.includes('₹1,254.30'), 'per-day revenue for 19 Nov');
        assert.ok(te.includes('AVAILO'), 'Avilo-only label in text');
        window.setAnalyticsLang('en');
        const en = window.whatsappWeeklyText(w);
        assert.ok(en.includes('Weekly report'), 'English heading');
        assert.ok(en.includes('Total orders'), 'English totals label');
        assert.ok(en.includes('₹1,825.25'));
        // Empty week shares honestly — 0 orders, ₹0.00 every day.
        const empty = window.weeklyReport([], NOW);
        const emptyTxt = window.whatsappWeeklyText(empty);
        assert.ok(emptyTxt.includes('0'), 'empty week says 0 orders');
        assert.ok(emptyTxt.includes('₹0.00'), 'empty week says ₹0.00');
        assert.ok(!emptyTxt.includes('Butter Milk'), 'no dish invented for an empty week');
    } finally { window.close(); }
});

test('M-A1 DOM: weekly card has share + print buttons; share text is the weekly report', () => {
    const { document, window } = loadAnalyticsPage({ seed: seedDemoData });
    try {
        const waWeeklyBtn = document.getElementById('waShareWeeklyBtn');
        assert.ok(waWeeklyBtn, 'weekly WhatsApp share button exists');
        const href = waWeeklyBtn.getAttribute('href');
        assert.ok(href.startsWith('https://wa.me/?text='), 'weekly share link is wa.me, got: ' + href);
        const shared = decodeURIComponent(href.slice('https://wa.me/?text='.length));
        assert.ok(shared.includes('₹1,725.25'), 'shared text has the weekly total revenue (470.95 + 1254.30), got: ' + shared);
        assert.ok(shared.includes(window.dayLabel(Date.now())), 'shared text has a per-day line for today');
        assert.ok(shared.includes('AVAILO'), 'shared text says Availo orders only');
        // The daily share button still works alongside it.
        const waDailyBtn = document.getElementById('waShareBtn');
        assert.ok(waDailyBtn, 'daily share button still exists');
        const dailyShared = decodeURIComponent(waDailyBtn.getAttribute('href').slice('https://wa.me/?text='.length));
        assert.ok(dailyShared.includes('₹470.95'), 'daily share text still has today’s revenue');
        assert.ok(!shared.includes('₹470.95') || shared.includes('₹1,725.25'), 'weekly text is the weekly report, not the daily one');
        // Both report cards now have a print button calling window.print.
        const printBtns = document.querySelectorAll('.print-btn');
        assert.equal(printBtns.length, 2, 'daily + weekly cards both have a print button');
        printBtns.forEach(function (b) {
            assert.ok((b.getAttribute('onclick') || '').includes('window.print'), 'print button calls window.print');
        });
    } finally { window.close(); }
});

// --- M-A2: hidden reviews excluded from the review count ----------------------

test('M-A2 computeDashboard: reviewCount counts only visible (!hidden) reviews', () => {
    const { window } = loadAnalyticsPage();
    try {
        const NOW = Date.now();
        const reviews = [
            { stars: 5 }, { stars: 4, hidden: true },
            { stars: 5, hidden: true }, { stars: 3 },
        ];
        const d = window.computeDashboard([], {}, reviews, [], 'today', NOW);
        assert.equal(d.reviewCount, 2, '2 visible of 4 reviews');
        const allHidden = window.computeDashboard([], {}, [
            { stars: 5, hidden: true }, { stars: 4, hidden: true },
        ], [], 'today', NOW);
        assert.equal(allHidden.reviewCount, 0, 'all hidden -> 0, not 2');
        const noneHidden = window.computeDashboard([], {}, [{ stars: 5 }, { stars: 4 }], [], 'today', NOW);
        assert.equal(noneHidden.reviewCount, 2, 'no hidden flag -> all counted');
    } finally { window.close(); }
});

test('M-A2 DOM: ratings section shows only the visible review count', () => {
    const { document, window } = loadAnalyticsPage({
        seed: (fb) => {
            const NOW = Date.now();
            fb.setPath(RATINGS_PATH + '/' + BUTTER_MILK, { sum: 23, count: 5 });
            fb.setPath(REVIEWS_PATH + '/r1', { itemId: BUTTER_MILK, stars: 5, text: '', name: '', createdAt: NOW - 1000 });
            fb.setPath(REVIEWS_PATH + '/r2', { itemId: BUTTER_MILK, stars: 5, text: '', name: '', createdAt: NOW - 2000, hidden: true });
            fb.setPath(REVIEWS_PATH + '/r3', { itemId: BUTTER_MILK, stars: 4, text: '', name: '', createdAt: NOW - 3000 });
            fb.setPath(REVIEWS_PATH + '/r4', { itemId: BUTTER_MILK, stars: 5, text: '', name: '', createdAt: NOW - 4000, hidden: true });
            fb.setPath(REVIEWS_PATH + '/r5', { itemId: BUTTER_MILK, stars: 4, text: '', name: '', createdAt: NOW - 5000, hidden: true });
        },
    });
    try {
        const sub = document.querySelector('#ratingsSection .rating-sub');
        assert.ok(sub, 'ratings sub-line exists');
        assert.ok(sub.textContent.includes('2 రివ్యూలు'), '2 visible reviews counted, got: ' + sub.textContent);
        assert.ok(!sub.textContent.includes('5 రివ్యూలు'), 'hidden reviews are not counted');
    } finally { window.close(); }
});

// --- M-A3: Firebase failure / offline shows empty states, never "…" ----------

const SECTION_IDS = ['ordersSection', 'topSection', 'ratingsSection', 'couponsSection',
    'bookingsSection', 'peakSection', 'splitSection', 'dailySection', 'weeklySection',
    'topDishSection', 'mostLikedSection'];

function assertNoSectionStuckOnEllipsis(document) {
    for (const id of SECTION_IDS) {
        const el = document.getElementById(id);
        assert.ok(el, id + ' exists');
        assert.ok(!el.textContent.includes('…'), id + ' still stuck on "…", got: ' + el.textContent);
    }
}

test('M-A3 failing Firebase: every section shows its empty state, none stuck on "…"', () => {
    const { document, window } = loadAnalyticsPage({ firebase: makeFailingFirebaseMock() });
    try {
        assertNoSectionStuckOnEllipsis(document);
        for (const id of ['ordersSection', 'topSection', 'ratingsSection', 'couponsSection', 'bookingsSection', 'peakSection', 'splitSection']) {
            assert.ok(document.getElementById(id).textContent.includes('ఇంకా డేటా లేదు'), id + ' shows the empty state');
        }
        assert.ok(document.getElementById('topDishSection').textContent.includes('ఇంకా ఆర్డర్లు లేవు'), 'hero top-dish empty state');
        assert.ok(document.getElementById('mostLikedSection').textContent.includes('ఇంకా రేటింగ్స్ లేవు'), 'hero most-liked empty state');
        // Daily / weekly reports render their (honest zero) rows, not "…".
        assert.ok(document.getElementById('dailySection').textContent.includes('₹0.00'), 'daily report shows ₹0.00');
        assert.equal(document.querySelectorAll('#weeklySection .report-row').length, 7, 'weekly still lists all 7 days');
        assert.ok(document.getElementById('connStatus').textContent.includes('కనెక్ట్ అయ్యింది'), 'conn line still says connected (the failure is the reads, not the socket)');
    } finally { window.close(); }
});

test('M-A3 offline Firebase: .info/connected false, listeners never fire, still no "…"', () => {
    const { document, window } = loadAnalyticsPage({ firebase: makeOfflineFirebaseMock() });
    try {
        assertNoSectionStuckOnEllipsis(document);
        assert.ok(document.getElementById('ordersSection').textContent.includes('ఇంకా డేటా లేదు'), 'orders empty state while offline');
        assert.ok(document.getElementById('connStatus').textContent.includes('కనెక్ట్ కాలేదు'), 'conn line says not connected');
    } finally { window.close(); }
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
