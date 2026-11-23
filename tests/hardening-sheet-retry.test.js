// Sheet submit retry + queue — tests (21 Nov 2026).
//
// availo-db.js: a failed POST is retried up to 2 times (3 attempts),
// then queued in localStorage and re-sent on the next submit or next
// page load — never lost silently. While anything is queued, a small
// trilingual "saved on this device, will send" note shows.
//
// Run:  node hardening-sheet-retry.test.js   (from this directory)
//        npm test                             (runs all test files)

const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const DB_JS = path.join(__dirname, '..', 'availo-db.js');
const QUEUE_KEY = 'availo_sheet_queue';

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// Fresh page with availo-db.js evaluated and a scripted fetch.
// outcomes: array of 'ok' | 'fail' consumed in order, then
// defaultOutcome ('ok' unless given — pass 'fail' to stay offline).
function loadDb(outcomes, defaultOutcome) {
    const src = fs.readFileSync(DB_JS, 'utf8');
    const calls = [];
    const queue = (outcomes || []).slice();
    const fallback = defaultOutcome || 'ok';
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
        url: 'https://availoservices.in/',
        runScripts: 'outside-only',
    });
    dom.window.fetch = function (url, opts) {
        calls.push({ url: url, opts: opts });
        const next = queue.length ? queue.shift() : fallback;
        if (next === 'fail') return Promise.reject(new Error('network down'));
        return Promise.resolve({});
    };
    dom.window.eval(src);
    dom.window.AVAILO_SHEETS_RETRY_DELAYS = [0, 0]; // instant retries in tests
    return { window: dom.window, document: dom.window.document, calls: calls };
}

function queued(window) {
    try {
        const raw = window.localStorage.getItem(QUEUE_KEY);
        return raw ? JSON.parse(raw) : [];
    } catch (e) { return []; }
}

