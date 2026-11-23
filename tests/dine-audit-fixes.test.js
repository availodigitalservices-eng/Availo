// Availo pre-live audit fixes (23 Nov 2026) — regression tests.
//   M-D5  dine.html sendRating: double-tap rates twice (aggregate
//         {sum:10,count:2} from one tap) — submit button disables while
//         the write is in flight, re-enables on failure.
//   M-K5  dine.html table param: garbage ?table= (e.g. XYZ) was kept
//         verbatim in the KOT and the Firebase record — digits only,
//         else "01".
//   M-K6  dine.html sendOrderWhatsApp: threw TypeError on
//         chefNoteInput.value once the tracker screen replaced the menu.
//   M-K7  ?desk= not digit-sanitised on dine.html / smart.html /
//         host.html (ai-waiter.html already sanitises).
//   M-A4  dine.html loyaltyAddStamp: stamps accrued while no reward was
//         configured — now gated on loyaltyConfigured().
//
// Run:  node dine-audit-fixes.test.js   (from this directory)
//        npm test                        (runs all test files)

const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const DINE_HTML = path.join(__dirname, '..', 'dine.html');
const SMART_HTML = path.join(__dirname, '..', 'smart.html');
const HOST_HTML = path.join(__dirname, '..', 'host.html');
const DINE_ORDERS_PATH = 'availo-kitchen-v1/dineOrders/khaleel';
const RATINGS_PATH = 'availo-kitchen-v1/ratings/khaleel';
const REVIEWS_PATH = 'availo-kitchen-v1/reviews/khaleel';
const CHICKEN_65 = 'NONVEG_STARTERS-chicken-65';
const BUTTER_MILK = 'VEG_BEVERAGES-butter-milk';

// Extract the single inline <script> (no src) from a page.
function inlineScript(file) {
    const html = fs.readFileSync(file, 'utf8');
    const m = html.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(m, 'inline script block not found in ' + file);
    return { html, script: m[1] };
}

// Fake Firebase RTDB (in-memory) — same model as
// tests/dine-ratings-reviews.test.js: listeners on a parent fire when any
// child under it changes; push() generates a key; transaction() is
// read-modify-write (used for the rating aggregate). With
// opts.failWrites, every write rejects, to exercise the fail-open path.
function makeFirebaseMock(opts) {
    const fail = !!(opts && opts.failWrites);
    const store = {};
    const listeners = {};
    const writes = [];
    let pushN = 0;
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
    function makeRef(path) {
        return {
            on: (evt, cb) => {
                (listeners[path] = listeners[path] || []).push(cb);
                cb({ val: () => getValue(path) });
            },
            off: () => {},
            set: (v) => {
                writes.push({ op: 'set', path, value: v });
                if (fail) return Promise.reject(new Error('offline'));
                setPath(path, v);
                return Promise.resolve();
            },
            update: (v) => {
                writes.push({ op: 'update', path, value: v });
                if (fail) return Promise.reject(new Error('offline'));
                setPath(path, Object.assign({}, getValue(path) || {}, v));
                return Promise.resolve();
            },
            remove: () => {
                writes.push({ op: 'remove', path });
                if (fail) return Promise.reject(new Error('offline'));
                setPath(path, null);
                return Promise.resolve();
            },
            push: () => {
                pushN++;
                const key = 'mock-key-' + pushN;
                return {
                    key,
                    set: (v) => {
                        writes.push({ op: 'set', path: path + '/' + key, value: v });
                        if (fail) return Promise.reject(new Error('offline'));
                        setPath(path + '/' + key, v);
                        return Promise.resolve();
                    },
                };
            },
            transaction: (fn) => {
                if (fail) return Promise.reject(new Error('offline'));
                const cur = getValue(path);
                const next = fn(cur);
                if (next === undefined) return Promise.resolve({ committed: false });
                writes.push({ op: 'transaction', path, value: next });
                setPath(path, next);
                return Promise.resolve({ committed: true, snapshot: { val: () => next } });
            },
            once: (evt) => Promise.resolve({ val: () => getValue(path) }),
        };
    }
    const fakeDb = { ref: makeRef };
    const firebase = {
        apps: [],
        initializeApp: () => {},
        database: () => fakeDb,
    };
    return { firebase, store, writes, setPath, getValue };
}

// Fresh page per test, with the speech / window.open / Sheets mocks the
// Dine pages need. `file` is one of DINE_HTML / SMART_HTML / HOST_HTML.
function loadPage(file, url, opts) {
    const { html, script } = inlineScript(file);
    const opened = [];
    const sheetCalls = [];
    const spoken = [];
    const fb = (opts && opts.firebase) || null;
    const dom = new JSDOM(html, {
        url: url || 'https://availoservices.in/dine.html',
        runScripts: 'outside-only',
        pretendToBeVisual: true,
        beforeParse(window) {
            if (fb) window.firebase = fb.firebase;
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
            window.open = (u) => { opened.push(u); return null; };
            window.alert = () => {};
            window.sendToSheet = (...args) => { sheetCalls.push(args); };
        },
    });
    dom.window.eval(script);
    return { window: dom.window, document: dom.window.document, opened, sheetCalls, spoken };
}

