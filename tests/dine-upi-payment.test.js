// Dine (dine.html) — UPI payment option on the order slip (22 Nov 2026).
// Feature: the order-confirm overlay offers a payment-method choice —
// "Cash" (default, current behaviour) vs "Pay via UPI". UPI opens a free
// UPI intent link (upi://pay?pa=...&pn=...&am=<2-decimals>&cu=INR&tn=<order-ref>)
// with the order total and the AV-DINE-YYYYMMDD-HHMMSS order ref, AFTER the
// WhatsApp order is sent, so the order is never lost if no UPI app opens.
// The chosen method is recorded in the Firebase dine order record AND in
// the WhatsApp KOT message ("*Payment:* UPI" / "*Payment:* Cash").
// AVAILO's own UPI ID is NOT on file yet (owner decision 25 Nov 2026:
// the payee is AVAILO, never the restaurant): HOTEL_UPI_ID /
// HOTEL_UPI_NAME default to EMPTY — while empty the UPI option is
// disabled with a trilingual "not set" note and orders fall back to
// Cash. Never invent a UPI ID, phone number, or payee name, and never
// set the restaurant's UPI ID here. No paid gateway, UPI intents only.
//
// Run:  node dine-upi-payment.test.js   (from this directory)
//        npm test                        (runs all test files)

const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const DINE_HTML = path.join(__dirname, '..', 'dine.html');
const DINE_ORDERS_PATH = 'availo-kitchen-v1/dineOrders/khaleel';

function inlineScript() {
    const html = fs.readFileSync(DINE_HTML, 'utf8');
    const m = html.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(m, 'inline script block not found in dine.html');
    return { html, script: m[1] };
}

// Fake Firebase RTDB (in-memory) — same model as dine-voice-tracker.test.js:
// a listener on a parent node fires when any child under it changes, and
// reading a parent returns an object of its children.
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
            update: (v) => { writes.push({ op: 'update', path, value: v }); setPath(path, Object.assign({}, getValue(path) || {}, v)); return Promise.resolve(); },
            remove: () => { writes.push({ op: 'remove', path }); setPath(path, null); return Promise.resolve(); },
            push: () => ({ key: 'mock-key' }),
        }),
    };
    const firebase = {
        apps: [],
        initializeApp: () => {},
        database: () => fakeDb,
    };
    return { firebase, store, writes, fire, setPath };
}

