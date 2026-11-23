// Gate Pass privacy + fields — tests (18 Nov 2026, CORRECTED design).
// Owner spec (19:32): the Gate Pass database must have Mobile, Date,
// Time, Photo. Owner CORRECTION (21:34): the FULL number and the CLEAR
// photo are STORED (Sheet + Drive) so the admin can see the real data.
// Masking happens ONLY at DISPLAY in the admin panel (admin.html): Female
// GatePass rows show the number masked (98******19) and the photo as a
// blurred thumbnail, each with a per-row admin reveal. Male rows show
// everything as-is. The WhatsApp message (to Availo's own number, i.e.
// the admin) carries the FULL number. ONE gender field (Male/Female, no
// default) drives the panel masking.
//
// Run:  node gatepass-privacy.test.js   (from this directory)
//        npm test                        (runs all test files)

const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const INDEX_HTML = path.join(__dirname, '..', 'index.html');
const ADMIN_HTML = path.join(__dirname, '..', 'admin.html');
const DB_JS = path.join(__dirname, '..', 'availo-db.js');

// Extract the single inline <script> (no src) from an .html file.
function inlineScript(file) {
    const html = fs.readFileSync(file, 'utf8');
    const m = html.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(m, 'inline script block not found in ' + file);
    return { html, script: m[1] };
}

// Fake photo size used by the stubbed Image (per test).
let fakeImgSize = { w: 1600, h: 1200 };

function makeCtx() {
    const ctx = {
        filter: 'none',
        drawImageCalls: [],
        imageSmoothingEnabled: true,
        fillRect() {}, strokeRect() {}, setLineDash() {}, fillText() {},
        drawImage(img, x, y, w, h) { this.drawImageCalls.push({ filterAtDraw: this.filter, w, h, img }); },
    };
    return ctx;
}

// Fresh index.html page per test. Canvas/Image/URL/alert are stubbed
// because jsdom has no real canvas or image loading.
function loadPage() {
    const { html, script } = inlineScript(INDEX_HTML);
    const opened = [];      // window.open calls (wa.me links)
    const sheetCalls = [];  // sendToSheet calls (availo-db.js is external, mock it)
    const alerts = [];
    const ctxs = [];        // { el, ctx } per canvas getContext() call
    const dom = new JSDOM(html, {
        url: 'https://availoservices.in/',
        runScripts: 'outside-only',
        pretendToBeVisual: true,
        beforeParse(window) {
            window.speechSynthesis = { getVoices: () => [], speak: () => {}, cancel: () => {}, onvoiceschanged: null };
            window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
            window.Audio = class { constructor() {} play() { return Promise.resolve(); } pause() {} };
            window.open = (url) => { opened.push(url); return null; };
            window.sendToSheet = (...args) => { sheetCalls.push(args); };
            window.alert = (msg) => { alerts.push(msg); };
            window.URL.createObjectURL = () => 'blob:fake-photo';
            window.URL.revokeObjectURL = () => {};
            window.Image = class {
                constructor() { this.complete = false; this.naturalWidth = 0; this.naturalHeight = 0; }
                set src(v) {
                    this._src = v;
                    this.complete = true;
                    this.naturalWidth = fakeImgSize.w;
                    this.naturalHeight = fakeImgSize.h;
                    if (typeof this.onload === 'function') this.onload();
                }
                get src() { return this._src || ''; }
            };
            window.HTMLCanvasElement.prototype.getContext = function () {
                if (!this._testCtx) { this._testCtx = makeCtx(); ctxs.push({ el: this, ctx: this._testCtx }); }
                return this._testCtx;
            };
            window.HTMLCanvasElement.prototype.toDataURL = function () { return 'data:image/jpeg;base64,FAKEJPEGDATA'; };
        },
    });
    dom.window.eval(script);
    return { window: dom.window, document: dom.window.document, opened, sheetCalls, alerts, ctxs };
}

