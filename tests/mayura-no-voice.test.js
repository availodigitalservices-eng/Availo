// Mayura panel — NO voice tests (owner order, 18 Nov 2026).
// Tapping Mayura only opens the panel silently: no greeting speech, no MP3,
// no mic input, no replay. Type + Send and the quick-action buttons must
// still work, and the panel must still close.
//
// Run:  node mayura-no-voice.test.js      (from this directory)
//        npm test                          (runs both test files)

const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const INDEX_HTML = path.join(__dirname, '..', 'index.html');

const GREETING_TEXT = {
    te: "నమస్కారం! నేను మీ అవైలో మయూరను. స్కాన్ చేసి మీ డోర్‌స్టెప్ వద్దకే సర్వీస్ పొందండి. సైడ్ మెనూ టచ్ చేసి అన్ని సర్వీసులను చూడండి.",
    en: "Welcome to AVAILO Digital Services! One platform, multiple possibilities. Touch the side menu to explore all verified services.",
    hi: "नमस्ते! मैं आपकी अवैलो मयूरा हूँ। स्कैन करें और अपने डोरस्टेप पर ही सर्विस पाएँ। साइड मेनू को टच करके सभी सेवाएँ देखें।",
};

const PILL_TEXT = {
    te: 'టచ్ చేయండి — మయూర అసిస్టెంట్',
    en: 'Touch — Mayura Assistant',
    hi: 'टच करें — मयूरा असिस्टेंट',
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Extract the single inline <script> (no src) from index.html.
function inlineScript() {
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    const m = html.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(m, 'inline script block not found in index.html');
    return { html, script: m[1] };
}

// Build a fresh page with a mocked speechSynthesis / Audio.
// voices: array of { name, lang } or null to simulate "no speechSynthesis".
function loadPage(voices) {
    const { html, script } = inlineScript();
    const spoken = [];        // utterances passed to speechSynthesis.speak()
    const audioPlayed = [];    // Audio instances created by playMayuraMp3()
    const opened = [];         // window.open calls (wa.me links)
    const sheetCalls = [];     // sendToSheet calls (availo-db.js is external, mock it)
    let voiceList = Array.isArray(voices) ? voices : [];

    const dom = new JSDOM(html, {
        url: 'https://availoservices.in/',
        runScripts: 'outside-only',
        pretendToBeVisual: true,
        beforeParse(window) {
            if (voices !== null) {
                window.speechSynthesis = {
                    getVoices: () => voiceList.slice(),
                    speak: u => { spoken.push(u); },
                    cancel: () => {},
                    onvoiceschanged: null,
                };
            }
            window.SpeechSynthesisUtterance = class {
                constructor(text) { this.text = text; this.lang = ''; this.voice = null; this.pitch = 1; this.rate = 1; this.onend = null; this.onerror = null; }
            };
            window.Audio = class {
                constructor(src) { this.src = src; this.onended = null; this.onerror = null; audioPlayed.push(this); }
                play() { return Promise.resolve(); }
                pause() {}
            };
            window.open = (url) => { opened.push(url); return null; };
            window.sendToSheet = (...args) => { sheetCalls.push(args); };
        },
    });
    dom.window.eval(script);
    return { window: dom.window, document: dom.window.document, spoken, audioPlayed, opened, sheetCalls, setVoices(v) { voiceList = v; } };
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// --- (1) Tap opens the panel, NEVER speaks ---------------------------------

test('tap with TTS voices present: panel opens, nothing is spoken, no MP3', async () => {
    const { window, document, spoken, audioPlayed } = loadPage([
        { name: 'Microsoft Ravi - Telugu (India)', lang: 'te-IN' },
        { name: 'English (India) Male', lang: 'en-IN' },
    ]);
    try {
        window.speakMayura();
        assert.ok(document.getElementById('mayuraPanel').classList.contains('active'), 'panel opens on tap');
        await sleep(1500);
        assert.equal(spoken.length, 0, 'speechSynthesis.speak must never be called');
        assert.equal(audioPlayed.length, 0, 'no MP3 fallback either');
    } finally { window.close(); }
});

test('tap with NO TTS voices: panel opens, MP3 fallback does NOT play', async () => {
    const { window, document, spoken, audioPlayed } = loadPage([]);
    try {
        window.speakMayura();
        assert.ok(document.getElementById('mayuraPanel').classList.contains('active'), 'panel opens on tap');
        await sleep(1500);
        assert.equal(spoken.length, 0);
        assert.equal(audioPlayed.length, 0, 'MP3 fallback must not play on tap');
    } finally { window.close(); }
});

test('tap with no speechSynthesis in browser: panel opens, nothing plays', async () => {
    const { window, document, spoken, audioPlayed } = loadPage(null);
    try {
        window.speakMayura();
        assert.ok(document.getElementById('mayuraPanel').classList.contains('active'), 'panel opens on tap');
        await sleep(600);
        assert.equal(spoken.length, 0);
        assert.equal(audioPlayed.length, 0);
    } finally { window.close(); }
});

test('tap in every language: still silent, greeting text still shown', async () => {
    const { window, document, spoken, audioPlayed } = loadPage([
        { name: 'Microsoft Ravi - Telugu (India)', lang: 'te-IN' },
        { name: 'English (India) Male', lang: 'en-IN' },
        { name: 'हिन्दी (भारत) Male', lang: 'hi-IN' },
    ]);
    try {
        for (const lang of ['te', 'en', 'hi']) {
            window.setLanguage(lang);
            window.speakMayura();
            assert.ok(document.getElementById('mayuraPanel').classList.contains('active'), 'panel opens (' + lang + ')');
            assert.equal(document.getElementById('mayuraPanelText').textContent, GREETING_TEXT[lang], 'greeting text shown (' + lang + ')');
            window.closeMayuraPanel();
        }
        await sleep(1500);
        assert.equal(spoken.length, 0);
        assert.equal(audioPlayed.length, 0);
    } finally { window.close(); }
});

// --- (2) Voice UI is gone from the panel -----------------------------------

test('mic button, replay link and voice note are absent from the panel', async () => {
    const { window, document } = loadPage([
        { name: 'Microsoft Ravi - Telugu (India)', lang: 'te-IN' },
    ]);
    try {
        const panel = document.getElementById('mayuraPanel');
        assert.equal(panel.querySelectorAll('button[onclick="mayuraListen()"]').length, 0, 'mic button must be gone');
        assert.equal(panel.querySelectorAll('button[onclick="mayuraReplayGreeting()"]').length, 0, 'replay link must be gone');
        assert.ok(!/Voice works on Chrome/i.test(panel.textContent), 'voice note must be gone');
        assert.ok(!/పరిచయం మళ్ళీ వినండి|Hear greeting again/i.test(panel.textContent), 'replay text must be gone');
        assert.ok(!/🎙️/.test(panel.textContent), 'no mic emoji left in panel');
    } finally { window.close(); }
});

test('no voice function is reachable from any panel element', async () => {
    const { window, document } = loadPage([]);
    try {
        const panel = document.getElementById('mayuraPanel');
        const handlers = Array.from(panel.querySelectorAll('[onclick]')).map(el => el.getAttribute('onclick'));
        assert.ok(handlers.length > 0, 'panel still has buttons');
        for (const h of handlers) {
            assert.ok(!/mayuraListen|mayuraReplayGreeting|speakMayuraGreeting|playMayuraMp3/.test(h), 'voice handler still wired: ' + h);
        }
        const entries = document.querySelectorAll('[onclick="speakMayura()"]');
        assert.equal(entries.length, 4, 'hero pill + radar + tile + FAB still route through speakMayura()');
    } finally { window.close(); }
});

// --- (3) Hero pill no longer promises speech -------------------------------

test('hero pill, radar, FAB and tile no longer promise speech', async () => {
    const { window, document } = loadPage([]);
    try {
        const pill = document.getElementById('promptTxt');
        for (const lang of ['te', 'en', 'hi']) {
            assert.equal(pill.getAttribute('data-' + lang), PILL_TEXT[lang], 'pill text ' + lang);
        }
        assert.equal(pill.textContent, PILL_TEXT.te);
        const radar = document.querySelector('.radar-box-center');
        assert.equal(radar.getAttribute('data-tt-en'), 'Tap to open Mayura Assistant');
        const fab = document.querySelector('.mayura-fab-btn');
        assert.equal(fab.getAttribute('data-tt-en'), 'Mayura Assistant');
        const tileSub = document.querySelector('h3[data-en="Speak to Mayura"]').closest('.jio-bar-text').querySelector('p');
        assert.equal(tileSub.getAttribute('data-en'), 'Mayura Assistant');
        const visible = [pill.textContent, radar.getAttribute('title'), fab.getAttribute('title'), tileSub.textContent].join(' ');
        assert.ok(!/speak|talk|listen|hear|వినండి|మాట్లాడ/i.test(visible), 'speech promise left: ' + visible);
    } finally { window.close(); }
});

// --- (4) Type + Send and quick actions still work --------------------------

test('type + Send opens WhatsApp and shows the sent confirmation', async () => {
    const { window, document, opened, sheetCalls } = loadPage([]);
    try {
        window.speakMayura();
        const input = document.getElementById('mayuraTextInput');
        input.value = 'నాకు ప్లంబర్ కావాలి';
        window.mayuraSendText();
        assert.equal(opened.length, 1, 'WhatsApp should open once');
        assert.ok(opened[0].startsWith('https://wa.me/919966157369?text='), 'wa.me link: ' + opened[0]);
        assert.ok(opened[0].includes(encodeURIComponent('నమస్తే AVAILO, నాకు ప్లంబర్ కావాలి')), 'message text in link');
        assert.equal(sheetCalls.length, 1, 'enquiry logged to Sheets');
        assert.equal(sheetCalls[0][0], 'Contact');
        const listenEl = document.getElementById('mayuraListenLine');
        assert.equal(listenEl.style.display, 'block', 'sent confirmation shows');
        assert.ok(/పంపబడింది/.test(listenEl.textContent), 'confirmation text');
        assert.equal(input.value, '', 'input cleared after send');
    } finally { window.close(); }
});

test('Send with empty input shows the type-first error and opens nothing', async () => {
    const { window, document, opened } = loadPage([]);
    try {
        window.speakMayura();
        document.getElementById('mayuraTextInput').value = '';
        window.mayuraSendText();
        assert.equal(opened.length, 0, 'nothing should open');
        const errEl = document.getElementById('mayuraErrorLine');
        assert.equal(errEl.style.display, 'block', 'error shows');
        assert.equal(errEl.textContent, 'ముందుగా ఏదైనా టైప్ చేయండి.');
        assert.ok(!/🎙️/.test(errEl.textContent), 'error must not mention the removed mic');
    } finally { window.close(); }
});

test('quick actions still work: service + human open WhatsApp, rates scrolls', async () => {
    const { window, document, opened } = loadPage([]);
    try {
        window.speakMayura();
        window.mayuraQuickAction('service');
        assert.equal(opened.length, 1, 'service opens WhatsApp');
        assert.ok(opened[0].startsWith('https://wa.me/919966157369?text='));
        assert.ok(!document.getElementById('mayuraPanel').classList.contains('active'), 'panel closes on quick action');
        window.speakMayura();
        window.mayuraQuickAction('human');
        assert.equal(opened.length, 2, 'human opens WhatsApp');
        // rates: stub scrollIntoView (jsdom does not implement it)
        let scrolled = false;
        const rateCard = document.getElementById('rate-card');
        assert.ok(rateCard, 'rate-card section exists');
        rateCard.scrollIntoView = () => { scrolled = true; };
        window.speakMayura();
        window.mayuraQuickAction('rates');
        assert.ok(scrolled, 'rates scrolls to the rate card');
    } finally { window.close(); }
});

// --- (5) Panel close still works -------------------------------------------

test('panel closes via closeMayuraPanel() and re-opens silently', async () => {
    const { window, document, spoken, audioPlayed } = loadPage([
        { name: 'Microsoft Ravi - Telugu (India)', lang: 'te-IN' },
    ]);
    try {
        window.speakMayura();
        assert.ok(document.getElementById('mayuraPanel').classList.contains('active'), 'panel opens');
        window.closeMayuraPanel();
        assert.ok(!document.getElementById('mayuraPanel').classList.contains('active'), 'panel closes');
        window.speakMayura();
        assert.ok(document.getElementById('mayuraPanel').classList.contains('active'), 'panel re-opens');
        await sleep(1500);
        assert.equal(spoken.length, 0, 're-open is silent too');
        assert.equal(audioPlayed.length, 0);
    } finally { window.close(); }
});

// --- Voice code is retained, not deleted (for a possible restore) -----------

test('voice functions are retained (not deleted) for a possible restore', async () => {
    const { window } = loadPage([]);
    try {
        assert.equal(typeof window.speakMayuraGreeting, 'function');
        assert.equal(typeof window.playMayuraMp3, 'function');
        assert.equal(typeof window.mayuraListen, 'function');
        assert.equal(typeof window.mayuraReplayGreeting, 'function');
        assert.equal(typeof window.mayuraGreeting, 'function');
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
