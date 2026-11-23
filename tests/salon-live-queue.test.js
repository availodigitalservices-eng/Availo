// Salon (salon.html + salon-owner.html) — Live Queue (22 Nov 2026),
// feature 7 of 8. (Feature 6, home-services booking, is skipped —
// it is blocked on the user's real rates.)
//
// Customer (salon.html): a "join queue" form — name (optional) + service
// ONLY if the SALON_SERVICES config is non-empty (default EMPTY — no
// service dropdown, no invented services). On join a record is written
// to Firebase RTDB under availo-kitchen-v1/salonQueue/{pushKey} with
// {name, service|null, token, status:'waiting', createdAt, dateKey}.
// Tokens come from a transaction counter at
// availo-kitchen-v1/salonQueueCounter/{YYYYMMDD}, so two customers
// joining at once never share a token; tokens restart every day and
// the list shows today only. The customer sees their token + live
// position ("మీ టోకెన్ #3 — మీ ముందు 2 మంది ఉన్నారు").
// Fail-open: if Firebase fails, a trilingual note shows and the page
// keeps working.
//
// Staff (salon-owner.html, unlisted): today's queue with per-person
// buttons — "✅ పిలవండి" (marks serving; blocked while someone is
// already serving), "✔️ పూర్తయింది" (marks done), "🗑️ తొలగించు"
// (removes). New joins buzz once + a short Telugu announce.
//
// Run:  node salon-live-queue.test.js   (from this directory)
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
// dine-ratings-reviews.test.js (push with generated key + transaction).
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
    const spoken = [];
    const fb = (opts && opts.firebase) || null;
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
            // M-K2 (23 Nov 2026): removeSalonPerson asks confirm() first.
            // Default to "yes" so the existing staff remove test keeps its
            // meaning; the audit-fixes file tests the "no" path.
            window.confirm = () => true;
            window.sendToSheet = (...args) => { sheetCalls.push(args); };
        },
    });
    dom.window.eval(script);
    return { window: dom.window, document: dom.window.document, opened, sheetCalls, spoken };
}

function todayKey(window) { return window.salonQueueTodayKey(); }

function seedQueue(fb, window, records) {
    // records: [{key, name, service, token, status, dateKey}]
    const key = todayKey(window);
    records.forEach(r => {
        fb.setPath(QUEUE_PATH + '/' + r.key, {
            name: r.name, service: r.service === undefined ? null : r.service,
            token: r.token, status: r.status || 'waiting',
            createdAt: 1700000000000 + r.token, dateKey: r.dateKey || key,
        });
    });
}

function findQueueWrite(writes) {
    return writes.find(w => w.op === 'set' && w.path.indexOf(QUEUE_PATH + '/mock-key-') === 0);
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// --- (1) Service config gate -------------------------------------------------

test('config gate: SALON_SERVICES is EMPTY by default — never invented', () => {
    const src = fs.readFileSync(SALON_HTML, 'utf8');
    assert.ok(src.includes('let SALON_SERVICES = [];'), 'no services on file');
    const { window, document } = loadPage(SALON_HTML);
    try {
        assert.equal(window.salonServicesConfigured(), false);
        assert.equal(document.getElementById('queueServiceRow').style.display, 'none', 'service row hidden while empty');
    } finally { window.close(); }
});

test('setter: setSalonServices enables the dropdown; bad values rejected', () => {
    const { window, document } = loadPage(SALON_HTML);
    try {
        const out = window.setSalonServices(['Hair Cut', '  Shaving  ', '', 42, null]);
        assert.deepEqual(out, ['Hair Cut', 'Shaving'], 'only non-empty strings, trimmed: ' + out.join(','));
        assert.equal(window.salonServicesConfigured(), true);
        assert.equal(document.getElementById('queueServiceRow').style.display, 'block', 'service row shown once configured');
        const opts = Array.from(document.getElementById('queueServiceSel').options).map(o => o.value);
        assert.deepEqual(opts, ['', 'Hair Cut', 'Shaving'], 'placeholder + configured services: ' + opts.join(','));
        window.setSalonServices([]);
        assert.equal(window.salonServicesConfigured(), false, 'empty array disables');
        window.setSalonServices('not-an-array');
        assert.equal(window.salonServicesConfigured(), false, 'non-array disables');
        window.setSalonServices(null);
        assert.equal(window.salonServicesConfigured(), false, 'null disables');
    } finally { window.close(); }
});

// --- (2) Pure helpers ---------------------------------------------------------

test('today key: YYYYMMDD, local date', () => {
    const { window } = loadPage(SALON_HTML);
    try {
        const d = new Date();
        const p = n => String(n).padStart(2, '0');
        const expect = d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate());
        assert.equal(window.salonQueueTodayKey(), expect);
        assert.match(window.salonQueueTodayKey(new Date(2026, 0, 5)), /^20260105$/);
    } finally { window.close(); }
});

