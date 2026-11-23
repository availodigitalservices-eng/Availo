// Dine (dine.html) — coupons / offers / loyalty (22 Nov 2026).
// Feature 4 of 8.
// COUPONS: a code box on the order-confirm overlay, validated against
// HOTEL_COUPONS (default EMPTY {} — no codes exist until the restaurant
// gives them; NEVER invent a coupon code, discount, or offer). Valid code
// -> discount on the order total (percent of items total, or flat, never
// below zero), shown on the slip ("Coupon AVAILO10: −₹X"), recorded in
// the Firebase order record ({coupon, discount}) and in the WhatsApp KOT
// message. Invalid code -> trilingual "wrong code" note, order unaffected.
// LOYALTY: stamp card in localStorage (availo_loyalty_stamps); one stamp
// per confirmed order; progress shown on Dine ("మీ స్టాంపులు: 3/5"). The
// reward is config-gated (LOYALTY_REWARD, EMPTY default — while empty the
// loyalty section is hidden entirely; NEVER invent a reward). At the
// threshold the reward text shows; tapping "claim" resets the count and
// the NEXT order's Firebase record carries loyaltyClaim:true.
// dine-owner.html: read-only "Coupon redemptions" view (orders that used
// a coupon, newest first). No coupon creation UI.
// Discount math is exact 2-decimal rounding, same as fmtPrice.
//
// Run:  node dine-coupons-loyalty.test.js   (from this directory)
//        npm test                            (runs all test files)

const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const DINE_HTML = path.join(__dirname, '..', 'dine.html');
const OWNER_HTML = path.join(__dirname, '..', 'dine-owner.html');
const DINE_ORDERS_PATH = 'availo-kitchen-v1/dineOrders/khaleel';

function inlineScript(file) {
    const html = fs.readFileSync(file, 'utf8');
    const m = html.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(m, 'inline script block not found in ' + file);
    return { html, script: m[1] };
}

// Fake Firebase RTDB (in-memory) — same model as dine-upi-payment.test.js:
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

