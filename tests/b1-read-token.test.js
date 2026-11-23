// B1 read-token gate + M-G6 / M-G10 regressions — tests (23 Nov 2026).
// B1: Apps Script doGet used to return Sheet rows to anyone — the /exec
// URL is public in availo-db.js. Reads now need ?token=<READ_TOKEN>;
// the token lives ONLY in sheets-apps-script/Code.gs and admin.html.
// doPost (writes) is unchanged and needs no token.
// M-G6: the PDF WhatsApp share text must say the PDF has to be attached
// manually on WhatsApp (wa.me carries text only, never the file).
// M-G10: gender-blank GatePass rows default to masked (same as Female)
// in the admin table AND in the PDF report; only Male rows show as-is.
//
// The token value is NEVER written in this file: it is extracted from
// Code.gs at runtime via regex, so the token stays in exactly two files.
//
// Run:  node b1-read-token.test.js   (from this directory)
//        npm test                     (runs all test files)

const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const REPO = path.join(__dirname, '..');
const CODE_GS = path.join(REPO, 'sheets-apps-script', 'Code.gs');
const ADMIN_HTML = path.join(REPO, 'admin.html');
const DB_JS = path.join(REPO, 'availo-db.js');
const INDEX_HTML = path.join(REPO, 'index.html');

// The token, extracted from Code.gs at runtime — never hardcoded here.
function extractToken() {
    const src = fs.readFileSync(CODE_GS, 'utf8');
    const m = src.match(/var READ_TOKEN = '([0-9a-f]{32})'/);
    assert.ok(m, 'Code.gs must declare var READ_TOKEN = \'<32 hex chars>\'');
    return m[1];
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// --- Code.gs harness: load the Apps Script source in Node with stubbed
// Apps Script globals, then call doGet/doPost directly. ----------------

const GATE_HEADERS = ['Timestamp', 'Ref', 'Apartment', 'Flat', 'Delivery Partner', 'Photo Captured', 'Language', 'Mobile', 'Gender', 'Date', 'Time', 'Photo'];
const GATE_ROWS = [
    ['18/11/2026 20:10:18', 'AV-20261118-9001', 'TEST', 'TEST-201', 'Swiggy', 'captured', 'te', '9876543210', 'Female', '18/11/2026', '20:15:00', 'https://drive.google.com/file/d/PHOTO1/view?usp=sharing'],
    ['18/11/2026 20:12:44', 'AV-20261118-9002', 'TEST', 'TEST-202', 'Zomato', 'captured', 'te', '9876543211', 'Male', '18/11/2026', '20:16:00', 'https://drive.google.com/file/d/PHOTO2/view?usp=sharing'],
];

function loadCodeGs() {
    const src = fs.readFileSync(CODE_GS, 'utf8');
    const appended = [];
    const sheet = {
        getDataRange: () => ({ getDisplayValues: () => [GATE_HEADERS, ...GATE_ROWS] }),
        getRange: () => ({
            getValues: () => [GATE_HEADERS],
            setValues() {}, setFontWeight() {},
        }),
        appendRow(row) { appended.push(row); },
    };
    const sandbox = {
        SpreadsheetApp: {
            getActiveSpreadsheet: () => ({ getSheetByName: () => sheet, insertSheet: () => sheet }),
        },
        ContentService: {
            createTextOutput: (content) => ({
                content,
                setMimeType() { return this; },
                getContent() { return this.content; },
            }),
            MimeType: { JSON: 'application/json' },
        },
        LockService: {
            getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }),
        },
        DriveApp: { getFoldersByName: () => ({ hasNext: () => false }), createFolder: () => ({}) },
        Utilities: { base64Decode: () => [], newBlob: () => ({}) },
        console,
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox, { filename: 'Code.gs' });
    const out = (result) => JSON.parse(result.getContent());
    return {
        sandbox,
        appended,
        doGet: (params) => out(sandbox.doGet({ parameter: params || {} })),
        doPost: (data) => out(sandbox.doPost({ postData: { contents: JSON.stringify(data) } })),
    };
}

test('B1: doGet without a token returns unauthorized and NO rows', () => {
    const gs = loadCodeGs();
    const res = gs.doGet({ form: 'GatePass' });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'unauthorized');
    assert.equal(res.rows, undefined, 'no rows may leak without the token');
    assert.equal(res.headers, undefined, 'no headers either');
});

test('B1: doGet with no params at all returns unauthorized (no status leak)', () => {
    const gs = loadCodeGs();
    const res = gs.doGet({});
    assert.equal(res.ok, false);
    assert.equal(res.error, 'unauthorized');
});

test('B1: doGet with a wrong token returns unauthorized and NO rows', () => {
    const gs = loadCodeGs();
    const res = gs.doGet({ form: 'GatePass', token: '00000000000000000000000000000000' });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'unauthorized');
    assert.equal(res.rows, undefined);
});