// Fresh admin.html page per test (passcode gate stays locked; data is
// injected straight into ADMIN_DATA via eval, then renderTable() runs).
let adminPayloads = {};
function loadAdmin(payloads) {
    adminPayloads = payloads || {};
    const { html, script } = inlineScript(ADMIN_HTML);
    const dom = new JSDOM(html, {
        url: 'https://availoservices.in/admin.html',
        runScripts: 'outside-only',
        pretendToBeVisual: true,
        beforeParse(window) {
            // Unlock the panel + point it at a fake Apps Script endpoint so
            // loadDashboard() fetches our test rows through the real path.
            window.sessionStorage.setItem('availo_admin_unlocked', '1');
            window.AVAILO_SHEETS_URL = 'https://script.google.com/macros/s/TEST/exec';
            window.fetch = (url) => {
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
// loadAdmin() + wait for the async fetch/render cycle to finish.
async function loadAdminReady(payloads) {
    const ctx = loadAdmin(payloads);
    await new Promise(r => setTimeout(r, 100));
    return ctx;
}

// The wa.me text param, decoded the way WhatsApp receives it.
function waText(url) {
    const u = new URL(url);
    return { params: [...u.searchParams.keys()], text: u.searchParams.get('text') };
}

// Fill the Gate Pass form (apartment, flat, partner chip, gender chip,
// photo) then call submit. No mobile number is asked at the gate.
// Gender may be null (not picked).
function fillGate(doc, window, { apt = 'Sri Sai Heights', flat = '302', partner = 'Swiggy', gender = null, photo = true }) {
    doc.getElementById('gateApartment').value = apt;
    doc.getElementById('gateFlatNo').value = flat;
    const chip = [...doc.querySelectorAll('#gatePartnerChips button')].find(b => b.getAttribute('data-value') === partner);
    assert.ok(chip, 'partner chip ' + partner + ' must exist');
    chip.click();
    if (gender) {
        const g = [...doc.querySelectorAll('#gateGenderChips button')].find(b => b.getAttribute('data-value') === gender);
        assert.ok(g, 'gender chip ' + gender + ' must exist');
        g.click();
    }
    if (photo) {
        const file = new window.File(['fake-bytes'], 'photo.jpg', { type: 'image/jpeg' });
        window.onGatePhotoSelected({ target: { files: [file], value: '' } });
    }
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// --- Pure helpers (index.html) ------------------------------------------------

test('gateDateTimeParts: IST date DD/MM/YYYY + time HH:MM:SS', () => {
    const { window } = loadPage();
    try {
        const dt = window.gateDateTimeParts(new Date('2026-11-18T10:30:00Z'));
        assert.equal(dt.date, '18/11/2026', '10:30 UTC is 16:00 IST on 18 Nov');
        assert.equal(dt.time, '16:00:00');
        assert.match(dt.date, /^\d{2}\/\d{2}\/\d{4}$/);
        assert.match(dt.time, /^\d{2}:\d{2}:\d{2}$/);
    } finally { window.close(); }
});

test('gender chips exist (Male/Female) with NO default selected', () => {
    const { window, document } = loadPage();
    try {
        const chips = [...document.querySelectorAll('#gateGenderChips button')];
        assert.deepEqual(chips.map(c => c.getAttribute('data-value')), ['Male', 'Female']);
        assert.equal(document.getElementById('gateMobile'), null, 'no mobile input at the gate — the user said no mobile number');
        // No chip pre-selected: submitting with everything else valid must
        // still be blocked (see the gender-required test below).
        assert.equal(chips.filter(c => c.style.background === 'rgb(79, 70, 229)' || c.style.background === '#4f46e5').length, 0);
    } finally { window.close(); }
});

// --- Female end-to-end: NO mobile collected, CLEAR photo stored ----------
// (user correction 22 Nov 2026: no mobile number is asked at the gate;
// masking is display-only in the admin panel, for old rows)

test('female: NO mobile collected — Sheet payload has no mobile key, WhatsApp has no number; photo stored CLEAR', () => {
    const { window, document, opened, sheetCalls, ctxs } = loadPage();
    try {
        fillGate(document, window, { gender: 'Female' });
        window.sendGateSecurityPass();
        assert.equal(opened.length, 1, 'one WhatsApp window must open');
        assert.equal(sheetCalls.length, 1, 'one Sheet log must happen');
        const payload = sheetCalls[0][1];
        assert.equal(sheetCalls[0][0], 'GatePass');
        assert.ok(!('mobile' in payload), 'no mobile key in the Sheet payload — the gate pass never asks for a number');
        assert.equal(payload.gender, 'Female');
        assert.match(payload.date, /^\d{2}\/\d{2}\/\d{4}$/, 'date column present');
        assert.match(payload.time, /^\d{2}:\d{2}:\d{2}$/, 'time column present');
        assert.equal(payload.photo, 'captured');
        assert.equal(payload.photoData, 'data:image/jpeg;base64,FAKEJPEGDATA', 'resized photo data URL must be sent');
        assert.match(payload.ref, /AV-\d{8}-\d{4}/);
        assert.ok(!JSON.stringify(payload).includes('9966157369'), 'no number anywhere in the Sheet payload');
        // WhatsApp goes to Availo's own number (the admin): no number asked.
        const { params, text } = waText(opened[0]);
        assert.deepEqual(params, ['text']);
        assert.ok(!text.includes('9966157369'), 'WhatsApp must NOT show any number');
        assert.ok(!text.includes('మొబైల్'), 'WhatsApp must have no mobile line');
        assert.ok(text.includes('స్త్రీ'), 'WhatsApp must include the gender');
        assert.ok(text.includes(payload.date) && text.includes(payload.time), 'WhatsApp must include date + time');
        // Clear photo: the photo canvas drew with NO blur at storage.
        assert.equal(ctxs.length, 2, 'stamp + photo canvases');
        assert.equal(ctxs[1].ctx.drawImageCalls[0].filterAtDraw, 'none', 'female photo must be stored CLEAR (no blur at storage)');
        assert.equal(ctxs[1].el.width, 800, 'photo resized to max 800px wide');
        assert.equal(ctxs[1].el.height, 600, '1600x1200 keeps aspect at 800x600');
    } finally { window.close(); }
});

// --- Male end-to-end: NO mobile collected, clear photo ---------------------

test('male: NO mobile collected — Sheet payload has no mobile key, WhatsApp has no number; photo clear', () => {
    const { window, document, opened, sheetCalls, ctxs } = loadPage();
    try {
        fillGate(document, window, { gender: 'Male' });
        window.sendGateSecurityPass();
        assert.equal(opened.length, 1);
        assert.equal(sheetCalls.length, 1);
        const payload = sheetCalls[0][1];
        assert.ok(!('mobile' in payload), 'no mobile key in the Sheet payload');
        assert.equal(payload.gender, 'Male');
        assert.equal(payload.photoData, 'data:image/jpeg;base64,FAKEJPEGDATA');
        const { text } = waText(opened[0]);
        assert.ok(!text.includes('9966157369'), 'WhatsApp must NOT show any number');
        assert.ok(!text.includes('మొబైల్'), 'WhatsApp must have no mobile line');
        assert.ok(text.includes('పురుషుడు'), 'WhatsApp must include the gender');
        assert.equal(ctxs[1].ctx.drawImageCalls[0].filterAtDraw, 'none', 'male photo must NOT be blurred');
    } finally { window.close(); }
});

// --- Validation: gender + photo required (NO mobile — the gate pass never
// asks for a number, so there is no phone validation at the gate) -----------

test('gender required: submit blocked when no gender is picked', () => {
    const { window, document, opened, sheetCalls, alerts } = loadPage();
    try {
        fillGate(document, window, { gender: null });
        window.sendGateSecurityPass();
        assert.equal(opened.length, 0, 'no WhatsApp window must open');
        assert.equal(sheetCalls.length, 0, 'nothing must be logged');
        assert.ok(alerts.length >= 1 && alerts[0].includes('లింగం'), 'warning must ask for the gender');
    } finally { window.close(); }
});

test('no mobile: submit succeeds with no mobile asked anywhere', () => {
    const { window, document, opened, sheetCalls } = loadPage();
    try {
        assert.equal(document.getElementById('gateMobile'), null, 'no mobile input in the form');
        fillGate(document, window, { gender: 'Male' });
        window.sendGateSecurityPass();
        assert.equal(opened.length, 1, 'pass must go through with no mobile');
        assert.equal(sheetCalls.length, 1, 'Sheet log must happen with no mobile');
        assert.ok(!('mobile' in sheetCalls[0][1]), 'Sheet payload must carry no mobile key');
        const { text } = waText(opened[0]);
        assert.ok(!text.includes('మొబైల్'), 'WhatsApp text must have no mobile line');
        assert.ok(opened[0].startsWith('https://wa.me/919966157369?text='), 'WhatsApp still goes to Availo');
    } finally { window.close(); }
});

test('photo: submit blocked with no photo attached', () => {
    const { window, document, opened, sheetCalls } = loadPage();
    try {
        fillGate(document, window, { gender: 'Male', photo: false });
        window.sendGateSecurityPass();
        assert.equal(opened.length, 0, 'no photo => no stamp, no submit');
        assert.equal(sheetCalls.length, 0);
    } finally { window.close(); }
});

// --- Photo resize --------------------------------------------------------------

test('photo resize: small photo is NOT upscaled', () => {
    fakeImgSize = { w: 400, h: 300 };
    const { window, document, opened, sheetCalls, ctxs } = loadPage();
    try {
        fillGate(document, window, { gender: 'Male' });
        window.sendGateSecurityPass();
        assert.equal(opened.length, 1);
        assert.equal(sheetCalls[0][1].photoData, 'data:image/jpeg;base64,FAKEJPEGDATA');
        assert.equal(ctxs[1].el.width, 400, '400px photo stays 400px');
        assert.equal(ctxs[1].el.height, 300);
    } finally { fakeImgSize = { w: 1600, h: 1200 }; window.close(); }
});

test('photo that fails to load still logs the pass (photoData empty, never blocks)', () => {
    fakeImgSize = { w: 0, h: 0 };
    const { window, document, opened, sheetCalls } = loadPage();
    try {
        fillGate(document, window, { gender: 'Male' });
        window.sendGateSecurityPass();
        assert.equal(opened.length, 1, 'pass must still go through');
        assert.equal(sheetCalls.length, 1);
        assert.equal(sheetCalls[0][1].photoData, '', 'no usable image => empty photoData');
        assert.equal(sheetCalls[0][1].photo, 'captured');
    } finally { fakeImgSize = { w: 1600, h: 1200 }; window.close(); }
});

// --- Admin panel: display masking (maskMobileNumber / thumbnails / reveal) -----

const GATE_HEADERS = ['Timestamp', 'Ref', 'Apartment', 'Flat', 'Delivery Partner', 'Photo Captured', 'Language', 'Mobile', 'Gender', 'Date', 'Time', 'Photo'];
const FEMALE_PHOTO = 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/view?usp=drivesdk';
const MALE_PHOTO = 'https://drive.google.com/file/d/2BcDeFgHiJkLmNoPqRsTuVwXyZ/view?usp=drivesdk';
const FEMALE_ROW = ['18/11/2026 20:10:18', 'AV-20261118-9001', 'TEST', 'TEST-201', 'Swiggy', 'captured', 'te', '9876543210', 'Female', '18/11/2026', '20:15:00', FEMALE_PHOTO];
const MALE_ROW = ['18/11/2026 20:12:44', 'AV-20261118-9002', 'TEST', 'TEST-202', 'Zomato', 'captured', 'te', '9876543211', 'Male', '18/11/2026', '20:16:00', MALE_PHOTO];

test('admin maskMobileNumber: 98******19 for a 10-digit number', () => {
    const { window } = loadAdmin();
    try {
        assert.equal(window.maskMobileNumber('9865432119'), '98******19');
        assert.equal(window.maskMobileNumber('9966157369'), '99******69');
        assert.equal(window.maskMobileNumber('99661 57369'), '99******69');
        assert.equal(window.maskMobileNumber('123'), '123');
    } finally { window.close(); }
});

test('admin driveFileId / driveThumbnailUrl: Drive URL -> thumbnail, garbage -> null', () => {
    const { window } = loadAdmin();
    try {
        assert.equal(window.driveFileId(FEMALE_PHOTO), '1AbCdEfGhIjKlMnOpQrStUvWxYz');
        assert.equal(window.driveThumbnailUrl(FEMALE_PHOTO), 'https://drive.google.com/thumbnail?id=1AbCdEfGhIjKlMnOpQrStUvWxYz&sz=w400');
        assert.equal(window.driveFileId('https://example.com/photo.jpg'), null);
        assert.equal(window.driveThumbnailUrl('https://example.com/photo.jpg'), null);
        assert.equal(window.driveThumbnailUrl(''), null);
        assert.equal(window.driveThumbnailUrl(null), null);
    } finally { window.close(); }
});

test('admin panel: Female row shows masked number + blurred thumbnail, each with a per-row reveal', async () => {
    const { window, document } = await loadAdminReady({ GatePass: { ok: true, headers: GATE_HEADERS, rows: [FEMALE_ROW, MALE_ROW] } });
    try {
        const rows = document.querySelectorAll('#tableBody tr');
        assert.equal(rows.length, 2, 'two GatePass rows must render');
        const fCells = rows[0].querySelectorAll('td');
        // Mobile (col 7): masked + reveal button.
        assert.ok(fCells[7].textContent.includes('98******10'), 'female number must be shown masked');
        assert.ok(!fCells[7].textContent.includes('9876543210'), 'female full number must NOT be visible before reveal');
        const mobBtn = fCells[7].querySelector('button.reveal-btn');
        assert.ok(mobBtn, 'female mobile cell must have a reveal button');
        assert.equal(mobBtn.textContent, '👁 చూపించు');
        mobBtn.click();
        assert.ok(fCells[7].textContent.includes('9876543210'), 'reveal must show the full number to the admin');
        assert.equal(mobBtn.textContent, '🙈 దాచు');
        mobBtn.click();
        assert.ok(fCells[7].textContent.includes('98******10'), 'clicking again must mask it again');
        // Photo (col 11): blurred thumbnail + reveal button, linked to Drive.
        const img = fCells[11].querySelector('img');
        assert.ok(img, 'female photo cell must have a thumbnail');
        assert.equal(img.getAttribute('src'), 'https://drive.google.com/thumbnail?id=1AbCdEfGhIjKlMnOpQrStUvWxYz&sz=w400');
        assert.ok(img.classList.contains('gate-photo-blurred'), 'female thumbnail must start blurred');
        const link = fCells[11].querySelector('a');
        assert.equal(link.getAttribute('href'), FEMALE_PHOTO, 'thumbnail must link to the full Drive file');
        assert.equal(link.getAttribute('target'), '_blank');
        const photoBtn = fCells[11].querySelector('button.reveal-btn');
        assert.ok(photoBtn, 'female photo cell must have a reveal button');
        photoBtn.click();
        assert.ok(!img.classList.contains('gate-photo-blurred'), 'reveal must unblur the thumbnail');
        photoBtn.click();
        assert.ok(img.classList.contains('gate-photo-blurred'), 'hide must blur it again');
    } finally { window.close(); }
});

test('admin panel: Male row shows full number + clear thumbnail, no reveal buttons', async () => {
    const { window, document } = await loadAdminReady({ GatePass: { ok: true, headers: GATE_HEADERS, rows: [FEMALE_ROW, MALE_ROW] } });
    try {
        const rows = document.querySelectorAll('#tableBody tr');
        const mCells = rows[1].querySelectorAll('td');
        assert.equal(mCells[7].textContent, '9876543211', 'male number must be shown in full');
        assert.equal(mCells[7].querySelector('button'), null, 'male mobile cell must have no reveal button');
        const img = mCells[11].querySelector('img');
        assert.ok(img, 'male photo cell must have a thumbnail');
        assert.equal(img.getAttribute('src'), 'https://drive.google.com/thumbnail?id=2BcDeFgHiJkLmNoPqRsTuVwXyZ&sz=w400');
        assert.ok(!img.classList.contains('gate-photo-blurred'), 'male thumbnail must be clear');
        assert.equal(mCells[11].querySelector('button'), null, 'male photo cell must have no reveal button');
    } finally { window.close(); }
});

test('admin panel: no Gender column => no masking anywhere', async () => {
    const { window, document } = await loadAdminReady({ GatePass: { ok: true, headers: ['Timestamp', 'Ref', 'Apartment', 'Flat', 'Delivery Partner', 'Photo Captured', 'Language', 'Mobile', 'Date', 'Time', 'Photo'], rows: [['18/11/2026 20:10:18', 'AV-20261118-9001', 'TEST', 'TEST-201', 'Swiggy', 'captured', 'te', '9876543210', '18/11/2026', '20:15:00', FEMALE_PHOTO]] } });
    try {
        const cells = document.querySelectorAll('#tableBody tr')[0].querySelectorAll('td');
        assert.equal(cells[7].textContent, '9876543210', 'without a Gender column the number must be shown in full');
        assert.equal(cells[7].querySelector('button'), null);
        const img = cells[10].querySelector('img');
        assert.ok(img, 'photo thumbnail still renders without a Gender column');
        assert.ok(!img.classList.contains('gate-photo-blurred'), 'no Gender column => no blur');
    } finally { window.close(); }
});

test('admin panel: unparseable photo URL falls back to a plain-text link; empty photo stays empty', async () => {
    const weird = FEMALE_ROW.slice(); weird[11] = 'https://example.com/photo.jpg';
    const empty = FEMALE_ROW.slice(); empty[11] = '';
    const { window, document } = await loadAdminReady({ GatePass: { ok: true, headers: GATE_HEADERS, rows: [weird, empty] } });
    try {
        const rows = document.querySelectorAll('#tableBody tr');
        const wCell = rows[0].querySelectorAll('td')[11];
        const wLink = wCell.querySelector('a');
        assert.ok(wLink, 'unparseable photo URL must still be a link');
        assert.equal(wLink.getAttribute('href'), 'https://example.com/photo.jpg');
        assert.equal(wLink.textContent, 'https://example.com/photo.jpg');
        assert.equal(wCell.querySelector('img'), null, 'no thumbnail when the Drive ID cannot be extracted');
        assert.equal(wCell.querySelector('button'), null, 'no reveal button for a plain link');
        assert.equal(rows[1].querySelectorAll('td')[11].textContent, '', 'empty photo stays empty');
    } finally { window.close(); }
});

// --- availo-db.js: keepalive vs photo payload ---------------------------------

function loadDb() {
    const src = fs.readFileSync(DB_JS, 'utf8');
    const calls = [];
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
        url: 'https://availoservices.in/',
        runScripts: 'outside-only',
    });
    dom.window.fetch = (url, opts) => { calls.push({ url, opts }); return Promise.resolve({}); };
    dom.window.eval(src);
    return { window: dom.window, calls };
}

test('sendToSheet drops keepalive when the whole payload exceeds the ~64KB cap', () => {
    const { window, calls } = loadDb();
    try {
        window.sendToSheet('GatePass', { ref: 'AV-20261118-0001', photoData: 'data:image/jpeg;base64,' + 'A'.repeat(70000) });
        assert.equal(calls.length, 1);
        assert.equal(calls[0].opts.keepalive, false, 'keepalive must be off for a >60KB total body');
        const body = JSON.parse(calls[0].opts.body);
        assert.equal(body.photoData.length, 70000 + 23);
    } finally { window.close(); }
});

test('sendToSheet keeps keepalive for a mid-size photo that fits under the cap (M-G5)', () => {
    const { window, calls } = loadDb();
    try {
        // ~50KB total payload: fits under the ~64KB keepalive cap, so the
        // POST survives the tab closing (old code dropped keepalive for
        // any photo over 40KB).
        window.sendToSheet('GatePass', { ref: 'AV-20261118-0001', photoData: 'data:image/jpeg;base64,' + 'A'.repeat(50000) });
        assert.equal(calls.length, 1);
        assert.equal(calls[0].opts.keepalive, true, 'keepalive must stay on while the whole body fits');
    } finally { window.close(); }
});

test('sendToSheet keeps keepalive for small payloads', () => {
    const { window, calls } = loadDb();
    try {
        window.sendToSheet('GatePass', { ref: 'AV-20261118-0001', mobile: '9966157369' });
        assert.equal(calls.length, 1);
        assert.equal(calls[0].opts.keepalive, true);
    } finally { window.close(); }
});

// Owner rule (23 Nov 2026): the visitor-facing Gate Pass form must NEVER
// mention the admin panel or who can see the data — storage/display details
// are not the visitor's business. Women get only the safety assurance;
// the photo note only says the photo stays confidential. (Admin-side
// masking in admin.html itself is unchanged and still tested above.)
test('gate form notes never mention the admin panel; women get only the safety assurance', () => {
    const { window, document } = loadPage();
    try {
        const section = document.getElementById('gate-section');
        assert.ok(section, 'gate section must exist');
        const html = section.innerHTML;
        assert.ok(!html.includes('అడ్మిన్'), 'gate form must not mention the admin panel (Telugu)');
        assert.ok(!/admin panel/i.test(html), 'gate form must not mention the admin panel (English)');
        assert.ok(!/एडमिन/i.test(html), 'gate form must not mention the admin panel (Hindi)');
        assert.ok(html.includes('మహిళలకు భద్రత సౌకర్యం కలదు'), 'gender note must carry the women-safety assurance');
        assert.ok(html.includes('మీ ఫోటో గోప్యంగా ఉంటుంది'), 'photo note must say the photo stays confidential');
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