function loadDine(url, opts) { return loadPage(DINE_HTML, url, opts); }

// Drive one dine-in order (one Chicken 65) through to WhatsApp confirm;
// returns the Firebase tracker record written for it.
function placeOneDineOrder(window, document) {
    window.enterMenu();
    window.modifyItem(CHICKEN_65, 1);
    window.sendOrderWhatsApp();
    window.confirmOrderSend();
}

function findDineOrderWrite(writes) {
    return writes.find(w => w.op === 'set' && w.path.indexOf(DINE_ORDERS_PATH + '/AV-DINE-') === 0);
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// --- M-D5: double-tap rating -----------------------------------------------

test('M-D5: two concurrent sendRating() calls write exactly one aggregate + one review', async () => {
    const fb = makeFirebaseMock();
    const { window, document } = loadDine(null, { firebase: fb });
    try {
        window.openRateForm(CHICKEN_65);
        window.pickRateStars(5);
        const p1 = window.sendRating();
        const p2 = window.sendRating();
        const results = await Promise.all([p1, p2]);
        assert.deepEqual(results, [true, false], 'exactly one send succeeds, the second bails out');
        const txns = fb.writes.filter(w => w.op === 'transaction' && w.path === RATINGS_PATH + '/' + CHICKEN_65);
        assert.equal(txns.length, 1, 'one transaction only, not two');
        // JSON round-trip: the record was built inside the jsdom realm,
        // whose Object.prototype differs from Node's.
        assert.deepEqual(JSON.parse(JSON.stringify(txns[0].value)), { sum: 5, count: 1 }, 'aggregate is one 5-star rating, not {sum:10,count:2}');
        const reviews = fb.writes.filter(w => w.op === 'set' && w.path.indexOf(REVIEWS_PATH + '/') === 0);
        assert.equal(reviews.length, 1, 'one review record only');
        assert.equal(reviews[0].value.stars, 5, 'the one review is 5 stars');
    } finally { window.close(); }
});

test('M-D5: submit button disables while sending and re-enables on failure', async () => {
    const fb = makeFirebaseMock({ failWrites: true });
    const { window, document } = loadDine(null, { firebase: fb });
    try {
        window.openRateForm(BUTTER_MILK);
        window.pickRateStars(5);
        const btn = document.getElementById('rateSubmitBtn');
        assert.ok(btn, 'submit button must exist');
        assert.equal(btn.disabled, false, 'button starts enabled');
        const p = window.sendRating();
        assert.equal(btn.disabled, true, 'button disabled while the write is in flight');
        const ok = await p;
        assert.equal(ok, false, 'failed submit reports false');
        assert.equal(btn.disabled, false, 'button re-enabled on failure so the customer can retry');
        assert.equal(document.getElementById('rateFailNote').style.display, 'block', 'retry note shown');
        assert.equal(document.getElementById('rateOverlay').style.display, 'flex', 'form stays open so nothing is lost');
        // Reopening the form after a successful submit re-arms the button.
        const fb2 = makeFirebaseMock();
        const p2 = loadDine(null, { firebase: fb2 });
        try {
            p2.window.openRateForm(CHICKEN_65);
            p2.window.pickRateStars(4);
            assert.equal(await p2.window.sendRating(), true, 'first submit succeeds');
            p2.window.openRateForm(BUTTER_MILK);
            assert.equal(p2.document.getElementById('rateSubmitBtn').disabled, false, 'button re-armed when the form reopens');
        } finally { p2.window.close(); }
    } finally { window.close(); }
});

// --- M-K5: table param ------------------------------------------------------

test('M-K5: ?table=XYZ falls back to "01" in the record and the KOT', () => {
    const fb = makeFirebaseMock();
    const { window, document, opened } = loadDine('https://availoservices.in/dine.html?table=XYZ', { firebase: fb });
    try {
        placeOneDineOrder(window, document);
        const write = findDineOrderWrite(fb.writes);
        assert.ok(write, 'a tracker record must be written');
        assert.equal(write.value.table, '01', 'garbage table falls back to 01 in the record');
        assert.equal(opened.length, 1, 'WhatsApp opens once');
        assert.ok(opened[0].includes('*టేబుల్:* 01'), 'KOT carries table 01, not XYZ: ' + opened[0].slice(0, 120));
        assert.ok(!opened[0].includes('XYZ'), 'XYZ appears nowhere in the WhatsApp message');
    } finally { window.close(); }
});

test('M-K5: ?table=07 stays "07", missing ?table= is "01", "Table 07" normalises to "07"', () => {
    const fb = makeFirebaseMock();
    const cases = [
        ['https://availoservices.in/dine.html?table=07', '07'],
        ['https://availoservices.in/dine.html', '01'],
        ['https://availoservices.in/dine.html?table=Table%2007', '07'],
        ['https://availoservices.in/dine.html?table=12A', '12'],
    ];
    for (const [url, expected] of cases) {
        const fbCase = makeFirebaseMock();
        const { window, document, opened } = loadDine(url, { firebase: fbCase });
        try {
            placeOneDineOrder(window, document);
            const write = findDineOrderWrite(fbCase.writes);
            assert.ok(write, 'a tracker record must be written for ' + url);
            assert.equal(write.value.table, expected, url + ' -> table ' + expected);
            assert.ok(opened[0].includes('*టేబుల్:* ' + expected), 'KOT carries table ' + expected + ' for ' + url);
        } finally { window.close(); }
    }
    void fb;
});

// --- M-K6: chef note input gone ---------------------------------------------

test('M-K6: sendOrderWhatsApp works when chefNoteInput is absent (no throw)', () => {
    const { window, document } = loadDine('https://availoservices.in/dine.html?table=05');
    try {
        window.enterMenu();
        window.modifyItem(CHICKEN_65, 1);
        // Simulate the tracker screen having replaced the menu: the chef
        // note input is gone from the DOM.
        document.getElementById('chefNoteInput').remove();
        assert.equal(document.getElementById('chefNoteInput'), null, 'chef note input removed');
        assert.doesNotThrow(() => window.sendOrderWhatsApp(), 'must not throw without chefNoteInput');
        assert.equal(document.getElementById('orderConfirmOverlay').style.display, 'flex', 'confirm overlay still opens');
    } finally { window.close(); }
});

// --- M-K7: desk param sanitised on all three pages --------------------------

test('M-K7: dine ?desk= with non-digits opens WhatsApp to the clean number', () => {
    const fb = makeFirebaseMock();
    const { window, document, opened } = loadDine('https://availoservices.in/dine.html?table=05&desk=%2B91-99661-57369x', { firebase: fb });
    try {
        placeOneDineOrder(window, document);
        assert.equal(opened.length, 1, 'WhatsApp opens once');
        assert.ok(opened[0].startsWith('https://wa.me/919966157369?text='), 'desk sanitised to 919966157369: ' + opened[0].slice(0, 60));
    } finally { window.close(); }
});

test('M-K7: dine ?desk= that sanitises to empty falls back to the default number', () => {
    const fb = makeFirebaseMock();
    const { window, document, opened } = loadDine('https://availoservices.in/dine.html?table=05&desk=abc', { firebase: fb });
    try {
        placeOneDineOrder(window, document);
        assert.equal(opened.length, 1, 'WhatsApp opens once');
        assert.ok(opened[0].startsWith('https://wa.me/919966157369?text='), 'empty-after-sanitise falls back to the default: ' + opened[0].slice(0, 60));
    } finally { window.close(); }
});

test('M-K7: smart ?desk= with non-digits opens WhatsApp to the clean number', () => {
    const { window, document, opened } = loadPage(SMART_HTML, 'https://availoservices.in/smart.html?desk=91-99661-57369!');
    try {
        window.modifyItem('vegBiryani', 1);
        window.sendOrderWhatsApp();
        assert.equal(opened.length, 1, 'WhatsApp opens once');
        assert.ok(opened[0].startsWith('https://wa.me/919966157369?text='), 'desk sanitised to 919966157369: ' + opened[0].slice(0, 60));
    } finally { window.close(); }
});

test('M-K7: host ?desk= with non-digits opens WhatsApp to the clean number', () => {
    const { window, document, opened } = loadPage(HOST_HTML, 'https://availoservices.in/host.html?desk=%28919966157369%29');
    try {
        window.updateQty('dosa', 1);
        window.dispatchToWhatsApp();
        assert.equal(opened.length, 1, 'WhatsApp opens once');
        assert.ok(opened[0].startsWith('https://wa.me/919966157369?text='), 'desk sanitised to 919966157369: ' + opened[0].slice(0, 60));
    } finally { window.close(); }
});

// --- M-A4: loyalty stamps gated on a configured reward -----------------------

test('M-A4: no stamps accrue when no reward is configured; stamps accrue once one is', () => {
    const fb = makeFirebaseMock();
    const { window, document } = loadDine(null, { firebase: fb });
    try {
        assert.equal(window.loyaltyConfigured(), false, 'no reward configured by default');
        assert.equal(window.loyaltyAddStamp(), 0, 'addStamp with no reward returns 0');
        assert.equal(window.loyaltyStamps(), 0, 'no stamp accrued');
        assert.equal(window.localStorage.getItem('availo_loyalty_stamps'), null, 'nothing stored while unconfigured');
        // A confirmed order also earns nothing while unconfigured.
        placeOneDineOrder(window, document);
        assert.equal(window.loyaltyStamps(), 0, 'confirmed order earns no stamp while unconfigured');
        // Once a reward is configured, stamps accrue normally.
        window.setLoyaltyReward({ stamps: 5, text: 'Free Butter Milk' });
        assert.equal(window.loyaltyConfigured(), true, 'reward configured');
        assert.equal(window.loyaltyAddStamp(), 1, 'first stamp accrues once configured');
        assert.equal(window.loyaltyStamps(), 1, 'stamp count is 1');
        assert.equal(window.localStorage.getItem('availo_loyalty_stamps'), '1', 'stamp stored');
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