test('record shape: exact fields, name trimmed to 50, service null by default', () => {
    const { window } = loadPage(SALON_HTML);
    try {
        const rec = window.buildSalonQueueRecord({ name: '  Kumar  ', token: 3, createdAt: 1700000000000, dateKey: '20261121' });
        assert.deepEqual(Object.keys(rec).sort(), ['createdAt', 'dateKey', 'name', 'service', 'status', 'token'].sort());
        assert.equal(rec.name, 'Kumar', 'name trimmed');
        assert.equal(rec.service, null, 'service null when not given');
        assert.equal(rec.token, 3);
        assert.equal(rec.status, 'waiting');
        assert.equal(rec.createdAt, 1700000000000);
        assert.equal(rec.dateKey, '20261121');
        const long = window.buildSalonQueueRecord({ name: 'x'.repeat(80), token: 1 });
        assert.equal(long.name.length, 50, 'name capped at 50 chars');
        const withService = window.buildSalonQueueRecord({ name: '', service: 'Hair Cut', token: 2 });
        assert.equal(withService.name, '', 'empty name stays empty (guest shown at render)');
        assert.equal(withService.service, 'Hair Cut');
    } finally { window.close(); }
});

test('todaysRecords: only matching dateKey survives; yesterday excluded', () => {
    const { window } = loadPage(SALON_HTML);
    try {
        const all = {
            a: { token: 1, dateKey: todayKey(window) },
            b: { token: 2, dateKey: '20200101' },
            c: { token: 3 }, // no dateKey at all
            d: { token: 4, dateKey: todayKey(window) },
        };
        const out = window.salonQueueTodaysRecords(all);
        assert.deepEqual(Object.keys(out).sort(), ['a', 'd']);
    } finally { window.close(); }
});

test('nextToken: empty -> 1, otherwise max + 1, ignores non-numbers', () => {
    const { window } = loadPage(SALON_HTML);
    try {
        assert.equal(window.salonQueueNextToken({}), 1, 'empty queue starts at 1');
        assert.equal(window.salonQueueNextToken({ a: { token: 1 }, b: { token: 4 }, c: { token: 2 } }), 5);
        assert.equal(window.salonQueueNextToken({ a: { token: 'x' }, b: {} }), 1, 'non-numeric tokens ignored');
    } finally { window.close(); }
});

test('myPosition: ahead count, serving, done, gone', () => {
    const { window } = loadPage(SALON_HTML);
    try {
        const recs = {
            a: { token: 1, status: 'waiting' },
            b: { token: 2, status: 'waiting' },
            c: { token: 3, status: 'waiting' },
            d: { token: 4, status: 'serving' },
        };
        // NOTE: cross-realm objects (jsdom vs node) fail assert.deepEqual
        // on prototypes, so compare fields, not whole objects.
        function checkPos(recs, token, status, ahead) {
            const p = window.salonQueueMyPosition(recs, token);
            assert.equal(p.status, status, 'status for token ' + token);
            assert.equal(p.ahead, ahead, 'ahead for token ' + token);
        }
        checkPos(recs, 3, 'waiting', 2);
        checkPos(recs, 1, 'waiting', 0);
        checkPos(recs, 4, 'serving', 0);
        const done = { a: { token: 1, status: 'done' } };
        checkPos(done, 1, 'done', 0);
        checkPos(recs, 99, 'gone', 0);
    } finally { window.close(); }
});

