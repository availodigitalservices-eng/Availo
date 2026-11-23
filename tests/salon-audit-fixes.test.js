// Salon audit fixes (23 Nov 2026, PRE-LIVE-AUDIT-2026-11-23.md §4):
//   M-D2  salon.html joinSalonQueue — double-tap join created 2 counter
//         transactions and 2 tokens (localStorage kept only the 2nd).
//   M-D3  salon.html submitSalonBooking — double-tap created a duplicate
//         booking (Sheet row + WhatsApp chat).
//   M-K2  salon-owner.html removeSalonPerson — "🗑️ తొలగించు" deleted
//         immediately with no confirmation.
//
// Harness reuses the salon-live-queue.test.js patterns (inline script
// extraction, in-memory Firebase mock, jsdom loadPage).
//
// Run:  node salon-audit-fixes.test.js   (from this directory)
//        npm test                        (runs all test files)

const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const SALON_HTML = path.join(__dirname, '..', 'salon.html');
const OWNER_HTML = path.join(__dirname, '..', 'salon-owner.html');
const QUEUE_PATH = 'availo-kitchen-v1/salonQueue';
const COUNTER_PATH = 'availo-kitchen-v1/salonQueueCounter';

function inlineScript(file) {
    const html = fs.readFileSync(file, 'utf8');
    const m = html.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(m, 'inline script block not found in ' + file);
    return { html, script: m[1] };
}

// Fake Firebase RTDB (in-memory) — same model as
// salon-live-queue.test.js (push with generated key + transaction).
function makeFirebaseMock(opts) {
    const store = {};
    const listeners = {};
    const writes = [];
    let pushN = 0;
    const fail = !!(opts && opts.fail);
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
            once: () => Promise.resolve({ val: () => getValue(path) }),
        };
    }
    const fakeDb = { ref: makeRef };
    const firebase = {
        apps: [],
        initializeApp: () => {},
        database: () => fakeDb,
    };
    return { firebase, store, writes, fire, setPath, getValue };
}

function loadPage(file, url, opts) {
    const { html, script } = inlineScript(file);
    const opened = [];
    const sheetCalls = [];
    const confirms = [];
    const spoken = [];
    const fb = (opts && opts.firebase) || null;
    const confirmFn = (opts && opts.confirmFn) || (() => true);
    const dom = new JSDOM(html, {
        url: url || 'https://availoservices.in/salon.html',
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
            window.confirm = (msg) => { confirms.push(msg); return confirmFn(msg); };
            window.sendToSheet = (...args) => { sheetCalls.push(args); };
        },
    });
    dom.window.eval(script);
    return { window: dom.window, document: dom.window.document, opened, sheetCalls, confirms, spoken };
}

function todayKey(window) { return window.salonQueueTodayKey(); }

function seedQueue(fb, window, records) {
    const key = todayKey(window);
    records.forEach(r => {
        fb.setPath(QUEUE_PATH + '/' + r.key, {
            name: r.name, service: r.service === undefined ? null : r.service,
            token: r.token, status: r.status || 'waiting',
            createdAt: 1700000000000 + r.token, dateKey: r.dateKey || key,
        });
    });
}

function queueWrites(writes) {
    return writes.filter(w => w.op === 'set' && w.path.indexOf(QUEUE_PATH + '/mock-key-') === 0);
}

