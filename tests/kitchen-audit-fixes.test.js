// Kitchen audit fixes — regression tests (23 Nov 2026, PRE-LIVE-AUDIT §4).
// M-K1: "Clear all" must ask confirm() first — no delete when the staff
//   says no, both Firebase nodes removed only when they say yes.
// M-K3: orders arriving during the kitchen page (re)load must not be
//   silent — a 'received' order created within the last 60 s in the first
//   snapshot gets exactly ONE buzz + ONE summary announcement for the
//   whole batch (a 15-order rush is still 1 buzz + 1 announcement).
//
// Harness: kitchen.html loaded in jsdom with an in-memory Firebase mock
// (same model as gate-kitchen-chain.test.js, plus a deferred `on` so the
// test can turn sound on before firing the first snapshot, and
// orderByKey().limitToLast().once() which kitchen.html's history loader
// uses). One buzz = one buzzTimes(3) call = 3 beeps; the fake
// AudioContext counts each beep (oscillator start).
//
// Run:  node kitchen-audit-fixes.test.js   (from this directory)
//        npm test                          (runs all test files)

const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const KITCHEN_HTML = path.join(__dirname, '..', 'kitchen.html');
const DINE_ORDERS_PATH = 'availo-kitchen-v1/dineOrders/khaleel';
const ORDERS_PATH = 'availo-kitchen-v1/orders';
const REFILLS_PATH = 'availo-kitchen-v1/refills';

function inlineScript(file) {
    const html = fs.readFileSync(file, 'utf8');
    const m = html.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(m, 'inline script block not found in ' + file);
    return { html, script: m[1] };
}