function note(window) {
    return window.document.getElementById('availoSheetQueueNote');
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('retry: fetch fails twice then succeeds — 3 attempts, nothing queued, no note', async () => {
    const { window, calls } = loadDb(['fail', 'fail', 'ok']);
    try {
        window.sendToSheet('GatePass', { ref: 'AV-20261121-0001' });
        await sleep(50);
        assert.equal(calls.length, 3, 'must retry twice after two failures');
        assert.equal(calls[0].opts.method, 'POST');
        assert.equal(JSON.parse(calls[0].opts.body).ref, 'AV-20261121-0001', 'same payload retried');
        assert.equal(queued(window).length, 0, 'nothing queued after success');
        assert.equal(note(window), null, 'no queued note after success');
    } finally { window.close(); }
});

test('retry: first attempt succeeds — exactly one POST, no retry', async () => {
    const { window, calls } = loadDb(['ok']);
    try {
        window.sendToSheet('GatePass', { ref: 'AV-20261121-0002' });
        await sleep(30);
        assert.equal(calls.length, 1, 'no retry when the first attempt works');
    } finally { window.close(); }
});

test('queue: all 3 attempts fail — record queued in localStorage + note shows', async () => {
    const { window, calls, document } = loadDb(['fail', 'fail', 'fail']);
    try {
        window.sendToSheet('GatePass', { ref: 'AV-20261121-0003', flat: '302' });
        await sleep(50);
        assert.equal(calls.length, 3, 'all 3 attempts tried');
        const q = queued(window);
        assert.equal(q.length, 1, 'one record queued');
        assert.equal(q[0].payload.ref, 'AV-20261121-0003', 'queued payload is the failed record');
        assert.equal(q[0].payload.flat, '302', 'queued payload keeps its fields');
        assert.ok(q[0].queuedAt, 'queue entry is timestamped');
        const n = note(window);
        assert.ok(n, 'queued note must show');
        assert.ok(n.textContent.indexOf('సేవ్ అయ్యింది') !== -1, 'note is Telugu by default');
    } finally { window.close(); }
});

test('queue: note is English/Hindi when currentLang is set', async () => {
    const { window } = loadDb(['fail', 'fail', 'fail'], 'fail');
    try {
        window.currentLang = 'en';
        window.sendToSheet('GatePass', { ref: 'AV-20261121-0004' });
        await sleep(50);
        assert.ok(note(window).textContent.indexOf('Saved on this device') !== -1, 'English note');
        window.currentLang = 'hi';
        window.sendToSheet('GatePass', { ref: 'AV-20261121-0005' });
        await sleep(50);
        assert.ok(note(window).textContent.indexOf('इस डिवाइस पर') !== -1, 'Hindi note');
        assert.equal(queued(window).length, 2, 'both failed records queued');
    } finally { window.close(); }
});

test('flush: queued record is sent on the next submit, queue empties, note hides', async () => {
    const { window, calls } = loadDb(['fail', 'fail', 'fail']);
    try {
        window.sendToSheet('GatePass', { ref: 'AV-20261121-0006' });
        await sleep(50);
        assert.equal(queued(window).length, 1, 'record queued after failures');
        assert.equal(calls.length, 3, '3 failed attempts so far');
        // Next submit: fetch now succeeds — flush sends the queued record
        // first, then the new one.
        window.sendToSheet('GatePass', { ref: 'AV-20261121-0007' });
        await sleep(50);
        assert.equal(queued(window).length, 0, 'queue must empty after flush');
        assert.equal(note(window), null, 'note hides once the queue empties');
        const bodies = calls.slice(3).map(function (c) { return JSON.parse(c.opts.body).ref; });
        assert.deepEqual(bodies, ['AV-20261121-0006', 'AV-20261121-0007'], 'queued record sent before the new one');
    } finally { window.close(); }
});

test('flush: a still-failing flush keeps the queue (stops at first failure)', async () => {
    const { window, calls } = loadDb(['fail', 'fail', 'fail'], 'fail');
    try {
        window.sendToSheet('GatePass', { ref: 'AV-20261121-0008' });
        await sleep(50);
        assert.equal(queued(window).length, 1, 'record queued');
        const before = calls.length;
        window.sendToSheet('GatePass', { ref: 'AV-20261121-0009' });
        await sleep(50);
        // Flush attempt (1 call) fails, so the new record also retries 3x
        // and queues; the old record stays queued.
        assert.equal(queued(window).length, 2, 'both records stay queued when offline');
        assert.ok(note(window), 'note stays while the queue is non-empty');
        assert.ok(calls.length > before, 'attempts were made');
    } finally { window.close(); }
});

test('flush on load: a record queued by an earlier page load is sent when the page loads', async () => {
    // First page: queue a record (offline).
    const first = loadDb(['fail', 'fail', 'fail']);
    let savedQueue;
    try {
        first.window.sendToSheet('GatePass', { ref: 'AV-20261121-0010' });
        await sleep(50);
        assert.equal(queued(first.window).length, 1, 'record queued on first page');
        savedQueue = first.window.localStorage.getItem(QUEUE_KEY);
    } finally { first.window.close(); }
    // Second page load with the same queue in storage and a working fetch:
    // the load-time flush must send it without any submit.
    const src = fs.readFileSync(DB_JS, 'utf8');
    const calls = [];
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
        url: 'https://availoservices.in/',
        runScripts: 'outside-only',
    });
    dom.window.localStorage.setItem(QUEUE_KEY, savedQueue);
    dom.window.fetch = function (url, opts) {
        calls.push({ url: url, opts: opts });
        return Promise.resolve({});
    };
    try {
        dom.window.eval(src);
        await sleep(50);
        assert.equal(calls.length, 1, 'load-time flush must send the queued record');
        assert.equal(JSON.parse(calls[0].opts.body).ref, 'AV-20261121-0010', 'the queued record is sent');
        assert.equal(queued(dom.window).length, 0, 'queue empties after load-time flush');
    } finally { dom.window.close(); }
});

test('queue cap: at most 50 records kept, oldest dropped first', async () => {
    const { window } = loadDb([], 'fail'); // every attempt fails
    try {
        for (let i = 0; i < 52; i++) {
            window.sendToSheet('GatePass', { ref: 'AV-20261121-' + String(1000 + i) });
        }
        await sleep(150);
        const q = queued(window);
        assert.equal(q.length, 50, 'queue is capped at 50');
        assert.equal(q[0].payload.ref, 'AV-20261121-1002', 'oldest two dropped first');
        assert.equal(q[49].payload.ref, 'AV-20261121-1051', 'newest kept');
    } finally { window.close(); }
});

test('sendToSheet still drops keepalive for a photo payload over the cap (regression)', () => {
    const { window, calls } = loadDb(['ok']);
    try {
        window.sendToSheet('GatePass', { ref: 'AV-20261121-0011', photoData: 'data:image/jpeg;base64,' + 'A'.repeat(70000) });
        assert.equal(calls.length, 1);
        assert.equal(calls[0].opts.keepalive, false, 'keepalive must be off for a >60KB total body');
    } finally { window.close(); }
});

test('sendToSheet never throws and never blocks when fetch is missing', async () => {
    const src = fs.readFileSync(DB_JS, 'utf8');
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
        url: 'https://availoservices.in/',
        runScripts: 'outside-only',
    });
    dom.window.fetch = undefined;
    try {
        dom.window.eval(src);
        dom.window.sendToSheet('GatePass', { ref: 'AV-20261121-0012' });
        await sleep(20);
        assert.equal(queued(dom.window).length, 1, 'record queued when fetch is missing');
    } finally { dom.window.close(); }
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
