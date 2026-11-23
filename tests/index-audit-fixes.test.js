// index.html audit fixes — regression tests (PRE-LIVE-AUDIT-2026-11-23 §4).
// M-D1 gate double-submit guard, M-D4 NRI double-submit guard,
// M-G3 photo-verified line only when a photo actually arrived,
// M-G7 gate stamp date in IST, M-G8 WhatsApp retry link,
// M-V1 dead mayuraListen() deleted, M-V2 speaking pill emoji,
// M-A6 rate-card sub-line wording.
//
// Run:  node index-audit-fixes.test.js   (from this directory)
//        npm test                         (runs all test files)

const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const INDEX_HTML = path.join(__dirname, '..', 'index.html');
const INDEX_SRC = fs.readFileSync(INDEX_HTML, 'utf8');

// Extract the single inline <script> (no src) from index.html.
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

// The wa.me text param, decoded the way WhatsApp receives it.
function waText(url) {
    const u = new URL(url);
    return { params: [...u.searchParams.keys()], text: u.searchParams.get('text') };
}

// Fill the Gate Pass form (apartment, flat, partner chip, gender chip,
// photo) then call submit. No mobile number is asked at the gate.
function fillGate(doc, window, { apt = 'Sri Sai Heights', flat = '302', partner = 'Swiggy', gender = 'Male', photo = true }) {
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

// Attach a fresh gate photo (simulates the guard retaking the photo for a
// new pass — the double-submit guard lifts only on a new photo).
function attachGatePhoto(doc, window) {
    const file = new window.File(['fake-bytes-2'], 'photo2.jpg', { type: 'image/jpeg' });
    window.onGatePhotoSelected({ target: { files: [file], value: '' } });
}

function fillNRI(doc, { name = 'Suresh', phone = '9876543210', parents = 'Rama Rao (68 Yrs)', address = 'Flat 302, Royal Towers, Vijayawada', needs = 'Monthly Medicines' } = {}) {
    doc.getElementById('nriClientName').value = name;
    doc.getElementById('nriClientPhone').value = phone;
    doc.getElementById('nriParentsName').value = parents;
    doc.getElementById('nriAddress').value = address;
    doc.getElementById('nriNeeds').value = needs;
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// --- M-D1: gate pass double-submit guard -----------------------------------

test('M-D1 gate: two rapid submits -> one Sheet row, one WhatsApp tab, button disabled', () => {
    const { window, document, opened, sheetCalls } = loadPage();
    try {
        fillGate(document, window, { gender: 'Male' });
        const btn = document.getElementById('gateSubmitBtn');
        assert.ok(btn, 'gate submit button must have an id for the guard');
        assert.equal(btn.disabled, false, 'button starts enabled');
        window.sendGateSecurityPass();
        assert.equal(sheetCalls.length, 1, 'first submit logs one Sheet row');
        assert.equal(opened.length, 1, 'first submit opens one WhatsApp tab');
        assert.equal(btn.disabled, true, 'button disabled while sent');
        assert.equal(btn.style.opacity, '0.6', 'disabled button dimmed (Trial pattern)');
        const ret = window.sendGateSecurityPass();
        assert.equal(ret, false, 'second rapid submit must be refused');
        assert.equal(sheetCalls.length, 1, 'no second Sheet row on double-tap');
        assert.equal(opened.length, 1, 'no second WhatsApp tab on double-tap');
        assert.equal(sheetCalls[0][1].ref, document.getElementById('gateRefVal').textContent, 'shown ref is the logged ref');
    } finally { window.close(); }
});

test('M-D1 gate: guard lifts when a new photo is attached (next pass works)', () => {
    const { window, document, opened, sheetCalls } = loadPage();
    try {
        fillGate(document, window, { gender: 'Male' });
        window.sendGateSecurityPass();
        assert.equal(sheetCalls.length, 1);
        attachGatePhoto(document, window);
        assert.equal(document.getElementById('gateSubmitBtn').disabled, false, 'new photo re-enables the button');
        window.sendGateSecurityPass();
        assert.equal(sheetCalls.length, 2, 'a new pass after a new photo must log again');
        assert.equal(opened.length, 2, 'a new pass after a new photo must open WhatsApp again');
        assert.notEqual(sheetCalls[0][1].ref, sheetCalls[1][1].ref, 'second pass gets its own ref');
    } finally { window.close(); }
});

test('M-D1 gate: validation failure does NOT lock the form', () => {
    const { window, document, opened, sheetCalls } = loadPage();
    try {
        fillGate(document, window, { gender: null }); // no gender -> blocked
        window.sendGateSecurityPass();
        assert.equal(sheetCalls.length, 0, 'invalid submit logs nothing');
        assert.equal(opened.length, 0, 'invalid submit opens nothing');
        assert.equal(document.getElementById('gateSubmitBtn').disabled, false, 'button must stay enabled after a validation failure');
        // Fix the form and submit: it must go through.
        const g = [...document.querySelectorAll('#gateGenderChips button')].find(b => b.getAttribute('data-value') === 'Male');
        g.click();
        window.sendGateSecurityPass();
        assert.equal(sheetCalls.length, 1, 'submit works after fixing the form');
        assert.equal(opened.length, 1);
    } finally { window.close(); }
});

// --- M-D4: NRI double-submit guard ------------------------------------------

test('M-D4 NRI: two rapid submits -> one Sheet row, one WhatsApp tab, button disabled', () => {
    const { window, document, opened, sheetCalls } = loadPage();
    try {
        fillNRI(document);
        const btn = document.getElementById('nriSubmitBtn');
        assert.ok(btn, 'NRI submit button must have an id for the guard');
        window.submitNRIApplication();
        assert.equal(sheetCalls.length, 1, 'first submit logs one Sheet row');
        assert.equal(sheetCalls[0][0], 'NRI');
        assert.equal(opened.length, 1, 'first submit opens one WhatsApp tab');
        assert.equal(btn.disabled, true, 'button disabled while sent');
        const ret = window.submitNRIApplication();
        assert.equal(ret, false, 'second rapid submit must be refused');
        assert.equal(sheetCalls.length, 1, 'no second Sheet row on double-tap');
        assert.equal(opened.length, 1, 'no second WhatsApp tab on double-tap');
    } finally { window.close(); }
});

test('M-D4 NRI: validation failure does NOT lock the form', () => {
    const { window, document, opened, sheetCalls } = loadPage();
    try {
        window.submitNRIApplication(); // empty form -> blocked
        assert.equal(sheetCalls.length, 0, 'invalid submit logs nothing');
        assert.equal(opened.length, 0, 'invalid submit opens nothing');
        assert.equal(document.getElementById('nriSubmitBtn').disabled, false, 'button must stay enabled after a validation failure');
        fillNRI(document);
        window.submitNRIApplication();
        assert.equal(sheetCalls.length, 1, 'submit works after filling the form');
        assert.equal(opened.length, 1);
    } finally { window.close(); }
});

test('M-D4 NRI: resetNRIForm lifts the guard (re-open works like Trial)', () => {
    const { window, document, opened, sheetCalls } = loadPage();
    try {
        fillNRI(document);
        window.submitNRIApplication();
        assert.equal(sheetCalls.length, 1);
        window.resetNRIForm();
        assert.equal(document.getElementById('nriSubmitBtn').disabled, false, 'reset re-enables the button');
        assert.equal(document.getElementById('nriClientName').value, '', 'reset wipes the previous applicant (shared phone)');
        fillNRI(document, { name: 'Priya' });
        window.submitNRIApplication();
        assert.equal(sheetCalls.length, 2, 'a second application after reset must log again');
        assert.equal(opened.length, 2);
    } finally { window.close(); }
});

// --- M-G3: photo-verified line is conditional on photoData -------------------

test('M-G3 gate: photo arrived -> WhatsApp says verified, no retake line', () => {
    const { window, document, opened } = loadPage();
    try {
        fillGate(document, window, { gender: 'Female' });
        window.sendGateSecurityPass();
        assert.equal(opened.length, 1);
        const { text } = waText(opened[0]);
        assert.ok(text.includes('వెరిఫై చేయబడింది'), 'verified line present when the photo arrived');
        assert.ok(!text.includes('మళ్ళీ ఫోటో'), 'no retake line when the photo arrived');
    } finally { window.close(); }
});

test('M-G3 gate: photo failed to load -> WhatsApp asks for a retake, never claims verified', () => {
    fakeImgSize = { w: 0, h: 0 };
    const { window, document, opened, sheetCalls } = loadPage();
    try {
        fillGate(document, window, { gender: 'Male' });
        window.sendGateSecurityPass();
        assert.equal(opened.length, 1, 'pass must still go through');
        assert.equal(sheetCalls.length, 1);
        assert.equal(sheetCalls[0][1].photoData, '', 'no usable image => empty photoData');
        const { text } = waText(opened[0]);
        assert.ok(!text.includes('వెరిఫై చేయబడింది'), 'must NOT claim the photo was verified when none arrived');
        assert.ok(text.includes('మళ్ళీ ఫోటో తీయండి'), 'must ask for a retake when the photo failed');
    } finally { fakeImgSize = { w: 1600, h: 1200 }; window.close(); }
});

// --- M-G7: gate stamp date is IST --------------------------------------------

test('M-G7 stampDateStr: 23:30 UTC on 18 Nov is 19 Nov in IST', () => {
    const { window } = loadPage();
    try {
        assert.equal(window.stampDateStr(new Date('2026-11-18T23:30:00Z')), '19-NOV-2026', 'IST is +5:30, so 23:30 UTC is already the next day in IST');
        assert.equal(window.stampDateStr(new Date('2026-11-18T02:30:00Z')), '18-NOV-2026', '02:30 UTC is 08:00 IST on the same day');
        assert.equal(window.stampDateStr(new Date('2026-12-31T20:30:00Z')), '01-JAN-2027', 'year boundary: 20:30 UTC on 31 Dec is 02:00 IST on 1 Jan');
        assert.match(window.stampDateStr(new Date('2026-11-23T12:00:00Z')), /^\d{2}-[A-Z]{3}-\d{4}$/, 'DD-MMM-YYYY format');
    } finally { window.close(); }
});

// --- M-G8: WhatsApp retry link -----------------------------------------------

test('M-G8 gate: confirm panel has a retry link that re-opens the SAME WhatsApp message', () => {
    const { window, document, opened } = loadPage();
    try {
        const link = document.getElementById('gateWaRetryLink');
        assert.ok(link, 'retry link must exist in the confirm panel');
        assert.equal(link.getAttribute('data-te'), 'WhatsApp తెరవలేదా? ఇక్కడ నొక్కి మళ్ళీ ప్రయత్నించండి');
        assert.equal(link.getAttribute('data-en'), "WhatsApp didn't open? Tap here to try again");
        assert.equal(link.getAttribute('data-hi'), 'WhatsApp नहीं खुला? फिर से कोशिश के लिए यहाँ टैप करें');
        // Before any submit there is no message to retry: tapping opens nothing.
        window.retryGateWhatsApp();
        assert.equal(opened.length, 0, 'retry before submit must open nothing');
        fillGate(document, window, { gender: 'Male' });
        window.sendGateSecurityPass();
        assert.equal(opened.length, 1, 'submit opens WhatsApp once');
        assert.equal(link.getAttribute('href'), opened[0], 'retry link points at the exact submitted message');
        // jsdom with runScripts:'outside-only' does not run inline onclick
        // attributes, so the tap itself is simulated by calling the wired
        // function — and the wiring is asserted on the attribute below.
        assert.ok((link.getAttribute('onclick') || '').includes('retryGateWhatsApp'), 'retry link must be wired to retryGateWhatsApp');
        window.retryGateWhatsApp();
        assert.equal(opened.length, 2, 'retry opens WhatsApp again');
        assert.equal(opened[1], opened[0], 'retry re-opens the SAME message (no new ref, no new Sheet row)');
    } finally { window.close(); }
});

// --- M-V1: dead mayuraListen() deleted ----------------------------------------

test('M-V1 mayuraListen is gone (no function, no definition in source)', () => {
    const { window, document } = loadPage();
    try {
        assert.equal(typeof window.mayuraListen, 'undefined', 'mayuraListen must not exist on window');
        assert.ok(!/function mayuraListen/.test(INDEX_SRC), 'no mayuraListen definition may remain in index.html');
        // The listen line element stays — mayuraSendText / mayuraShowError
        // still use it; only the dead mic function was deleted.
        assert.ok(document.getElementById('mayuraListenLine'), 'mayuraListenLine element must stay (used by text send + errors)');
        assert.equal(typeof window.mayuraSendText, 'function', 'text send still wired');
        assert.equal(typeof window.mayuraReplayGreeting, 'function', 'replay still wired');
    } finally { window.close(); }
});

// --- M-V2: speaking pill emoji -----------------------------------------------

test('M-V2 speaking pill shows 🔊, never 🎙️ (all 3 languages)', () => {
    const { window, document } = loadPage();
    try {
        assert.ok(INDEX_SRC.includes('🔊 మయూర మాట్లాడుతోంది…'), 'Telugu pill text must use 🔊');
        assert.ok(INDEX_SRC.includes('🔊 मयूरा बोल रही है…'), 'Hindi pill text must use 🔊');
        assert.ok(INDEX_SRC.includes('🔊 Mayura is speaking…'), 'English pill text must use 🔊');
        assert.ok(!INDEX_SRC.includes('🎙️'), 'no 🎙️ may remain anywhere in index.html');
        const promptEl = document.getElementById('promptTxt');
        assert.ok(promptEl, 'promptTxt must exist');
        window.setMayuraSpeaking(true);
        assert.ok(promptEl.innerHTML.includes('🔊'), 'speaking state shows 🔊 at runtime');
        assert.ok(!promptEl.innerHTML.includes('🎙️'), 'speaking state never shows 🎙️ at runtime');
        window.setMayuraSpeaking(false);
    } finally { window.close(); }
});

// --- M-A6: rate-card sub-line --------------------------------------------------

test('M-A6 rate-card sub-line says prices are coming soon (all 3 languages)', () => {
    const { window, document } = loadPage();
    try {
        const p = document.querySelector('#rate-card p');
        assert.ok(p, 'rate-card sub-line must exist');
        assert.equal(p.getAttribute('data-en'), 'Prices coming soon — ask on WhatsApp');
        assert.equal(p.getAttribute('data-te'), 'ధరలు త్వరలో వస్తాయి — WhatsAppలో అడగండి');
        assert.equal(p.getAttribute('data-hi'), 'कीमतें जल्द आ रही हैं — WhatsApp पर पूछें');
        assert.ok(!/Starting prices/i.test(p.innerHTML), 'must not say "Starting prices" while all rates are Coming soon');
        assert.ok(!p.innerHTML.includes('ప్రారంభ ధరలు'), 'must not say "ప్రారంభ ధరలు" while all rates are Coming soon');
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