// Fake Firebase RTDB (in-memory) — same model as
// gate-kitchen-chain.test.js, except `on` does NOT fire immediately:
// listeners are stored and fired by fb.fire(path), so the test controls
// exactly when the first snapshot arrives. Adds orderByKey().limitToLast()
// with a forEach-capable snapshot, which kitchen.html's history loader
// needs.
function makeFirebaseMock() {
    const store = {};
    const listeners = {};
    const writes = [];
    function getValue(p) {
        if (p in store) return store[p];
        const prefix = p ? p + '/' : '';
        const out = {};
        let found = false;
        for (const key of Object.keys(store)) {
            if (!key.startsWith(prefix)) continue;
            const rest = key.slice(prefix.length);
            const first = rest.split('/')[0];
            if (!(first in out)) {
                out[first] = rest.indexOf('/') === -1 ? store[key] : getValue(p + '/' + first);
            }
            found = true;
        }
        if (!found) return null;
        const keys = Object.keys(out);
        if (keys.length && keys.every((k, i) => String(i) === k)) return keys.map(k => out[k]);
        return out;
    }
    function makeSnap(val) {
        return {
            val: () => val,
            forEach: (fn) => {
                if (!val || typeof val !== 'object') return false;
                for (const k of Object.keys(val)) {
                    if (fn({ key: k, val: () => val[k] }) === true) return true;
                }
                return false;
            },
        };
    }
    function fire(p) {
        (listeners[p] || []).forEach(cb => cb(makeSnap(getValue(p))));
    }
    function setPath(p, value) {
        for (const key of Object.keys(store)) {
            if (key === p || key.startsWith(p + '/')) delete store[key];
        }
        if (value !== null && typeof value === 'object') {
            (function flatten(obj, base) {
                for (const k of Object.keys(obj)) {
                    const q = base ? base + '/' + k : k;
                    if (obj[k] !== null && typeof obj[k] === 'object') flatten(obj[k], q);
                    else store[q] = obj[k];
                }
            })(value, p);
        } else if (value !== null && value !== undefined) {
            store[p] = value;
        }
        fire(p);
    }
    const fakeDb = {
        ref: (p) => ({
            on: (evt, cb) => { (listeners[p] = listeners[p] || []).push(cb); },
            once: (evt) => Promise.resolve(makeSnap(getValue(p))),
            orderByKey: () => ({
                limitToLast: (n) => ({
                    once: (evt) => {
                        const val = getValue(p) || {};
                        const keys = Object.keys(val).sort().slice(-n);
                        const out = {};
                        keys.forEach(k => { out[k] = val[k]; });
                        return Promise.resolve(makeSnap(keys.length ? out : null));
                    },
                }),
            }),
            off: () => {},
            set: (v) => { writes.push({ op: 'set', path: p, value: v }); setPath(p, v); return Promise.resolve(); },
            update: (v) => { writes.push({ op: 'update', path: p, value: v }); setPath(p, Object.assign({}, getValue(p) || {}, v)); return Promise.resolve(); },
            remove: () => { writes.push({ op: 'remove', path: p }); setPath(p, null); return Promise.resolve(); },
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---- kitchen.html harness -------------------------------------------------
function loadKitchen(opts) {
    const { html, script } = inlineScript(KITCHEN_HTML);
    const spoken = [];
    const beeps = [];
    const fb = (opts && opts.firebase) || null;
    const confirmResult = (opts && 'confirmResult' in opts) ? opts.confirmResult : true;
    const dom = new JSDOM(html, {
        url: 'https://availoservices.in/kitchen.html',
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
            // Fake Web Audio: every oscillator start is one beep.
            window.AudioContext = class {
                constructor() { this.currentTime = 0; this.state = 'running'; this.destination = {}; }
                resume() { return Promise.resolve(); }
                createOscillator() {
                    return {
                        type: '',
                        frequency: { setValueAtTime() {} },
                        connect() {},
                        start() { beeps.push(1); },
                        stop() {},
                    };
                }
                createGain() {
                    return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} };
                }
            };
            window.confirm = () => confirmResult;
            window.alert = () => {};
        },
    });
    dom.window.eval(script);
    return { window: dom.window, document: dom.window.document, spoken, beeps };
}

// Turn sound on the way staff do (tap "సౌండ్ ఆన్") and discard the test
// beep it makes, so later beep counts are only from the code under test.
function enableSound(k) {
    k.document.getElementById('soundBtn').click();
    k.beeps.length = 0;
    k.spoken.length = 0;
}

function dineOrder(id, status, ageMs) {
    return {
        table: '05', mode: 'dine-in',
        items: [{ id: 'X', name: 'Chicken 65', qty: 1, price: 200 }],
        total: 200, status: status, createdAt: Date.now() - ageMs,
    };
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// --- M-K1: Clear all asks confirm() first -----------------------------------

test('M-K1 clear declined: confirm() says no — nothing is deleted from Firebase', async () => {
    const fb = makeFirebaseMock();
    fb.setPath(ORDERS_PATH, { '-push1': { table: '01', items: 'Lassi', time: '12:00' } });
    fb.setPath(REFILLS_PATH, { '-push2': { table: '02', text: 'నీళ్లు', time: '12:01' } });
    const k = loadKitchen({ firebase: fb, confirmResult: false });
    try {
        await sleep(50); // history loader settles
        k.document.getElementById('clearBtn').click();
        assert.equal(fb.writes.filter(w => w.op === 'remove').length, 0,
            'no Firebase remove may happen when confirm() returns false');
        assert.ok(fb.store[ORDERS_PATH + '/-push1/table'], 'the order must still be in Firebase');
    } finally { k.window.close(); }
});

test('M-K1 clear confirmed: confirm() says yes — orders + refills are removed', async () => {
    const fb = makeFirebaseMock();
    fb.setPath(ORDERS_PATH, { '-push1': { table: '01', items: 'Lassi', time: '12:00' } });
    fb.setPath(REFILLS_PATH, { '-push2': { table: '02', text: 'నీళ్లు', time: '12:01' } });
    const k = loadKitchen({ firebase: fb, confirmResult: true });
    try {
        await sleep(50); // history loader settles
        k.document.getElementById('clearBtn').click();
        await sleep(50);
        const removes = fb.writes.filter(w => w.op === 'remove').map(w => w.path);
        assert.ok(removes.includes(ORDERS_PATH), 'orders node must be removed on confirm');
        assert.ok(removes.includes(REFILLS_PATH), 'refills node must be removed on confirm');
    } finally { k.window.close(); }
});

// --- M-K3: fresh orders in the first snapshot buzz + announce once ----------

test('M-K3 fresh received order (30 s ago) in first snapshot: exactly 1 buzz + 1 announcement', () => {
    const fb = makeFirebaseMock();
    fb.setPath(DINE_ORDERS_PATH, { 'AV-DINE-20261123-120001': dineOrder('x', 'received', 30000) });
    const k = loadKitchen({ firebase: fb });
    try {
        enableSound(k);
        fb.fire(DINE_ORDERS_PATH); // first snapshot = history
        assert.equal(k.beeps.length, 3, 'one buzz = one buzzTimes(3) = 3 beeps, got ' + k.beeps.length);
        assert.equal(k.spoken.length, 1, 'exactly one announcement, got ' + k.spoken.length);
        assert.ok(k.spoken[0].text.includes('కొత్త ఆర్డర్'), 'announcement must note a new order: ' + k.spoken[0].text);
        assert.ok(k.document.getElementById('dineOrders').textContent.includes('AV-DINE-20261123-120001'),
            'the fresh order must still render as a card');
    } finally { k.window.close(); }
});

test('M-K3 stale received order (10 min ago) in first snapshot: no buzz, no announcement', () => {
    const fb = makeFirebaseMock();
    fb.setPath(DINE_ORDERS_PATH, { 'AV-DINE-20261123-120001': dineOrder('x', 'received', 600000) });
    const k = loadKitchen({ firebase: fb });
    try {
        enableSound(k);
        fb.fire(DINE_ORDERS_PATH); // first snapshot = history
        assert.equal(k.beeps.length, 0, 'a 10-minute-old order must not buzz');
        assert.equal(k.spoken.length, 0, 'a 10-minute-old order must not be announced');
        assert.ok(k.document.getElementById('dineOrders').textContent.includes('AV-DINE-20261123-120001'),
            'the stale order must still render as a card');
    } finally { k.window.close(); }
});

test('M-K3 five fresh received orders in one snapshot: still exactly 1 buzz + 1 announcement', () => {
    const fb = makeFirebaseMock();
    const orders = {};
    for (let i = 1; i <= 5; i++) {
        orders['AV-DINE-20261123-12000' + i] = dineOrder('x', 'received', 30000);
    }
    fb.setPath(DINE_ORDERS_PATH, orders);
    const k = loadKitchen({ firebase: fb });
    try {
        enableSound(k);
        fb.fire(DINE_ORDERS_PATH); // first snapshot = history (the 15-order rush case)
        assert.equal(k.beeps.length, 3, 'five fresh orders must still be one buzz (3 beeps), got ' + k.beeps.length);
        assert.equal(k.spoken.length, 1, 'five fresh orders must still be one announcement, got ' + k.spoken.length);
        assert.ok(k.spoken[0].text.includes('5'), 'the summary must count the fresh orders: ' + k.spoken[0].text);
    } finally { k.window.close(); }
});

test('M-K3 fresh but already-preparing order in first snapshot: no buzz, no announcement', () => {
    const fb = makeFirebaseMock();
    fb.setPath(DINE_ORDERS_PATH, { 'AV-DINE-20261123-120001': dineOrder('x', 'preparing', 30000) });
    const k = loadKitchen({ firebase: fb });
    try {
        enableSound(k);
        fb.fire(DINE_ORDERS_PATH);
        assert.equal(k.beeps.length, 0, 'only status received counts as a new arrival');
        assert.equal(k.spoken.length, 0, 'only status received counts as a new arrival');
    } finally { k.window.close(); }
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