test('B1: doGet with the real token returns the rows, newest first', () => {
    const token = extractToken();
    const gs = loadCodeGs();
    const res = gs.doGet({ form: 'GatePass', token });
    assert.equal(res.ok, true);
    assert.equal(res.form, 'GatePass');
    assert.deepEqual(res.headers, GATE_HEADERS);
    assert.equal(res.rows.length, 2);
    assert.equal(res.rows[0][1], 'AV-20261118-9002', 'newest first');
    assert.equal(res.rows[1][1], 'AV-20261118-9001');
});

test('B1: doPost (writes) is unchanged — no token needed, row appended', () => {
    const gs = loadCodeGs();
    const res = gs.doPost({
        form: 'GatePass', ref: 'AV-20261123-0001', apartment: 'TEST', flat: '101',
        partner: 'Swiggy', photo: 'captured', lang: 'te', mobile: '', gender: 'Male',
        date: '23/11/2026', time: '10:00:00', photoUrl: '',
    });
    assert.equal(res.ok, true);
    assert.equal(res.form, 'GatePass');
    assert.equal(gs.appended.length, 1, 'one row appended');
    assert.equal(gs.appended[0][1], 'AV-20261123-0001');
});

// --- Static: the token value lives in exactly Code.gs + admin.html -------

function repoFiles(dir, out) {
    for (const name of fs.readdirSync(dir)) {
        if (name === 'node_modules' || name === '.git') continue;
        const p = path.join(dir, name);
        const st = fs.statSync(p);
        if (st.isDirectory()) repoFiles(p, out);
        else if (st.isFile()) out.push(p);
    }
    return out;
}

test('B1: token value appears in exactly Code.gs and admin.html, nowhere else', () => {
    const token = extractToken();
    const hits = [];
    for (const file of repoFiles(REPO, [])) {
        let content;
        try { content = fs.readFileSync(file, 'utf8'); } catch (e) { continue; }
        if (content.includes(token)) hits.push(path.relative(REPO, file));
    }
    assert.deepEqual(hits.sort(), ['admin.html', 'sheets-apps-script/Code.gs']);
});

test('B1: public site JS never carries the token (availo-db.js, index.html)', () => {
    const token = extractToken();
    assert.ok(!fs.readFileSync(DB_JS, 'utf8').includes(token), 'availo-db.js must not contain the token');
    assert.ok(!fs.readFileSync(INDEX_HTML, 'utf8').includes(token), 'index.html must not contain the token');
    // And the public write path still posts with no token at all.
    assert.ok(!/token/i.test(fs.readFileSync(DB_JS, 'utf8')), 'availo-db.js must not mention a token');
});

test('B1: admin.html token matches Code.gs token and is sent on reads', () => {
    const token = extractToken();
    const html = fs.readFileSync(ADMIN_HTML, 'utf8');
    const m = html.match(/const ADMIN_READ_TOKEN = '([0-9a-f]{32})'/);
    assert.ok(m, 'admin.html must declare ADMIN_READ_TOKEN');
    assert.equal(m[1], token, 'admin.html token must equal the Code.gs token');
    assert.ok(html.includes("'&token=' + ADMIN_READ_TOKEN"), 'fetchForm must append &token=');
});

// --- admin.html in jsdom: token on the fetch URL, M-G6, M-G10 -----------

function inlineScript(file) {
    const html = fs.readFileSync(file, 'utf8');
    const m = html.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(m, 'inline script block not found in ' + file);
    return { html, script: m[1] };
}

let adminPayloads = {};
let fetchedUrls = [];
function loadAdmin(payloads) {
    adminPayloads = payloads || {};
    fetchedUrls = [];
    const { html, script } = inlineScript(ADMIN_HTML);
    const dom = new JSDOM(html, {
        url: 'https://availoservices.in/admin.html',
        runScripts: 'outside-only',
        pretendToBeVisual: true,
        beforeParse(window) {
            window.sessionStorage.setItem('availo_admin_unlocked', '1');
            window.AVAILO_SHEETS_URL = 'https://script.google.com/macros/s/TEST/exec';
            window.fetch = (url) => {
                fetchedUrls.push(url);
                let form = '';
                try { form = new URL(url).searchParams.get('form') || ''; } catch (e) {}
                const p = adminPayloads[form] || { ok: true, headers: [], rows: [] };
                return Promise.resolve({ json: () => Promise.resolve(p) });
            };
        },
    });
    dom.window.eval(script);
    return { window: dom.window, document: dom.window.document };
}
async function loadAdminReady(payloads) {
    const ctx = loadAdmin(payloads);
    await new Promise(r => setTimeout(r, 100));
    return ctx;
}