function fillBookingForm(document) {
    document.getElementById('salonName').value = 'Kumar';
    document.getElementById('salonPhone').value = '9966157369';
    document.getElementById('salonService').value = 'Hair Cut';
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// --- M-D2: double-tap join ----------------------------------------------------

test('M-D2: two rapid joins -> one token, one counter transaction', async () => {
    const fb = makeFirebaseMock();
    const { window, document } = loadPage(SALON_HTML, null, { firebase: fb });
    try {
        document.getElementById('queueName').value = 'Kumar';
        const joinBtn = document.getElementById('queueJoinBtn');
        assert.equal(joinBtn.disabled, false, 'button starts enabled');
        const p1 = window.joinSalonQueue();
        assert.equal(joinBtn.disabled, true, 'button disabled while the join is in flight');
        const p2 = window.joinSalonQueue(); // second tap before the first finishes
        await Promise.all([p1, p2]);
        const txns = fb.writes.filter(w => w.op === 'transaction' && w.path === COUNTER_PATH + '/' + todayKey(window));
        assert.equal(txns.length, 1, 'exactly one counter transaction: ' + txns.length);
        assert.equal(txns[0].value, 1, 'the one token is 1');
        const writes = queueWrites(fb.writes);
        assert.equal(writes.length, 1, 'exactly one queue record written: ' + writes.length);
        assert.equal(writes[0].value.token, 1);
        const stored = JSON.parse(window.localStorage.getItem('availo_salon_queue'));
        assert.equal(stored.token, 1, 'localStorage keeps the only token');
        assert.equal(document.getElementById('myQueueText').textContent.includes('#1'), true, 'my card shows token #1');
    } finally { window.close(); }
});

test('M-D2: failed join re-enables the button, nothing saved', async () => {
    const fb = makeFirebaseMock({ fail: true });
    const { window, document } = loadPage(SALON_HTML, null, { firebase: fb });
    try {
        document.getElementById('queueName').value = 'Kumar';
        await window.joinSalonQueue();
        assert.equal(document.getElementById('queueJoinBtn').disabled, false, 'button re-enabled after failure');
        assert.equal(document.getElementById('queueWarnLine').style.display, 'block', 'fail note shown');
        assert.equal(window.localStorage.getItem('availo_salon_queue'), null, 'nothing saved locally on failure');
        assert.equal(queueWrites(fb.writes).length, 0, 'no record written when Firebase is down');
    } finally { window.close(); }
});

test('M-D2: after a finished join + staff removal, joining again works (token 2)', async () => {
    const fb = makeFirebaseMock();
    const { window, document } = loadPage(SALON_HTML, null, { firebase: fb });
    try {
        document.getElementById('queueName').value = 'Kumar';
        await window.joinSalonQueue();
        assert.equal(document.getElementById('queueJoinBtn').disabled, true, 'button stays disabled while joined');
        // Staff removes the customer: the record disappears from Firebase.
        fb.setPath(QUEUE_PATH + '/mock-key-1', null);
        assert.equal(document.getElementById('queueJoinBox').style.display, 'block', 'join box shown again after removal');
        assert.equal(document.getElementById('queueJoinBtn').disabled, false, 'button re-enabled after removal');
        document.getElementById('queueName').value = 'Kumar';
        await window.joinSalonQueue();
        const txns = fb.writes.filter(w => w.op === 'transaction' && w.path === COUNTER_PATH + '/' + todayKey(window));
        assert.equal(txns.length, 2, 'second join runs its own transaction');
        assert.deepEqual(queueWrites(fb.writes).map(w => w.value.token), [1, 2], 'tokens stay sequential');
    } finally { window.close(); }
});

// --- M-D3: double-tap booking -------------------------------------------------

test('M-D3: two rapid booking submits -> one Sheet row, one WhatsApp open', () => {
    const { window, document, opened, sheetCalls } = loadPage(SALON_HTML);
    try {
        fillBookingForm(document);
        window.submitSalonBooking();
        window.submitSalonBooking(); // second tap, immediately after
        assert.equal(sheetCalls.length, 1, 'exactly one Sheet log: ' + sheetCalls.length);
        assert.equal(sheetCalls[0][0], 'Salon', 'logged to the Salon tab');
        assert.equal(opened.length, 1, 'WhatsApp opened exactly once: ' + opened.length);
        assert.ok(opened[0].includes('wa.me/919966157369'), 'WhatsApp opens to the Availo number');
        assert.equal(document.getElementById('salonBookBtn').disabled, true, 'book button disabled after submit');
        assert.ok(document.getElementById('salonConfirmLine').textContent.includes('✅'), 'confirmation line shows the reference');
    } finally { window.close(); }
});

test('M-D3: validation failure does NOT lock the form — fix and submit works', () => {
    const { window, document, opened, sheetCalls } = loadPage(SALON_HTML);
    try {
        document.getElementById('salonPhone').value = '9966157369';
        document.getElementById('salonService').value = 'Hair Cut';
        window.submitSalonBooking(); // no name yet
        assert.equal(sheetCalls.length, 0, 'invalid submit logs nothing');
        assert.equal(opened.length, 0, 'invalid submit opens nothing');
        assert.equal(document.getElementById('salonBookBtn').disabled, false, 'button stays enabled after a validation failure');
        fillBookingForm(document);
        window.submitSalonBooking();
        assert.equal(sheetCalls.length, 1, 'corrected submit logs once');
        assert.equal(opened.length, 1, 'corrected submit opens WhatsApp once');
    } finally { window.close(); }
});

test('M-D3: send failure re-enables the button so the customer can retry', () => {
    const page = loadPage(SALON_HTML);
    const { window, document, opened, sheetCalls } = page;
    try {
        fillBookingForm(document);
        window.open = () => { throw new Error('popup blocked'); };
        window.submitSalonBooking();
        assert.equal(document.getElementById('salonBookBtn').disabled, false, 'button re-enabled after a failed send');
        assert.equal(document.getElementById('salonWarnLine').style.display, 'block', 'retry note shown');
        window.open = (u) => { opened.push(u); return null; };
        window.submitSalonBooking(); // retry
        assert.equal(opened.length, 1, 'retry opens WhatsApp once');
        assert.equal(sheetCalls.length, 2, 'Sheet was logged on the failed attempt and again on the retry');
    } finally { window.close(); }
});

// --- M-K2: remove asks confirm() first -----------------------------------------

test('M-K2: remove with confirm "yes" deletes the record', async () => {
    const fb = makeFirebaseMock();
    const { window, confirms } = loadPage(OWNER_HTML, 'https://availoservices.in/salon-owner.html', { firebase: fb, confirmFn: () => true });
    try {
        seedQueue(fb, window, [{ key: 'k1', name: 'Ravi', token: 1, status: 'waiting' }]);
        assert.equal(await window.removeSalonPerson('k1'), true, 'remove succeeds on confirm');
        assert.equal(confirms.length, 1, 'confirm() asked exactly once');
        assert.ok(confirms[0].includes('తొలగించాలా'), 'confirm text is Telugu: ' + confirms[0]);
        assert.equal(fb.getValue(QUEUE_PATH + '/k1'), null, 'record is gone');
        assert.ok(fb.writes.some(w => w.op === 'remove' && w.path === QUEUE_PATH + '/k1'), 'a remove write is recorded');
    } finally { window.close(); }
});

test('M-K2: remove with confirm "no" deletes nothing', async () => {
    const fb = makeFirebaseMock();
    const { window, confirms } = loadPage(OWNER_HTML, 'https://availoservices.in/salon-owner.html', { firebase: fb, confirmFn: () => false });
    try {
        seedQueue(fb, window, [{ key: 'k1', name: 'Ravi', token: 1, status: 'waiting' }]);
        assert.equal(await window.removeSalonPerson('k1'), false, 'remove refuses when confirm is declined');
        assert.equal(confirms.length, 1, 'confirm() was asked first');
        assert.equal(fb.writes.filter(w => w.op === 'remove').length, 0, 'no remove write when confirm returns false');
        assert.notEqual(fb.getValue(QUEUE_PATH + '/k1'), null, 'record is still there');
        assert.equal(fb.getValue(QUEUE_PATH + '/k1/status'), 'waiting', 'record untouched');
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