// Fresh page per test. No SpeechRecognition needed here; the voice mocks
// stay because sendOrderWhatsApp speaks its "order ready" prompt.
function loadPage(url, opts) {
    const { html, script } = inlineScript();
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

// Put one dish in the cart and open the confirm overlay. The item id is
// read from the rendered qty button (jsdom tests cannot reach top-level
// `const` bindings such as HOTEL_MENU through window.eval); the price
// comes from the order record builder, which reads the menu itself.
function openConfirmWithOneItem(window, document) {
    const btn = document.querySelector('.qty-btn');
    assert.ok(btn, 'a qty button must be rendered');
    const m = btn.getAttribute('onclick').match(/modifyItem\('([^']+)',/);
    assert.ok(m, 'qty button carries the item id: ' + btn.getAttribute('onclick'));
    window.modifyItem(m[1], 1);
    window.sendOrderWhatsApp();
    assert.equal(document.getElementById('orderConfirmOverlay').style.display, 'flex', 'confirm overlay must open');
    return window.buildDineOrderRecord('AV-DINE-TMP').total;
}

function findDineOrderWrite(writes) {
    return writes.find(w => w.op === 'set' && w.path.indexOf(DINE_ORDERS_PATH + '/AV-DINE-') === 0);
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// --- (1) UPI intent link builder -------------------------------------------

test('upi link: full link with payee, name, amount and order ref', () => {
    const { window } = loadPage();
    try {
        const link = window.buildUpiPayLink('khaleel@okhdfcbank', 'Khaleel Bhai Family Restaurant', 408.57, 'AV-DINE-20261121-220000');
        assert.equal(link, 'upi://pay?pa=khaleel%40okhdfcbank&pn=Khaleel%20Bhai%20Family%20Restaurant&am=408.57&cu=INR&tn=AV-DINE-20261121-220000');
    } finally { window.close(); }
});

test('upi link: amount always has exactly 2 decimals', () => {
    const { window } = loadPage();
    try {
        assert.ok(window.buildUpiPayLink('a@okhdfc', 'X', 408.5, 'R1').includes('&am=408.50&'), '408.5 -> 408.50');
        assert.ok(window.buildUpiPayLink('a@okhdfc', 'X', 100, 'R1').includes('&am=100.00&'), '100 -> 100.00');
        assert.ok(window.buildUpiPayLink('a@okhdfc', 'X', 56.19, 'R1').includes('&am=56.19&'), '56.19 stays 56.19');
        assert.ok(window.buildUpiPayLink('a@okhdfc', 'X', 408.567, 'R1').includes('&am=408.57&'), '408.567 rounds to 408.57');
    } finally { window.close(); }
});

test('upi link: missing or empty payee id -> null, never a broken link', () => {
    const { window } = loadPage();
    try {
        assert.equal(window.buildUpiPayLink('', 'X', 100, 'R1'), null, 'empty string');
        assert.equal(window.buildUpiPayLink('   ', 'X', 100, 'R1'), null, 'whitespace only');
        assert.equal(window.buildUpiPayLink(null, 'X', 100, 'R1'), null, 'null');
        assert.equal(window.buildUpiPayLink(undefined, 'X', 100, 'R1'), null, 'undefined');
    } finally { window.close(); }
});

test('upi link: invalid amount -> null', () => {
    const { window } = loadPage();
    try {
        assert.equal(window.buildUpiPayLink('a@okhdfc', 'X', 0, 'R1'), null, 'zero');
        assert.equal(window.buildUpiPayLink('a@okhdfc', 'X', -5, 'R1'), null, 'negative');
        assert.equal(window.buildUpiPayLink('a@okhdfc', 'X', NaN, 'R1'), null, 'NaN');
        assert.equal(window.buildUpiPayLink('a@okhdfc', 'X', 'abc', 'R1'), null, 'non-numeric');
    } finally { window.close(); }
});

test('upi link: no payee name -> link without pn param', () => {
    const { window } = loadPage();
    try {
        const link = window.buildUpiPayLink('a@okhdfc', '', 100, 'R1');
        assert.equal(link, 'upi://pay?pa=a%40okhdfc&am=100.00&cu=INR&tn=R1');
    } finally { window.close(); }
});

test('upi link: no order ref -> link without tn param', () => {
    const { window } = loadPage();
    try {
        const link = window.buildUpiPayLink('a@okhdfc', 'X', 100, '');
        assert.equal(link, 'upi://pay?pa=a%40okhdfc&pn=X&am=100.00&cu=INR');
    } finally { window.close(); }
});

test('upi link: order ref with special chars is encoded in tn', () => {
    const { window } = loadPage();
    try {
        const link = window.buildUpiPayLink('a@okhdfc', 'X', 100, 'AV-DINE-20261121-220000');
        assert.ok(link.includes('&tn=AV-DINE-20261121-220000'), 'hyphens pass through, ref intact: ' + link);
        const spaced = window.buildUpiPayLink('a@okhdfc', 'X', 100, 'REF 123');
        assert.ok(spaced.includes('&tn=REF%20123'), 'space in ref is encoded: ' + spaced);
    } finally { window.close(); }
});

// --- (2) Amount formatter + config gate -------------------------------------

test('formatUpiAmount: 2 decimals, null for zero/negative/NaN', () => {
    const { window } = loadPage();
    try {
        assert.equal(window.formatUpiAmount(408.5), '408.50');
        assert.equal(window.formatUpiAmount('408.5'), '408.50', 'numeric string works');
        assert.equal(window.formatUpiAmount(0), null);
        assert.equal(window.formatUpiAmount(-1), null);
        assert.equal(window.formatUpiAmount(NaN), null);
    } finally { window.close(); }
});

test('config gate: UPI payee is NOT configured by default (empty HOTEL_UPI_ID)', () => {
    // Source-level check: the defaults live in top-level `let` bindings,
    // which jsdom tests cannot read through window.eval.
    const src = fs.readFileSync(DINE_HTML, 'utf8');
    assert.ok(src.includes("let HOTEL_UPI_ID = '';"), 'no UPI ID on file — never invented');
    assert.ok(src.includes("let HOTEL_UPI_NAME = '';"), 'no payee name on file');
    const { window } = loadPage();
    try {
        assert.equal(window.upiPayeeConfigured(), false);
    } finally { window.close(); }
});

test('resolvePaymentMethod: UPI falls back to Cash while unconfigured', () => {
    const { window } = loadPage();
    try {
        assert.equal(window.resolvePaymentMethod('upi'), 'cash', 'upi requested but not configured');
        assert.equal(window.resolvePaymentMethod('cash'), 'cash');
        assert.equal(window.resolvePaymentMethod(undefined), 'cash');
        assert.equal(window.resolvePaymentMethod('UPI'), 'cash', 'case-sensitive: only exact "upi"');
    } finally { window.close(); }
});

// --- (3) WhatsApp payment line ----------------------------------------------

test('withPaymentLine: inserts "*Payment: UPI" before the time line', () => {
    const { window } = loadPage();
    try {
        const msg = '*AVAILO LIVE KOT*%0A*మొత్తం బిల్లు:* ₹408.57%0A*సమయం:* 10:00:00 PM';
        const out = window.withPaymentLine(msg, 'upi');
        assert.equal(out, '*AVAILO LIVE KOT*%0A*మొత్తం బిల్లు:* ₹408.57%0A*Payment:* UPI%0A*సమయం:* 10:00:00 PM');
    } finally { window.close(); }
});

test('withPaymentLine: Cash variant, and appends at end if the time marker is missing', () => {
    const { window } = loadPage();
    try {
        const msg = '*AVAILO LIVE KOT*%0A*మొత్తం బిల్లు:* ₹100.00%0A*సమయం:* 10:00:00 PM';
        assert.ok(window.withPaymentLine(msg, 'cash').includes('%0A*Payment:* Cash%0A*సమయం:*'), 'Cash line before time line');
        assert.equal(window.withPaymentLine('plain message', 'upi'), 'plain message%0A*Payment:* UPI', 'no marker -> appended');
    } finally { window.close(); }
});

// --- (4) Confirm overlay: default is Cash, UPI disabled while unconfigured --

test('overlay default: Cash active, UPI disabled with not-set note, confirm says Confirm & Send', () => {
    const { window, document } = loadPage();
    try {
        openConfirmWithOneItem(window, document);
        const cashBtn = document.getElementById('payCashBtn');
        const upiBtn = document.getElementById('payUpiBtn');
        const note = document.getElementById('payUpiNote');
        const confirmBtn = document.getElementById('confirmOrderBtn');
        assert.ok(cashBtn.classList.contains('active'), 'Cash is the default active choice');
        assert.ok(!upiBtn.classList.contains('active'), 'UPI is not active');
        assert.equal(upiBtn.disabled, true, 'UPI button disabled while no UPI ID is configured');
        assert.equal(note.style.display, 'block', 'not-set note is shown');
        assert.ok(note.innerText.includes('UPI ID'), 'note names the missing UPI ID: ' + note.innerText);
        assert.ok(confirmBtn.innerText.includes('నిర్ధారించి పంపండి'), 'confirm button stays Confirm & Send: ' + confirmBtn.innerText);
    } finally { window.close(); }
});

test('overlay: choosing UPI while unconfigured stays on Cash', () => {
    const { window, document } = loadPage();
    try {
        openConfirmWithOneItem(window, document);
        window.setPaymentMethod('upi');
        assert.ok(document.getElementById('payCashBtn').classList.contains('active'), 'falls back to Cash');
        assert.ok(!document.getElementById('payUpiBtn').classList.contains('active'), 'UPI never activates unconfigured');
        assert.ok(document.getElementById('confirmOrderBtn').innerText.includes('నిర్ధారించి పంపండి'), 'confirm button unchanged');
    } finally { window.close(); }
});

// --- (5) End-to-end: Cash default flow ---------------------------------------

test('cash flow: WhatsApp KOT says Payment: Cash and Firebase record has payment cash', () => {
    const fb = makeFirebaseMock();
    const { window, document, opened } = loadPage(null, { firebase: fb });
    try {
        openConfirmWithOneItem(window, document);
        window.confirmOrderSend();
        assert.equal(opened.length, 1, 'one WhatsApp window opens');
        assert.ok(opened[0].indexOf('https://wa.me/') === 0, 'WhatsApp order link: ' + opened[0]);
        assert.ok(opened[0].includes('*Payment:* Cash'), 'KOT carries Payment: Cash');
        const write = findDineOrderWrite(fb.writes);
        assert.ok(write, 'a dine order record must be written to Firebase');
        assert.equal(write.value.payment, 'cash', 'record payment is cash');
        assert.equal(write.value.status, 'received', 'record status unchanged');
        assert.equal(write.value.mode, 'dine-in', 'record mode unchanged');
        assert.ok(write.value.total > 0, 'record total present');
    } finally { window.close(); }
});

test('buildDineOrderRecord: payment defaults to cash when no method is passed', () => {
    const fb = makeFirebaseMock();
    const { window, document } = loadPage(null, { firebase: fb });
    try {
        openConfirmWithOneItem(window, document);
        const rec = window.eval('buildDineOrderRecord("AV-DINE-TEST-1")');
        assert.equal(rec.payment, 'cash');
        assert.equal(rec.table, '01', 'existing table field intact');
        assert.ok(Array.isArray(rec.items) && rec.items.length === 1, 'existing items intact');
        assert.equal(rec.status, 'received', 'existing status intact');
    } finally { window.close(); }
});

// --- (6) End-to-end: configured UPI flow ------------------------------------

test('upi flow: configured payee enables UPI, confirm button shows Pay amount via UPI', () => {
    const { window, document } = loadPage();
    try {
        window.setHotelUpiConfig('khaleel@okhdfcbank', 'Khaleel Bhai Family Restaurant');
        assert.equal(window.upiPayeeConfigured(), true);
        const price = openConfirmWithOneItem(window, document);
        window.setPaymentMethod('upi');
        const upiBtn = document.getElementById('payUpiBtn');
        assert.equal(upiBtn.disabled, false, 'UPI button enabled once configured');
        assert.ok(upiBtn.classList.contains('active'), 'UPI becomes active');
        assert.equal(document.getElementById('payUpiNote').style.display, 'none', 'not-set note hidden');
        const label = document.getElementById('confirmOrderBtn').innerText;
        assert.ok(label.includes('UPI'), 'confirm button becomes the UPI pay button: ' + label);
        assert.ok(label.includes(window.fmtPrice(price)), 'button shows the order total: ' + label);
    } finally { window.close(); }
});

test('upi flow: WhatsApp KOT says Payment: UPI and Firebase record has payment upi', () => {
    const fb = makeFirebaseMock();
    const { window, document, opened } = loadPage(null, { firebase: fb });
    try {
        window.setHotelUpiConfig('khaleel@okhdfcbank', 'Khaleel Bhai Family Restaurant');
        const price = openConfirmWithOneItem(window, document);
        window.setPaymentMethod('upi');
        window.confirmOrderSend();
        assert.equal(opened.length, 1, 'one WhatsApp window opens (UPI intent is a location navigation, not a window)');
        assert.ok(opened[0].indexOf('https://wa.me/') === 0, 'WhatsApp order still goes through first');
        assert.ok(opened[0].includes('*Payment:* UPI'), 'KOT carries Payment: UPI');
        const write = findDineOrderWrite(fb.writes);
        assert.ok(write, 'a dine order record must be written to Firebase');
        assert.equal(write.value.payment, 'upi', 'record payment is upi');
        assert.equal(write.value.total, Math.round(price * 100) / 100, 'record total matches the cart');
        // The exact intent link the confirm step builds for this order:
        const ref = write.path.split('/').pop();
        const link = window.buildUpiPayLink('khaleel@okhdfcbank', 'Khaleel Bhai Family Restaurant', price, ref);
        assert.equal(link, `upi://pay?pa=khaleel%40okhdfcbank&pn=Khaleel%20Bhai%20Family%20Restaurant&am=${window.formatUpiAmount(price)}&cu=INR&tn=${ref}`);
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