const BLANK_PHOTO = 'https://drive.google.com/file/d/3CdEfGhIjKlMnOpQrStUvWxYzAb/view?usp=drivesdk';
const BLANK_ROW = ['18/11/2026 20:14:00', 'AV-20261118-9003', 'TEST', 'TEST-203', 'Dunzo', 'captured', 'te', '9876543212', '', '18/11/2026', '20:18:00', BLANK_PHOTO];
const MALE_ROW = ['18/11/2026 20:12:44', 'AV-20261118-9002', 'TEST', 'TEST-202', 'Zomato', 'captured', 'te', '9876543211', 'Male', '18/11/2026', '20:16:00', 'https://drive.google.com/file/d/2BcDeFgHiJkLmNoPqRsTuVwXyZ/view?usp=drivesdk'];

test('B1: admin.html fetch URLs carry &token=<the Code.gs token>', async () => {
    const token = extractToken();
    const { window } = await loadAdminReady({ GatePass: { ok: true, headers: GATE_HEADERS, rows: [MALE_ROW] } });
    try {
        assert.ok(fetchedUrls.length >= 1, 'admin must fetch the Sheet on load');
        for (const url of fetchedUrls) {
            const u = new URL(url);
            assert.equal(u.searchParams.get('token'), token, 'every read URL must carry the token: ' + url);
            assert.ok(u.searchParams.get('form'), 'form param still present');
        }
    } finally { window.close(); }
});

test('M-G6: WhatsApp share text says the PDF must be attached manually (te/en/hi)', () => {
    const { window } = loadAdmin();
    try {
        const entries = window.gatePassEntries(GATE_HEADERS, [BLANK_ROW, MALE_ROW], '2026-11-18');
        const firstSeen = window.firstSeenByFlat(GATE_HEADERS, [BLANK_ROW, MALE_ROW]);
        window.toggleLanguage('te');
        const te = window.whatsappGatePassText('2026-11-18', entries, firstSeen);
        assert.ok(te.includes('PDFని మాన్యువల్‌గా అటాచ్ చేయండి'), 'Telugu share text must say attach the PDF manually: ' + te);
        window.toggleLanguage('en');
        const en = window.whatsappGatePassText('2026-11-18', entries, firstSeen);
        assert.ok(en.includes('attach the PDF manually'), 'English share text must say attach the PDF manually: ' + en);
        window.toggleLanguage('hi');
        const hi = window.whatsappGatePassText('2026-11-18', entries, firstSeen);
        assert.ok(hi.includes('PDF को मैन्युअल रूप से अटैच करें'), 'Hindi share text must say attach the PDF manually: ' + hi);
    } finally { window.close(); }
});

test('M-G10: gender-blank row renders masked number + blurred thumbnail in the admin table', async () => {
    const { window, document } = await loadAdminReady({ GatePass: { ok: true, headers: GATE_HEADERS, rows: [BLANK_ROW, MALE_ROW] } });
    try {
        const rows = document.querySelectorAll('#tableBody tr');
        assert.equal(rows.length, 2);
        const bCells = rows[0].querySelectorAll('td');
        // Mobile (col 7): masked + reveal button, full number hidden.
        assert.ok(bCells[7].textContent.includes('98******12'), 'blank-gender number must be shown masked');
        assert.ok(!bCells[7].textContent.includes('9876543212'), 'blank-gender full number must NOT be visible before reveal');
        assert.ok(bCells[7].querySelector('button.reveal-btn'), 'blank-gender mobile cell must have a reveal button');
        // Photo (col 11): blurred thumbnail + reveal button.
        const img = bCells[11].querySelector('img');
        assert.ok(img, 'blank-gender photo cell must have a thumbnail');
        assert.ok(img.classList.contains('gate-photo-blurred'), 'blank-gender thumbnail must start blurred');
        assert.ok(bCells[11].querySelector('button.reveal-btn'), 'blank-gender photo cell must have a reveal button');
        // Male row next to it is unchanged: full number, clear thumbnail.
        const mCells = rows[1].querySelectorAll('td');
        assert.equal(mCells[7].textContent, '9876543211', 'male number still shown in full');
        assert.ok(!mCells[11].querySelector('img').classList.contains('gate-photo-blurred'), 'male thumbnail still clear');
    } finally { window.close(); }
});

test('M-G10: gender-blank row is masked + blurred in the PDF report too', async () => {
    const { window, document } = await loadAdminReady({ GatePass: { ok: true, headers: GATE_HEADERS, rows: [BLANK_ROW, MALE_ROW] } });
    try {
        document.getElementById('gpReportDate').value = '2026-11-18';
        window.buildGatePassReport();
        const sheetHtml = document.getElementById('gpReportSheet').innerHTML;
        assert.ok(sheetHtml.includes('98******12'), 'PDF must mask the blank-gender number');
        assert.ok(!sheetHtml.includes('9876543212'), 'PDF must NOT show the blank-gender full number');
        assert.ok(sheetHtml.includes('gate-photo-blurred'), 'PDF must blur the blank-gender thumbnail');
        assert.ok(sheetHtml.includes('9876543211'), 'PDF still shows the Male number in full');
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