test('sortForDisplay: serving first, waiting newest first, done last', () => {
    const { window } = loadPage(SALON_HTML);
    try {
        const recs = {
            a: { token: 1, status: 'waiting', name: 'A' },
            b: { token: 2, status: 'done', name: 'B' },
            c: { token: 3, status: 'waiting', name: 'C' },
            d: { token: 4, status: 'serving', name: 'D' },
            e: { token: 5, status: 'waiting', name: 'E' },
        };
        const order = window.salonQueueSortForDisplay(recs).map(r => r.token);
        assert.equal(order.join(','), '4,5,3,1,2', 'serving, then waiting desc, then done: ' + order.join(','));
    } finally { window.close(); }
});

// --- (3) Customer join flow ---------------------------------------------------

test('join flow: token 1 from the counter, record written, my card shows token', async () => {
    const fb = makeFirebaseMock();
    const { window, document } = loadPage(SALON_HTML, null, { firebase: fb });
    try {
        document.getElementById('queueName').value = 'Kumar';
        await window.joinSalonQueue();
        const txn = fb.writes.find(w => w.op === 'transaction' && w.path === COUNTER_PATH + '/' + todayKey(window));
        assert.ok(txn, 'counter transaction must run');
        assert.equal(txn.value, 1, 'first token of the day is 1');
        const write = findQueueWrite(fb.writes);
        assert.ok(write, 'a queue record must be written');
        assert.equal(write.value.token, 1);
        assert.equal(write.value.name, 'Kumar');
        assert.equal(write.value.service, null, 'no service while unconfigured');
        assert.equal(write.value.status, 'waiting');
        assert.equal(write.value.dateKey, todayKey(window));
        assert.equal(typeof write.value.createdAt, 'number');
        const stored = JSON.parse(window.localStorage.getItem('availo_salon_queue'));
        assert.equal(stored.token, 1, 'my token saved locally');
        assert.ok(stored.queueId, 'my queue id saved locally');
        assert.equal(document.getElementById('myQueueCard').style.display, 'block', 'my card shown after join');
        assert.ok(document.getElementById('myQueueText').textContent.includes('#1'), 'my card shows token #1: ' + document.getElementById('myQueueText').textContent);
        assert.ok(document.getElementById('myQueueText').textContent.includes('మీ ముందు 0 మంది ఉన్నారు'), 'nobody ahead of the first join: ' + document.getElementById('myQueueText').textContent);
    } finally { window.close(); }
});

test('join flow (two customers, shared Firebase): tokens 1 and 2, second sees 1 ahead', async () => {
    const fb = makeFirebaseMock();
    const a = loadPage(SALON_HTML, null, { firebase: fb });
    const b = loadPage(SALON_HTML, null, { firebase: fb });
    try {
        a.document.getElementById('queueName').value = 'First';
        await a.window.joinSalonQueue();
        b.document.getElementById('queueName').value = 'Second';
        await b.window.joinSalonQueue();
        const writes = fb.writes.filter(w => w.op === 'set' && w.path.indexOf(QUEUE_PATH + '/mock-key-') === 0);
        assert.equal(writes.length, 2, 'two records written');
        assert.deepEqual(writes.map(w => w.value.token), [1, 2], 'sequential tokens: ' + writes.map(w => w.value.token).join(','));
        assert.ok(b.document.getElementById('myQueueText').textContent.includes('#2'), 'second customer sees token #2');
        assert.ok(b.document.getElementById('myQueueText').textContent.includes('మీ ముందు 1 మంది ఉన్నారు'), 'one person ahead: ' + b.document.getElementById('myQueueText').textContent);
        assert.ok(a.document.getElementById('myQueueText').textContent.includes('మీ ముందు 0 మంది ఉన్నారు'), 'first customer still sees 0 ahead');
    } finally { a.window.close(); b.window.close(); }
});

test('join flow (service configured): service recorded; empty name allowed', async () => {
    const fb = makeFirebaseMock();
    const { window, document } = loadPage(SALON_HTML, null, { firebase: fb });
    try {
        window.setSalonServices(['Hair Cut', 'Shaving']);
        document.getElementById('queueServiceSel').value = 'Shaving';
        await window.joinSalonQueue();
        const write = findQueueWrite(fb.writes);
        assert.ok(write, 'a queue record must be written');
        assert.equal(write.value.service, 'Shaving', 'chosen service recorded');
        assert.equal(write.value.name, '', 'empty name is allowed (shown as guest)');
    } finally { window.close(); }
});

