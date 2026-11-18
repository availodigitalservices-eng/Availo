// WhatsApp "&" truncation fix — regression tests (18 Nov 2026).
// A category (or any free-text value) containing "&" used to split the
// wa.me query string, so WhatsApp received only "Category: Hotels" and the
// plan, business name, contact and phone never arrived. Every value
// interpolated into a wa.me message must be encodeURIComponent'd ("&" ->
// %26); the literal %0A newline separators in the templates stay as-is.
//
// Run:  node whatsapp-encode.test.js   (from this directory)
//        npm test                       (runs all test files)

const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const INDEX_HTML = path.join(__dirname, '..', 'index.html');

// Extract the single inline <script> (no src) from index.html.
function inlineScript() {
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    const m = html.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(m, 'inline script block not found in index.html');
    return { html, script: m[1] };
}

// Fresh page per test, same mocks as the Mayura tests.
function loadPage() {
    const { html, script } = inlineScript();
    const opened = [];      // window.open calls (wa.me links)
    const sheetCalls = [];  // sendToSheet calls (availo-db.js is external, mock it)
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
        },
    });
    dom.window.eval(script);
    return { window: dom.window, document: dom.window.document, opened, sheetCalls };
}

// The wa.me text param, decoded the way WhatsApp receives it.
function waText(url) {
    const u = new URL(url);
    return { params: [...u.searchParams.keys()], text: u.searchParams.get('text') };
}

// Fill + submit the trial form; returns the single wa.me URL opened.
function submitTrial(doc, window, { category, business, contact, phone, location = '' }) {
    doc.getElementById('trialCategory').value = category;
    doc.getElementById('trialBusinessName').value = business;
    doc.getElementById('trialContactName').value = contact;
    doc.getElementById('trialPhone').value = phone;
    doc.getElementById('trialLocation').value = location;
    window.submitTrialApplication();
}

// Shared assertions for a complete trial application in the WhatsApp text.
function assertFullTrial(url, expected) {
    assert.ok(url.startsWith('https://wa.me/919966157369?text='), 'wa.me link: ' + url.slice(0, 80));
    const { params, text } = waText(url);
    assert.deepEqual(params, ['text'], 'the & must not split the query string; params: ' + params.join(','));
    assert.ok(text, 'text param must be present');
    for (const [label, value] of Object.entries(expected)) {
        assert.ok(text.includes(value), `decoded WhatsApp text must contain ${label} ${JSON.stringify(value)}; got: ${text.slice(0, 300)}`);
    }
    assert.match(text, /AV-\d{8}-\d{4}/, 'reference number must be in the text');
    assert.ok(url.includes('%26') === expected.category.includes('&'),
        'raw URL must carry %26 exactly when a value contains &');
    return text;
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// --- Trial form: the three "&" categories ------------------------------------

test('trial: "Hotels & Dining" sends the FULL application on WhatsApp', () => {
    const { window, document, opened } = loadPage();
    try {
        submitTrial(document, window, { category: 'Hotels & Dining', business: 'Test Hotel', contact: 'Test Person', phone: '9966157369' });
        assert.equal(opened.length, 1, 'one WhatsApp window must open');
        assertFullTrial(opened[0], { category: 'Hotels & Dining', business: 'Test Hotel', contact: 'Test Person', phone: '9966157369', plan: 'Free Trial (1-Week Pilot)' });
    } finally { window.close(); }
});

test('trial: "Salons & Spa" sends the FULL application on WhatsApp', () => {
    const { window, document, opened } = loadPage();
    try {
        submitTrial(document, window, { category: 'Salons & Spa', business: 'Glow Salon', contact: 'Anitha', phone: '8686761098' });
        assert.equal(opened.length, 1);
        assertFullTrial(opened[0], { category: 'Salons & Spa', business: 'Glow Salon', contact: 'Anitha', phone: '8686761098', plan: 'Free Trial (1-Week Pilot)' });
    } finally { window.close(); }
});

test('trial: "Apartments (Smart Gate & Care)" sends the FULL application', () => {
    const { window, document, opened } = loadPage();
    try {
        submitTrial(document, window, { category: 'Apartments (Smart Gate & Care)', business: 'Royal Residency', contact: 'Suresh', phone: '9966157369', location: 'Vijayawada' });
        assert.equal(opened.length, 1);
        assertFullTrial(opened[0], { category: 'Apartments (Smart Gate & Care)', business: 'Royal Residency', contact: 'Suresh', phone: '9966157369', location: 'Vijayawada' });
    } finally { window.close(); }
});

// --- No "&": content must be unchanged, no double-encoding ------------------

test('trial: category without "&" is unchanged and never double-encoded', () => {
    const { window, document, opened } = loadPage();
    try {
        submitTrial(document, window, { category: 'Restaurants', business: 'Sri Foods', contact: 'Ramu', phone: '9966157369' });
        assert.equal(opened.length, 1);
        const text = assertFullTrial(opened[0], { category: 'Restaurants', business: 'Sri Foods', contact: 'Ramu', phone: '9966157369' });
        assert.ok(!text.includes('%0A'), 'decoded text must have real newlines, not literal %0A');
        assert.ok(!text.includes('%26'), 'decoded text must have no literal %26');
        assert.ok(!opened[0].includes('%25'), 'raw URL must have no %25 (double-encoding)');
        assert.ok(opened[0].includes('%0A'), 'newlines must still be %0A separators in the raw URL');
    } finally { window.close(); }
});

// --- Technician form: free-text "&" in a name --------------------------------

test('technician: name with "&" sends the FULL application on WhatsApp', () => {
    const { window, document, opened } = loadPage();
    try {
        document.getElementById('techName').value = 'Ravi & Kumar';
        document.getElementById('techPhone').value = '9966157369';
        document.getElementById('techSkill').value = 'Electrician';
        document.getElementById('techExperience').value = '1-3 years';
        document.getElementById('techArea').value = 'Benz Circle';
        document.getElementById('techIdProof').checked = true;
        window.submitTechnicianApplication();
        assert.equal(opened.length, 1, 'one WhatsApp window must open');
        const { params, text } = waText(opened[0]);
        assert.deepEqual(params, ['text'], 'the & must not split the query string');
        for (const value of ['Ravi & Kumar', '9966157369', 'Electrician', '1-3 years', 'Benz Circle']) {
            assert.ok(text.includes(value), `decoded text must contain ${JSON.stringify(value)}; got: ${text.slice(0, 300)}`);
        }
        assert.match(text, /AV-\d{8}-\d{4}/, 'reference number must be in the text');
        assert.ok(opened[0].includes('%26'), 'raw URL must carry %26 for the & in the name');
    } finally { window.close(); }
});

// --- Secondary fix in the same change: Dine tile icon ------------------------

test('Dine tile icon has the stronger-contrast circle (not the pale bubble)', () => {
    const { window, document } = loadPage();
    try {
        const dineIcon = document.querySelector('.b2b-item .tile-icon-dine');
        assert.ok(dineIcon, 'Dine tile icon must carry the tile-icon-dine class');
        assert.equal(dineIcon.textContent.trim(), '🍽️');
        const style = [...document.querySelectorAll('style')].map(s => s.textContent).join('\n');
        assert.ok(style.includes('.tile-icon-dine'), 'CSS must define .tile-icon-dine');
        assert.ok(style.includes('#93c5fd'), 'Dine icon circle must use the stronger blue');
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
