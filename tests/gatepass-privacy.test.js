// Gate Pass privacy + fields — tests (18 Nov 2026).
// Owner spec: the Gate Pass database must have Mobile, Date, Time, Photo.
// Ladies' number + photo are MORPHED: the number is masked (98******19)
// and the photo is strongly blurred before upload. ONE gender field
// (Male/Female, no default) drives the privacy rule. Male entries are
// stored/sent in full, unchanged.
//
// Run:  node gatepass-privacy.test.js   (from this directory)
//        npm test                        (runs all test files)

const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const INDEX_HTML = path.join(__dirname, '..', 'index.html');
const DB_JS = path.join(__dirname, '..', 'availo-db.js');

// Extract the single inline <script> (no src) from index.html.
function inlineScript() {
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    const m = html.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(m, 'inline script block not found in index.html');
    return { html, script: m[1] };
}

// Fake photo size used by the stubbed Image (per test).
let fakeImgSize = { w: 1600, h: 1200 };
// When true, the fake canvas ctx has NO `filter` property (old browsers).
let noCanvasFilter = false;

function makeCtx() {
    const ctx = {
        drawImageCalls: [],
        imageSmoothingEnabled: true,
        fillRect() {}, strokeRect() {}, setLineDash() {}, fillText() {},
        drawImage(img, x, y, w, h) { this.drawImageCalls.push({ filterAtDraw: this.filter, w, h, img }); },
    };
    if (!noCanvasFilter) ctx.filter = 'none';
    return ctx;
}

// Fresh page per test. Canvas/Image/URL/alert are stubbed because jsdom
// has no real canvas or image loading.
function loadPage() {
    const { html, script } = inlineScript();
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

// The wa.me text param, decoded the way WhatsApp receives it.
function waText(url) {
    const u = new URL(url);
    return { params: [...u.searchParams.keys()], text: u.searchParams.get('text') };
}

// Fill the Gate Pass form (apartment, flat, partner chip, mobile, gender
// chip, photo) then call submit. Gender may be null (not picked).
function fillGate(doc, window, { apt = 'Sri Sai Heights', flat = '302', partner = 'Swiggy', mobile = '9966157369', gender = null, photo = true }) {
    doc.getElementById('gateApartment').value = apt;
    doc.getElementById('gateFlatNo').value = flat;
    const chip = [...doc.querySelectorAll('#gatePartnerChips button')].find(b => b.getAttribute('data-value') === partner);
    assert.ok(chip, 'partner chip ' + partner + ' must exist');
    chip.click();
    doc.getElementById('gateMobile').value = mobile;
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

// --- Pure helpers ------------------------------------------------------------

test('maskMobileNumber: 98******19 for a 10-digit number', () => {
    const { window } = loadPage();
    try {
        assert.equal(window.maskMobileNumber('9865432119'), '98******19');
        assert.equal(window.maskMobileNumber('9966157369'), '99******69');
        assert.equal(window.maskMobileNumber('99661 57369'), '99******69');
        assert.equal(window.maskMobileNumber('123'), '123');
    } finally { window.close(); }
});

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
        assert.ok(document.getElementById('gateMobile'), 'mobile input must exist');
        // No chip pre-selected: submitting with everything else valid must
        // still be blocked (see the gender-required test below).
        assert.equal(chips.filter(c => c.style.background === 'rgb(79, 70, 229)' || c.style.background === '#4f46e5').length, 0);
    } finally { window.close(); }
});

// --- Female end-to-end: masked number + blurred photo ------------------------

test('female: Sheet gets masked number, blurred photo, date/time; WhatsApp masked too', () => {
    const { window, document, opened, sheetCalls, ctxs } = loadPage();
    try {
        fillGate(document, window, { gender: 'Female' });
        window.sendGateSecurityPass();
        assert.equal(opened.length, 1, 'one WhatsApp window must open');
        assert.equal(sheetCalls.length, 1, 'one Sheet log must happen');
        const payload = sheetCalls[0][1];
        assert.equal(sheetCalls[0][0], 'GatePass');
        assert.equal(payload.mobile, '99******69', 'female number must be masked in the Sheet');
        assert.equal(payload.gender, 'Female');
        assert.match(payload.date, /^\d{2}\/\d{2}\/\d{4}$/, 'date column present');
        assert.match(payload.time, /^\d{2}:\d{2}:\d{2}$/, 'time column present');
        assert.equal(payload.photo, 'captured');
        assert.equal(payload.photoData, 'data:image/jpeg;base64,FAKEJPEGDATA', 'resized photo data URL must be sent');
        assert.match(payload.ref, /AV-\d{8}-\d{4}/);
        assert.ok(!JSON.stringify(payload).includes('9966157369'), 'raw number must appear NOWHERE in the Sheet payload');
        // WhatsApp: masked number, never the raw one.
        const { params, text } = waText(opened[0]);
        assert.deepEqual(params, ['text']);
        assert.ok(text.includes('99******69'), 'WhatsApp must show the masked number');
        assert.ok(!text.includes('9966157369'), 'WhatsApp must never show the raw number');
        assert.ok(text.includes('స్త్రీ'), 'WhatsApp must include the gender');
        assert.ok(text.includes(payload.date) && text.includes(payload.time), 'WhatsApp must include date + time');
        // Blur: the photo canvas (2nd ctx; 1st is the stamp) drew with blur.
        assert.equal(ctxs.length, 2, 'stamp + photo canvases');
        assert.equal(ctxs[1].ctx.drawImageCalls[0].filterAtDraw, 'blur(24px)', 'female photo must be drawn with a strong blur');
        assert.equal(ctxs[1].el.width, 800, 'photo resized to max 800px wide');
        assert.equal(ctxs[1].el.height, 600, '1600x1200 keeps aspect at 800x600');
    } finally { window.close(); }
});