test('join fail-open: Firebase down -> trilingual note, no crash, nothing saved', async () => {
    const fb = makeFirebaseMock({ fail: true });
    const { window, document } = loadPage(SALON_HTML, null, { firebase: fb });
    try {
        document.getElementById('queueName').value = 'Kumar';
        await assert.doesNotReject(() => window.joinSalonQueue(), 'join must not throw when Firebase is down');
        const warn = document.getElementById('queueWarnLine');
        assert.equal(warn.style.display, 'block', 'fail note shown');
        assert.ok(warn.textContent.includes('క్యూలో చేరలేకపోయాం'), 'note is in Telugu: ' + warn.textContent);
        assert.equal(window.localStorage.getItem('availo_salon_queue'), null, 'nothing saved locally on failure');
        assert.equal(findQueueWrite(fb.writes), undefined, 'no record written when Firebase is down');
    } finally { window.close(); }
});

// --- (4) Customer live rendering ----------------------------------------------

test('rendering: now-serving line + waiting newest first, yesterday excluded', () => {
    const fb = makeFirebaseMock();
    const { window, document } = loadPage(SALON_HTML, null, { firebase: fb });
    try {
        seedQueue(fb, window, [
            { key: 'k1', name: 'Asha', token: 1, status: 'done' },
            { key: 'k2', name: 'Ravi', token: 2, status: 'serving' },
            { key: 'k3', name: 'Meena', token: 3, status: 'waiting' },
            { key: 'k4', name: 'Old', token: 9, status: 'waiting', dateKey: '20200101' },
        ]);
        const now = document.getElementById('queueNowServing').textContent;
        assert.ok(now.includes('#2'), 'now-serving shows token #2: ' + now);
        assert.ok(now.includes('Ravi'), 'now-serving names Ravi: ' + now);
        const listText = document.getElementById('queueList').textContent;
        assert.ok(!listText.includes('Old'), 'yesterday’s record never shows: ' + listText);
        const idxMeena = listText.indexOf('Meena');
        const idxAsha = listText.indexOf('Asha');
        assert.ok(idxMeena !== -1 && idxAsha !== -1, 'both today’s waiting/done names render');
        assert.ok(idxMeena < idxAsha, 'waiting (newest) renders before done: ' + listText);
        assert.ok(listText.indexOf('Ravi') < idxMeena, 'serving renders first: ' + listText);
    } finally { window.close(); }
});

test('rendering: empty queue shows the empty message', () => {
    const fb = makeFirebaseMock();
    const { window, document } = loadPage(SALON_HTML, null, { firebase: fb });
    try {
        const listText = document.getElementById('queueList').textContent;
        assert.ok(listText.includes('ఇంకా క్యూలో ఎవరూ లేరు'), 'empty message: ' + listText);
        assert.ok(document.getElementById('queueNowServing').textContent.includes('ఎవరూ లేరు'), 'no one serving yet');
    } finally { window.close(); }
});

// --- (5) Staff page -----------------------------------------------------------

test('staff: call person marks serving (update write)', async () => {
    const fb = makeFirebaseMock();
    const { window } = loadPage(OWNER_HTML, 'https://availoservices.in/salon-owner.html', { firebase: fb });
    try {
        seedQueue(fb, window, [{ key: 'k1', name: 'Asha', token: 1, status: 'waiting' }]);
        const ok = await window.callSalonPerson('k1');
        assert.equal(ok, true, 'call succeeds');
        const upd = fb.writes.find(w => w.op === 'update' && w.path === QUEUE_PATH + '/k1');
        assert.ok(upd, 'an update must be written');
        assert.equal(upd.value.status, 'serving', 'update sets serving');
        assert.equal(fb.getValue(QUEUE_PATH + '/k1/status'), 'serving', 'record is serving in the store');
    } finally { window.close(); }
});

test('staff: call blocked while someone is serving — note shown, no write', async () => {
    const fb = makeFirebaseMock();
    const { window, document } = loadPage(OWNER_HTML, 'https://availoservices.in/salon-owner.html', { firebase: fb });
    try {
        seedQueue(fb, window, [
            { key: 'k1', name: 'Ravi', token: 1, status: 'serving' },
            { key: 'k2', name: 'Meena', token: 2, status: 'waiting' },
        ]);
        const ok = await window.callSalonPerson('k2');
        assert.equal(ok, false, 'second call is refused');
        const warn = document.getElementById('ownerWarnLine');
        assert.equal(warn.style.display, 'block', 'guard note shown');
        assert.ok(warn.textContent.includes('సర్వీస్ జరుగుతోంది'), 'note explains someone is in service: ' + warn.textContent);
        assert.equal(fb.writes.filter(w => w.op === 'update').length, 0, 'no status write while blocked');
    } finally { window.close(); }
});