// Fresh Dine page per test.
function loadPage(url, opts) {
    const { html, script } = inlineScript(DINE_HTML);
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

// Fresh owner page per test (same loader as dine-owner.test.js).
function loadOwnerPage(opts) {
    const { html, script } = inlineScript(OWNER_HTML);
    const fb = (opts && opts.firebase) || makeFirebaseMock();
    const dom = new JSDOM(html, {
        url: 'https://availoservices.in/dine-owner.html',
        runScripts: 'outside-only',
        pretendToBeVisual: true,
        beforeParse(window) {
            window.firebase = fb.firebase;
        },
    });
    dom.window.eval(script);
    return { window: dom.window, document: dom.window.document, fb };
}

// Put one dish in the cart and open the confirm overlay.
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

function applyCode(window, document, code) {
    document.getElementById('couponInput').value = code;
    window.applyCouponCode();
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// --- (1) Config defaults: nothing invented ---------------------------------

test('config defaults: HOTEL_COUPONS is empty and LOYALTY_REWARD is null (source-level)', () => {
    const src = fs.readFileSync(DINE_HTML, 'utf8');
    assert.ok(src.includes('let HOTEL_COUPONS = {};'), 'no coupon codes on file — never invented');
    assert.ok(src.includes('let LOYALTY_REWARD = null;'), 'no loyalty reward on file — never invented');
    const { window, document } = loadPage();
    try {
        assert.equal(window.couponsConfigured(), false, 'no coupons configured by default');
        assert.equal(window.loyaltyConfigured(), false, 'no loyalty reward configured by default');
        assert.equal(document.getElementById('loyaltySection').style.display, 'none', 'loyalty section hidden while unconfigured');
    } finally { window.close(); }
});

test('no invented coupons: with empty config no code can ever validate', () => {
    const { window } = loadPage();
    try {
        // (Property checks, not deepEqual: objects come from the jsdom
        // realm, whose Object prototype differs from Node's.)
        for (const code of ['AVAILO10', 'WELCOME50', 'FREE']) {
            const r = window.couponDiscount(code, 1000);
            assert.equal(r.ok, false, code + ' must not validate with an empty config');
            assert.equal(r.reason, 'invalid');
        }
    } finally { window.close(); }
});

// --- (2) Coupon validation + discount math ---------------------------------

test('couponDiscount: percent coupon (10% of 500 -> 50)', () => {
    const { window } = loadPage();
    try {
        window.setHotelCoupons({ AVAILO10: { type: 'percent', value: 10 } });
        const r = window.couponDiscount('AVAILO10', 500);
        assert.equal(r.ok, true);
        assert.equal(r.code, 'AVAILO10');
        assert.equal(r.discount, 50);
        assert.equal(r.type, 'percent');
    } finally { window.close(); }
});

test('couponDiscount: percent rounding (10% of 333.33 -> 33.33, exact 2-decimal)', () => {
    const { window } = loadPage();
    try {
        window.setHotelCoupons({ AVAILO10: { type: 'percent', value: 10 } });
        assert.equal(window.couponDiscount('AVAILO10', 333.33).discount, 33.33);
        window.setHotelCoupons({ SAVE15: { type: 'percent', value: 15 } });
        assert.equal(window.couponDiscount('SAVE15', 408.57).discount, 61.29, '15% of 408.57 = 61.2855 -> 61.29');
    } finally { window.close(); }
});

test('couponDiscount: flat coupon (100 off 408.57 -> 100)', () => {
    const { window } = loadPage();
    try {
        window.setHotelCoupons({ FLAT100: { type: 'flat', value: 100 } });
        const r = window.couponDiscount('FLAT100', 408.57);
        assert.equal(r.ok, true);
        assert.equal(r.discount, 100);
        assert.equal(r.type, 'flat');
    } finally { window.close(); }
});

test('couponDiscount: flat discount is capped at the bill (flat 500 off 100 -> 100)', () => {
    const { window } = loadPage();
    try {
        window.setHotelCoupons({ FLAT500: { type: 'flat', value: 500 } });
        assert.equal(window.couponDiscount('FLAT500', 100).discount, 100, 'discount never exceeds the subtotal');
        window.setHotelCoupons({ MEGA: { type: 'percent', value: 150 } });
        assert.equal(window.couponDiscount('MEGA', 200).discount, 200, '150% is capped at the subtotal');
    } finally { window.close(); }
});

test('couponDiscount: minOrder enforced (min 500, bill 400 -> not ok, bill 500 -> ok)', () => {
    const { window } = loadPage();
    try {
        window.setHotelCoupons({ AVAILO10: { type: 'percent', value: 10, minOrder: 500 } });
        const low = window.couponDiscount('AVAILO10', 400);
        assert.equal(low.ok, false);
        assert.equal(low.reason, 'minOrder');
        assert.equal(low.minOrder, 500);
        const exact = window.couponDiscount('AVAILO10', 500);
        assert.equal(exact.ok, true);
        assert.equal(exact.discount, 50);
    } finally { window.close(); }
});

test('couponDiscount: invalid code / bad config entries never validate', () => {
    const { window } = loadPage();
    try {
        window.setHotelCoupons({ AVAILO10: { type: 'percent', value: 10 } });
        assert.equal(window.couponDiscount('WRONGCODE', 1000).ok, false, 'unknown code');
        assert.equal(window.couponDiscount('', 1000).ok, false, 'empty code');
        assert.equal(window.couponDiscount('AVAILO10', 0).ok, false, 'zero bill');
        assert.equal(window.couponDiscount('AVAILO10', -5).ok, false, 'negative bill');
        window.setHotelCoupons({ BADTYPE: { type: 'bogus', value: 10 } });
        assert.equal(window.couponDiscount('BADTYPE', 1000).ok, false, 'unknown type');
        window.setHotelCoupons({ BADVALUE: { type: 'percent', value: 0 } });
        assert.equal(window.couponDiscount('BADVALUE', 1000).ok, false, 'zero value');
        window.setHotelCoupons({ NEGVALUE: { type: 'flat', value: -50 } });
        assert.equal(window.couponDiscount('NEGVALUE', 1000).ok, false, 'negative value');
    } finally { window.close(); }
});

test('couponDiscount: code is normalised (lowercase + spaces match)', () => {
    const { window } = loadPage();
    try {
        window.setHotelCoupons({ AVAILO10: { type: 'percent', value: 10 } });
        assert.equal(window.couponDiscount('availo10', 500).discount, 50, 'lowercase matches');
        assert.equal(window.couponDiscount('  Availo10  ', 500).discount, 50, 'surrounding spaces are trimmed');
    } finally { window.close(); }
});

test('applyCouponDiscount: payable never goes below zero', () => {
    const { window } = loadPage();
    try {
        assert.equal(window.applyCouponDiscount(408.57, 100), 308.57);
        assert.equal(window.applyCouponDiscount(100, 100), 0);
        assert.equal(window.applyCouponDiscount(100, 500), 0, 'discount bigger than the bill -> 0, never negative');
        assert.equal(window.applyCouponDiscount(408.57, 0), 408.57, 'no discount -> same total');
        assert.equal(window.applyCouponDiscount(333.33, 33.33), 300, '2-decimal exact: 333.33 - 33.33 = 300');
    } finally { window.close(); }
});

// --- (3) withCouponLine / withLoyaltyClaimLine (KOT message) ---------------

test('withCouponLine: inserts coupon line and rewrites the total to the payable', () => {
    const { window } = loadPage();
    try {
        const msg = '*AVAILO LIVE KOT (ఆర్డర్ స్లిప్)*%0A*మొత్తం బిల్లు:* ₹408.57%0A*సమయం:* 10:00:00 PM';
        const out = window.withCouponLine(msg, 'AVAILO10', 40.86, 408.57);
        assert.ok(out.includes('%0A*Coupon AVAILO10:* −₹40.86%0A*సమయం:*'), 'coupon line sits before the time line: ' + out);
        assert.ok(out.includes('*మొత్తం బిల్లు:* ₹367.71'), 'total is rewritten to the payable 367.71: ' + out);
    } finally { window.close(); }
});

test('withCouponLine: no coupon -> message untouched; missing marker -> appended', () => {
    const { window } = loadPage();
    try {
        const msg = '*AVAILO LIVE KOT*%0A*మొత్తం బిల్లు:* ₹100.00%0A*సమయం:* 10:00:00 PM';
        assert.equal(window.withCouponLine(msg, null, 0, 100), msg, 'null coupon leaves the message alone');
        assert.equal(window.withCouponLine(msg, '', 10, 100), msg, 'empty coupon leaves the message alone');
        assert.equal(window.withCouponLine('plain message', 'AVAILO10', 10, 100), 'plain message%0A*Coupon AVAILO10:* −₹10.00', 'no marker -> appended');
    } finally { window.close(); }
});

test('withLoyaltyClaimLine: inserts the claim line before the time line', () => {
    const { window } = loadPage();
    try {
        const msg = '*AVAILO LIVE KOT*%0A*మొత్తం బిల్లు:* ₹100.00%0A*సమయం:* 10:00:00 PM';
        assert.ok(window.withLoyaltyClaimLine(msg).includes('%0A*Loyalty:* Reward claimed%0A*సమయం:*'), 'claim line before time line');
    } finally { window.close(); }
});

// --- (4) Confirm overlay: apply / invalid / remove --------------------------

test('overlay apply: valid code shows the discount and updates the payable total', () => {
    const { window, document } = loadPage();
    try {
        window.setHotelCoupons({ AVAILO10: { type: 'percent', value: 10 } });
        const subtotal = openConfirmWithOneItem(window, document);
        applyCode(window, document, 'AVAILO10');
        const discount = Math.round(subtotal * 10) / 100;
        const payable = Math.round((subtotal - discount) * 100) / 100;
        const line = document.getElementById('couponAppliedLine');
        assert.equal(line.style.display, 'block', 'applied line is shown');
        assert.ok(line.textContent.includes('AVAILO10'), 'line names the code: ' + line.textContent);
        assert.ok(line.textContent.includes(window.fmtPrice(discount)), 'line shows the discount: ' + line.textContent);
        assert.equal(document.getElementById('couponMsg').style.display, 'none', 'no error note');
        const body = document.getElementById('orderConfirmBody').innerHTML;
        assert.ok(body.includes('కూపన్ AVAILO10'), 'summary shows the coupon line');
        assert.ok(body.includes('చెల్లించాల్సిన మొత్తం:'), 'summary shows a payable line');
        assert.ok(body.includes(window.fmtPrice(payable)), 'summary shows the payable total ' + window.fmtPrice(payable));
    } finally { window.close(); }
});

test('overlay apply: UPI confirm button shows the DISCOUNTED total', () => {
    const fb = makeFirebaseMock();
    const { window, document } = loadPage(null, { firebase: fb });
    try {
        window.setHotelUpiConfig('khaleel@okhdfcbank', 'Khaleel Bhai Family Restaurant');
        window.setHotelCoupons({ AVAILO10: { type: 'percent', value: 10 } });
        const subtotal = openConfirmWithOneItem(window, document);
        window.setPaymentMethod('upi');
        applyCode(window, document, 'AVAILO10');
        const discount = Math.round(subtotal * 10) / 100;
        const payable = Math.round((subtotal - discount) * 100) / 100;
        assert.ok(payable > 0, 'test bill must stay above zero after the discount');
        const label = document.getElementById('confirmOrderBtn').innerText;
        assert.ok(label.includes('UPI'), 'still the UPI pay button: ' + label);
        assert.ok(label.includes(window.fmtPrice(payable)), 'button charges the payable ' + window.fmtPrice(payable) + ', not the subtotal: ' + label);
    } finally { window.close(); }
});

test('overlay apply: invalid code shows the wrong-code note and the order is unaffected', () => {
    const { window, document } = loadPage();
    try {
        window.setHotelCoupons({ AVAILO10: { type: 'percent', value: 10 } });
        const subtotal = openConfirmWithOneItem(window, document);
        applyCode(window, document, 'WRONGCODE');
        const note = document.getElementById('couponMsg');
        assert.equal(note.style.display, 'block', 'error note is shown');
        assert.ok(note.innerText.includes('తప్పు కోడ్'), 'trilingual wrong-code note: ' + note.innerText);
        assert.equal(document.getElementById('couponAppliedLine').style.display, 'none', 'no applied line');
        assert.ok(document.getElementById('orderConfirmBody').innerHTML.includes(window.fmtPrice(subtotal)), 'summary still shows the full total');
        assert.ok(document.getElementById('confirmOrderBtn').innerText.includes('నిర్ధారించి పంపండి'), 'confirm button unchanged');
    } finally { window.close(); }
});

test('overlay apply: below-minOrder code shows the min-order note', () => {
    const { window, document } = loadPage();
    try {
        window.setHotelCoupons({ BIG10: { type: 'percent', value: 10, minOrder: 1000 } });
        openConfirmWithOneItem(window, document);
        applyCode(window, document, 'BIG10');
        const note = document.getElementById('couponMsg');
        assert.equal(note.style.display, 'block');
        assert.ok(note.innerText.includes('₹1,000.00') || note.innerText.includes('1000'), 'note names the minimum order: ' + note.innerText);
    } finally { window.close(); }
});

test('overlay apply: an invalid attempt does not clear an already-applied coupon', () => {
    const { window, document } = loadPage();
    try {
        window.setHotelCoupons({ AVAILO10: { type: 'percent', value: 10 } });
        openConfirmWithOneItem(window, document);
        applyCode(window, document, 'AVAILO10');
        assert.equal(document.getElementById('couponAppliedLine').style.display, 'block', 'valid coupon applied');
        applyCode(window, document, 'NOPE');
        assert.equal(document.getElementById('couponAppliedLine').style.display, 'block', 'valid coupon still applied after a bad attempt');
        assert.ok(document.getElementById('couponAppliedLine').textContent.includes('AVAILO10'), 'still the first coupon');
    } finally { window.close(); }
});

test('overlay remove: clearing the coupon restores the full total', () => {
    const { window, document } = loadPage();
    try {
        window.setHotelCoupons({ AVAILO10: { type: 'percent', value: 10 } });
        const subtotal = openConfirmWithOneItem(window, document);
        applyCode(window, document, 'AVAILO10');
        assert.equal(document.getElementById('couponAppliedLine').style.display, 'block');
        window.clearCoupon();
        assert.equal(document.getElementById('couponAppliedLine').style.display, 'none', 'applied line hidden');
        assert.equal(document.getElementById('couponInput').value, '', 'input cleared');
        assert.ok(document.getElementById('orderConfirmBody').innerHTML.includes(window.fmtPrice(subtotal)), 'summary back to the full total');
    } finally { window.close(); }
});

// --- (5) End-to-end: coupon order -------------------------------------------

test('confirm with coupon: KOT carries the coupon line + payable, Firebase record has coupon/discount/discounted total', () => {
    const fb = makeFirebaseMock();
    const { window, document, opened } = loadPage(null, { firebase: fb });
    try {
        window.setHotelCoupons({ AVAILO10: { type: 'percent', value: 10 } });
        const subtotal = openConfirmWithOneItem(window, document);
        applyCode(window, document, 'AVAILO10');
        const discount = Math.round(subtotal * 10) / 100;
        const payable = Math.round((subtotal - discount) * 100) / 100;
        window.confirmOrderSend();
        assert.equal(opened.length, 1, 'one WhatsApp window opens');
        assert.ok(opened[0].includes('*Coupon AVAILO10:*'), 'KOT names the coupon');
        assert.ok(opened[0].includes('−' + window.fmtPrice(discount)), 'KOT shows the discount');
        assert.ok(opened[0].includes('*మొత్తం బిల్లు:* ' + window.fmtPrice(payable)), 'KOT total is the payable, not the subtotal');
        const write = findDineOrderWrite(fb.writes);
        assert.ok(write, 'a dine order record must be written to Firebase');
        assert.equal(write.value.coupon, 'AVAILO10', 'record coupon code');
        assert.equal(write.value.discount, discount, 'record discount');
        assert.equal(write.value.total, payable, 'record total is the payable');
        assert.equal(write.value.payment, 'cash', 'record payment unchanged');
        assert.equal(write.value.status, 'received', 'record status unchanged');
    } finally { window.close(); }
});

test('confirm without coupon: record has no coupon field and KOT has no coupon line', () => {
    const fb = makeFirebaseMock();
    const { window, document, opened } = loadPage(null, { firebase: fb });
    try {
        openConfirmWithOneItem(window, document);
        window.confirmOrderSend();
        assert.equal(opened.length, 1, 'one WhatsApp window opens');
        assert.ok(!opened[0].includes('*Coupon'), 'KOT has no coupon line');
        const write = findDineOrderWrite(fb.writes);
        assert.ok(write, 'a dine order record must be written to Firebase');
        assert.ok(!('coupon' in write.value), 'record has no coupon field');
        assert.ok(!('discount' in write.value), 'record has no discount field');
    } finally { window.close(); }
});

test('buildDineOrderRecord: coupon extras discount the record; no extras -> unchanged', () => {
    const fb = makeFirebaseMock();
    const { window, document } = loadPage(null, { firebase: fb });
    try {
        const subtotal = openConfirmWithOneItem(window, document);
        const rec = window.eval('buildDineOrderRecord("AV-DINE-T1", "cash", {coupon: "FLAT50", discount: 50})');
        assert.equal(rec.coupon, 'FLAT50');
        assert.equal(rec.discount, 50);
        assert.equal(rec.total, Math.round((subtotal - 50) * 100) / 100, 'record total is the payable');
        const plain = window.eval('buildDineOrderRecord("AV-DINE-T2", "cash")');
        assert.ok(!('coupon' in plain), 'no extras -> no coupon field');
        assert.equal(plain.total, subtotal, 'no extras -> full total');
    } finally { window.close(); }
});

// --- (6) Loyalty: stamps, progress, claim ----------------------------------

// M-A4 (23 Nov 2026): stamps accrue ONLY while a reward is configured.
// A confirmed order with no reward on file earns nothing — a regular must
// not instantly hold a full card if a reward is configured later.
test('loyalty: a confirmed order adds one stamp ONLY when a reward is configured (localStorage)', () => {
    const fb = makeFirebaseMock();
    const p1 = loadPage(null, { firebase: fb });
    try {
        assert.equal(p1.window.loyaltyStamps(), 0, 'starts at 0 stamps');
        openConfirmWithOneItem(p1.window, p1.document);
        p1.window.confirmOrderSend();
        assert.equal(p1.window.loyaltyStamps(), 0, 'no reward configured -> no stamp');
        assert.equal(p1.window.localStorage.getItem('availo_loyalty_stamps'), null, 'nothing stored while unconfigured');
    } finally { p1.window.close(); }
    const p2 = loadPage(null, { firebase: fb });
    try {
        p2.window.setLoyaltyReward({ stamps: 5, text: 'Free Butter Milk' });
        openConfirmWithOneItem(p2.window, p2.document);
        p2.window.confirmOrderSend();
        assert.equal(p2.window.loyaltyStamps(), 1, 'one confirmed order -> 1 stamp once configured');
        assert.equal(p2.window.localStorage.getItem('availo_loyalty_stamps'), '1', 'stamp count is stored on the phone');
    } finally { p2.window.close(); }
});

test('loyalty: section is hidden while unconfigured, shows progress once configured', () => {
    const { window, document } = loadPage();
    try {
        assert.equal(document.getElementById('loyaltySection').style.display, 'none', 'hidden with no reward');
        window.setLoyaltyReward({ stamps: 5, text: 'Free Butter Milk' });
        assert.equal(window.loyaltyConfigured(), true);
        assert.equal(document.getElementById('loyaltySection').style.display, 'block', 'shown once configured');
        assert.ok(document.getElementById('loyaltyProgress').innerText.includes('0/5'), 'progress starts 0/5: ' + document.getElementById('loyaltyProgress').innerText);
        window.loyaltySetStamps(3);
        window.renderLoyalty();
        assert.ok(document.getElementById('loyaltyProgress').innerText.includes('3/5'), 'progress shows 3/5: ' + document.getElementById('loyaltyProgress').innerText);
        assert.equal(document.getElementById('loyaltyRewardBox').style.display, 'none', 'reward box hidden below the threshold');
    } finally { window.close(); }
});

test('loyalty: reward box appears at the threshold and claim resets the count', () => {
    const { window, document } = loadPage();
    try {
        window.setLoyaltyReward({ stamps: 5, text: { te: 'ఉచిత బటర్ మిల్క్', en: 'Free Butter Milk', hi: 'मुफ़्त बटर मिल्क' } });
        window.loyaltySetStamps(4);
        window.renderLoyalty();
        assert.equal(document.getElementById('loyaltyRewardBox').style.display, 'none', '4/5 -> no reward yet');
        window.loyaltyAddStamp();
        assert.equal(window.loyaltyStamps(), 5, '5th stamp earned');
        assert.equal(document.getElementById('loyaltyRewardBox').style.display, 'block', 'reward box appears at 5/5');
        assert.ok(document.getElementById('loyaltyRewardText').innerText.includes('ఉచిత బటర్ మిల్క్'), 'reward text is the configured one: ' + document.getElementById('loyaltyRewardText').innerText);
        window.claimLoyaltyReward();
        assert.equal(window.loyaltyStamps(), 0, 'claim resets the count to 0');
        assert.equal(window.loyaltyClaimPending(), true, 'claim is pending for the next order');
        assert.equal(document.getElementById('loyaltyRewardBox').style.display, 'none', 'reward box hides after the claim');
    } finally { window.close(); }
});

test('loyalty: claim below the threshold does nothing', () => {
    const { window, document } = loadPage();
    try {
        window.setLoyaltyReward({ stamps: 5, text: 'Free Butter Milk' });
        window.loyaltySetStamps(3);
        assert.equal(window.loyaltyClaim(), false, '3/5 -> cannot claim');
        assert.equal(window.loyaltyStamps(), 3, 'count untouched');
        assert.equal(window.loyaltyClaimPending(), false, 'no pending claim');
        window.claimLoyaltyReward();
        assert.equal(window.loyaltyStamps(), 3, 'claim button also does nothing below the threshold');
    } finally { window.close(); }
});

test('loyalty: a claimed reward rides on the NEXT order (Firebase + KOT) and the flag clears', () => {
    const fb = makeFirebaseMock();
    const { window, document, opened } = loadPage(null, { firebase: fb });
    try {
        window.setLoyaltyReward({ stamps: 5, text: 'Free Butter Milk' });
        window.loyaltySetStamps(5);
        assert.equal(window.loyaltyClaim(), true, 'claim at 5/5');
        const subtotal = openConfirmWithOneItem(window, document);
        window.confirmOrderSend();
        assert.equal(opened.length, 1, 'one WhatsApp window opens');
        assert.ok(opened[0].includes('*Loyalty:* Reward claimed'), 'KOT tells the kitchen about the claim');
        const write = findDineOrderWrite(fb.writes);
        assert.ok(write, 'a dine order record must be written to Firebase');
        assert.equal(write.value.loyaltyClaim, true, 'record carries loyaltyClaim:true');
        assert.equal(write.value.total, subtotal, 'record total is unaffected by the claim');
        assert.equal(window.loyaltyClaimPending(), false, 'pending flag clears after the order');
        assert.equal(window.loyaltyStamps(), 1, 'the new order earns its own stamp after the reset');
    } finally { window.close(); }
});

test('loyalty: without a claim the order record has no loyaltyClaim field', () => {
    const fb = makeFirebaseMock();
    const { window, document } = loadPage(null, { firebase: fb });
    try {
        window.setLoyaltyReward({ stamps: 5, text: 'Free Butter Milk' });
        openConfirmWithOneItem(window, document);
        window.confirmOrderSend();
        const write = findDineOrderWrite(fb.writes);
        assert.ok(write, 'a dine order record must be written to Firebase');
        assert.ok(!('loyaltyClaim' in write.value), 'record has no loyaltyClaim field without a claim');
    } finally { window.close(); }
});

test('loyalty: invalid reward config is rejected (no threshold, no text)', () => {
    const { window } = loadPage();
    try {
        window.setLoyaltyReward({ stamps: 0, text: 'Free X' });
        assert.equal(window.loyaltyConfigured(), false, 'zero stamps -> not configured');
        window.setLoyaltyReward({ stamps: 5 });
        assert.equal(window.loyaltyConfigured(), false, 'no reward text -> not configured');
        window.setLoyaltyReward({ stamps: 5, text: '   ' });
        assert.equal(window.loyaltyConfigured(), false, 'blank reward text -> not configured');
        window.setLoyaltyReward(null);
        assert.equal(window.loyaltyConfigured(), false, 'null -> not configured');
    } finally { window.close(); }
});

// --- (7) Owner page: coupon redemptions (read-only) -------------------------

test('owner page: coupon redemptions list shows only coupon orders, newest first', () => {
    const fb = makeFirebaseMock();
    const { window, document } = loadOwnerPage({ firebase: fb });
    try {
        const list = document.getElementById('ownerCouponList');
        assert.ok(list, 'coupon redemptions section must exist');
        assert.ok(list.textContent.includes('ఇంకా కూపన్ వాడకాలు లేవు'), 'empty state before any orders');
        fb.setPath(DINE_ORDERS_PATH + '/AV-DINE-20261121-100000', { items: [{ qty: 2 }], total: 750.5, coupon: 'AVAILO10', discount: 75.05, createdAt: 1000 });
        fb.setPath(DINE_ORDERS_PATH + '/AV-DINE-20261121-110000', { items: [{ qty: 1 }], total: 408.57, createdAt: 2000 }); // no coupon
        fb.setPath(DINE_ORDERS_PATH + '/AV-DINE-20261121-120000', { items: [{ qty: 3 }], total: 900, coupon: 'FLAT100', discount: 100, loyaltyClaim: true, createdAt: 3000 });
        const rows = [...document.querySelectorAll('#ownerCouponList .owner-row')];
        assert.equal(rows.length, 2, 'only the 2 coupon orders are listed, not the plain order');
        assert.ok(rows[0].textContent.includes('FLAT100'), 'newest first: FLAT100 on top');
        assert.ok(rows[0].textContent.includes('₹100.00'), 'discount shown: ' + rows[0].textContent);
        assert.ok(rows[0].textContent.includes('₹900.00'), 'total shown');
        assert.ok(rows[0].textContent.includes('లాయల్టీ క్లెయిమ్'), 'loyalty claim is marked');
        assert.ok(rows[1].textContent.includes('AVAILO10'), 'second row is AVAILO10');
        assert.ok(rows[1].textContent.includes('₹75.05'), 'second discount shown');
        assert.ok(document.getElementById('ownerCouponCount').textContent.includes('2'), 'count shows 2 orders');
        assert.equal(document.querySelectorAll('#ownerCouponList input, #ownerCouponList button').length, 0, 'read-only: no inputs or buttons in the redemptions view');
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