// --- Male end-to-end: full number + clear photo ------------------------------

test('male: Sheet + WhatsApp get the FULL number and a clear (unblurred) photo', () => {
    const { window, document, opened, sheetCalls, ctxs } = loadPage();
    try {
        fillGate(document, window, { gender: 'Male' });
        window.sendGateSecurityPass();
        assert.equal(opened.length, 1);
        assert.equal(sheetCalls.length, 1);
        const payload = sheetCalls[0][1];
        assert.equal(payload.mobile, '9966157369', 'male number must be stored in full');
        assert.equal(payload.gender, 'Male');
        assert.equal(payload.photoData, 'data:image/jpeg;base64,FAKEJPEGDATA');
        const { text } = waText(opened[0]);
        assert.ok(text.includes('9966157369'), 'WhatsApp must show the full number for male');
        assert.ok(text.includes('పురుషుడు'), 'WhatsApp must include the gender');
        assert.equal(ctxs[1].ctx.drawImageCalls[0].filterAtDraw, 'none', 'male photo must NOT be blurred');
    } finally { window.close(); }
});

// --- Validation: phone + gender + photo required ------------------------------

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

test('phone: spaces stripped, valid 10-digit number passes', () => {
    const { window, document, opened, sheetCalls } = loadPage();
    try {
        fillGate(document, window, { gender: 'Male', mobile: '99661 57369' });
        window.sendGateSecurityPass();
        assert.equal(opened.length, 1);
        assert.equal(sheetCalls[0][1].mobile, '9966157369', 'spaces must be stripped before saving');
    } finally { window.close(); }
});

test('phone: letters in the number are rejected', () => {
    const { window, document, opened, sheetCalls } = loadPage();
    try {
        fillGate(document, window, { gender: 'Male', mobile: '99a99 99999' });
        window.sendGateSecurityPass();
        assert.equal(opened.length, 0, 'letters must block the submit');
        assert.equal(sheetCalls.length, 0);
    } finally { window.close(); }
});

test('phone: short number and 5-starting number are rejected', () => {
    for (const bad of ['99999', '5123456789']) {
        const { window, document, opened, sheetCalls } = loadPage();
        try {
            fillGate(document, window, { gender: 'Male', mobile: bad });
            window.sendGateSecurityPass();
            assert.equal(opened.length, 0, bad + ' must block the submit');
            assert.equal(sheetCalls.length, 0);
        } finally { window.close(); }
    }
});

test('phone: empty mobile blocks the submit', () => {
    const { window, document, opened, sheetCalls } = loadPage();
    try {
        fillGate(document, window, { gender: 'Male', mobile: '' });
        window.sendGateSecurityPass();
        assert.equal(opened.length, 0);
        assert.equal(sheetCalls.length, 0);
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

// --- Photo resize + blur fallback ---------------------------------------------

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

test('blur fallback: no ctx.filter => pixelate path (tiny canvas), still unidentifiable', () => {
    noCanvasFilter = true;
    const { window, document, opened, sheetCalls, ctxs } = loadPage();
    try {
        fillGate(document, window, { gender: 'Female' });
        window.sendGateSecurityPass();
        assert.equal(opened.length, 1);
        assert.equal(sheetCalls[0][1].mobile, '99******69');
        assert.equal(sheetCalls[0][1].photoData, 'data:image/jpeg;base64,FAKEJPEGDATA');
        // stamp ctx + photo ctx + tiny ctx
        assert.equal(ctxs.length, 3, 'stamp + photo + tiny canvases');
        assert.equal(ctxs[2].el.width, 24, 'fallback crushes the image to 24px wide first');
        assert.equal(ctxs[1].ctx.drawImageCalls[0].img, ctxs[2].el, 'photo canvas draws the crushed tiny image, not the raw photo');
        assert.equal(ctxs[1].ctx.drawImageCalls[0].filterAtDraw, undefined, 'no blur filter exists in this browser path');
    } finally { noCanvasFilter = false; window.close(); }
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

test('sendToSheet drops keepalive when a photo is attached (64KB cap)', () => {
    const { window, calls } = loadDb();
    try {
        window.sendToSheet('GatePass', { ref: 'AV-20261118-0001', photoData: 'data:image/jpeg;base64,' + 'A'.repeat(50000) });
        assert.equal(calls.length, 1);
        assert.equal(calls[0].opts.keepalive, false, 'keepalive must be off for a >64KB photo body');
        const body = JSON.parse(calls[0].opts.body);
        assert.equal(body.photoData.length, 50000 + 23);
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