test('staff: complete marks done; remove deletes the record', async () => {
    const fb = makeFirebaseMock();
    const { window } = loadPage(OWNER_HTML, 'https://availoservices.in/salon-owner.html', { firebase: fb });
    try {
        seedQueue(fb, window, [
            { key: 'k1', name: 'Ravi', token: 1, status: 'serving' },
            { key: 'k2', name: 'Meena', token: 2, status: 'waiting' },
        ]);
        assert.equal(await window.completeSalonPerson('k1'), true);
        assert.equal(fb.getValue(QUEUE_PATH + '/k1/status'), 'done', 'serving person is done');
        assert.equal(await window.removeSalonPerson('k2'), true);
        assert.equal(fb.getValue(QUEUE_PATH + '/k2'), null, 'removed record is gone');
        const rem = fb.writes.find(w => w.op === 'remove' && w.path === QUEUE_PATH + '/k2');
        assert.ok(rem, 'a remove write is recorded');
    } finally { window.close(); }
});

test('staff: detectNewJoins flags only new waiting people', () => {
    const { window } = loadPage(OWNER_HTML, 'https://availoservices.in/salon-owner.html');
    try {
        const prev = { k1: true };
        const recs = {
            k1: { token: 1, status: 'waiting' },
            k2: { token: 2, status: 'waiting' },
            k3: { token: 3, status: 'serving' },
            k4: { token: 4, status: 'done' },
        };
        const fresh = window.salonOwnerDetectNewJoins(prev, recs);
        assert.equal(fresh.map(f => f.id).join(','), 'k2', 'only the new waiting join: ' + JSON.stringify(fresh));
        assert.equal(window.salonOwnerDetectNewJoins({ k1: true, k2: true }, recs).length, 0, 'nothing new the second time');
        assert.equal(window.salonOwnerDetectNewJoins({}, recs).map(f => f.token).join(','), '2,1', 'highest token first for the announce');
    } finally { window.close(); }
});

test('staff: rendering shows per-status buttons + summary counts', () => {
    const fb = makeFirebaseMock();
    const { window, document } = loadPage(OWNER_HTML, 'https://availoservices.in/salon-owner.html', { firebase: fb });
    try {
        seedQueue(fb, window, [
            { key: 'k1', name: 'Ravi', token: 1, status: 'serving' },
            { key: 'k2', name: 'Meena', token: 2, status: 'waiting' },
            { key: 'k3', name: 'Asha', token: 3, status: 'done' },
        ]);
        const summary = document.getElementById('summaryLine').textContent;
        assert.ok(summary.includes('#1'), 'summary names the serving token: ' + summary);
        assert.ok(summary.includes('వేచి ఉన్నారు: 1'), 'one waiting counted: ' + summary);
        assert.ok(summary.includes('పూర్తయింది: 1'), 'one done counted: ' + summary);
        const html = document.getElementById('queueList').innerHTML;
        assert.ok(html.includes("callSalonPerson('k2')"), 'waiting row has a call button');
        assert.ok(html.includes("completeSalonPerson('k1')"), 'serving row has a done button');
        assert.ok(!html.includes("callSalonPerson('k1')"), 'serving row has no call button');
        assert.ok(html.includes("removeSalonPerson('k1')") && html.includes("removeSalonPerson('k3')"), 'every row has a remove button');
    } finally { window.close(); }
});

test('staff: fail-open without Firebase — actions return false, no throw', async () => {
    const { window, document } = loadPage(OWNER_HTML, 'https://availoservices.in/salon-owner.html');
    try {
        assert.equal(await window.callSalonPerson('k1'), false, 'call without Firebase');
        assert.equal(await window.completeSalonPerson('k1'), false, 'complete without Firebase');
        assert.equal(await window.removeSalonPerson('k1'), false, 'remove without Firebase');
        assert.ok(document.getElementById('queueList').textContent.includes('ఇంకా క్యూలో ఎవరూ లేరు'), 'empty state renders offline');
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
