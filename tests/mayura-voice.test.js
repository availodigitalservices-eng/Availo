// Mayura male-voice tests — jsdom DOM tests for index.html.
// Loads the REAL inline script from index.html with mocked speechSynthesis
// and asserts the greeting always uses a male TTS voice when one exists.
//
// Run:  node mayura-voice.test.js        (from this directory)
//        npm test                         (same thing, via package.json)

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
            window.open = () => null;
        },
    });
    dom.window.eval(script);
    return { window: dom.window, document: dom.window.document, spoken, audioPlayed, setVoices(v) { voiceList = v; } };
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// --- Male voice is chosen when one exists (per language) -------------------

test('te: male voice (Ravi) chosen even when listed after a female voice', async () => {
    const { window, spoken } = loadPage([
        { name: 'Google తెలుగు', lang: 'te-IN' },
        { name: 'Microsoft Ravi - Telugu (India)', lang: 'te-IN' },
        { name: 'Google US English', lang: 'en-US' },
    ]);
    try {
        window.speakMayura();
        await sleep(400);
        assert.equal(spoken.length, 1, 'greeting should be spoken once');
        assert.equal(spoken[0].voice.name, 'Microsoft Ravi - Telugu (India)');
        assert.equal(spoken[0].lang, 'te-IN');
    } finally { window.close(); }
});

test('en: male voice chosen even when listed after a female voice', async () => {
    const { window, spoken } = loadPage([
        { name: 'Google US English Female', lang: 'en-US' },
        { name: 'English (India) Male', lang: 'en-IN' },
    ]);
    try {
        window.setLanguage('en');
        window.speakMayura();
        await sleep(400);
        assert.equal(spoken.length, 1);
        assert.equal(spoken[0].voice.name, 'English (India) Male');
        assert.equal(spoken[0].lang, 'en-IN');
    } finally { window.close(); }
});

test('hi: male voice chosen even when listed after a female voice', async () => {
    const { window, spoken } = loadPage([
        { name: 'Google हिन्दी', lang: 'hi-IN' },
        { name: 'हिन्दी (भारत) Male', lang: 'hi-IN' },
    ]);
    try {
        window.setLanguage('hi');
        window.speakMayura();
        await sleep(400);
        assert.equal(spoken.length, 1);
        assert.equal(spoken[0].voice.name, 'हिन्दी (भारत) Male');
        assert.equal(spoken[0].lang, 'hi-IN');
    } finally { window.close(); }
});

test('te: voice named Pradeep also counts as male', async () => {
    const { window, spoken } = loadPage([
        { name: 'Google తెలుగు', lang: 'te-IN' },
        { name: 'Microsoft Pradeep - Telugu (India)', lang: 'te-IN' },
    ]);
    try {
        window.speakMayura();
        await sleep(400);
        assert.equal(spoken.length, 1);
        assert.equal(spoken[0].voice.name, 'Microsoft Pradeep - Telugu (India)');
    } finally { window.close(); }
});

// --- Fallback order when no male voice exists -------------------------------

test('fallback: no male voice -> first same-language voice is used', async () => {
    const { window, spoken } = loadPage([
        { name: 'Google తెలుగు', lang: 'te-IN' },
        { name: 'Microsoft Heera - Telugu (India)', lang: 'te-IN' },
        { name: 'English (India) Male', lang: 'en-IN' },
    ]);
    try {
        window.speakMayura();
        await sleep(400);
        assert.equal(spoken.length, 1);
        assert.equal(spoken[0].voice.name, 'Google తెలుగు');
    } finally { window.close(); }
});

test('fallback: no same-language voice -> English male voice is used', async () => {
    const { window, spoken } = loadPage([
        { name: 'Google US English Female', lang: 'en-US' },
        { name: 'English (India) Male', lang: 'en-IN' },
    ]);
    try {
        window.speakMayura(); // currentLang is te, no te voice at all
        await sleep(400);
        assert.equal(spoken.length, 1);
        assert.equal(spoken[0].voice.name, 'English (India) Male');
    } finally { window.close(); }
});

test('fallback: no male voice anywhere -> first English voice is used', async () => {
    const { window, spoken } = loadPage([
        { name: 'Google US English', lang: 'en-US' },
        { name: 'Google UK English Female', lang: 'en-GB' },
    ]);
    try {
        window.speakMayura(); // te, no te voice, no male voice
        await sleep(400);
        assert.equal(spoken.length, 1);
        assert.equal(spoken[0].voice.name, 'Google US English');
    } finally { window.close(); }
});

// --- MP3 fallback only when there is NO usable TTS voice --------------------

test('no TTS voices at all -> pre-recorded MP3 plays, nothing is spoken', async () => {
    const { window, spoken, audioPlayed } = loadPage([]);
    try {
        window.speakMayura();
        await sleep(1300); // waitMayuraVoices waits up to 900ms
        assert.equal(spoken.length, 0, 'nothing should go through speechSynthesis');
        assert.equal(audioPlayed.length, 1, 'MP3 fallback should play once');
        assert.ok(audioPlayed[0].src.endsWith('audio/mayura-greeting-te.mp3'), 'te MP3: ' + audioPlayed[0].src);
    } finally { window.close(); }
});

test('no TTS voices, language en -> English MP3 plays', async () => {
    const { window, spoken, audioPlayed } = loadPage([]);
    try {
        window.setLanguage('en');
        window.speakMayura();
        await sleep(1300);
        assert.equal(spoken.length, 0);
        assert.equal(audioPlayed.length, 1);
        assert.ok(audioPlayed[0].src.endsWith('audio/mayura-greeting-en.mp3'), 'en MP3: ' + audioPlayed[0].src);
    } finally { window.close(); }
});

test('no speechSynthesis in browser -> MP3 fallback plays', async () => {
    const { window, spoken, audioPlayed } = loadPage(null);
    try {
        window.speakMayura();
        await sleep(400);
        assert.equal(spoken.length, 0);
        assert.equal(audioPlayed.length, 1);
        assert.ok(audioPlayed[0].src.endsWith('audio/mayura-greeting-te.mp3'));
    } finally { window.close(); }
});

// --- Tap behaviour, wording and pitch are unchanged -------------------------

test('tap opens the Mayura panel and shows the greeting text (te)', async () => {
    const { window, document, spoken } = loadPage([
        { name: 'Microsoft Ravi - Telugu (India)', lang: 'te-IN' },
    ]);
    try {
        assert.ok(!document.getElementById('mayuraPanel').classList.contains('active'), 'panel starts closed');
        window.speakMayura();
        assert.ok(document.getElementById('mayuraPanel').classList.contains('active'), 'panel opens on tap');
        assert.equal(document.getElementById('mayuraPanelText').textContent, GREETING_TEXT.te);
        await sleep(400);
        assert.equal(spoken.length, 1);
    } finally { window.close(); }
});

test('replay button also speaks with the male voice', async () => {
    const { window, spoken } = loadPage([
        { name: 'Google తెలుగు', lang: 'te-IN' },
        { name: 'Microsoft Ravi - Telugu (India)', lang: 'te-IN' },
    ]);
    try {
        window.mayuraReplayGreeting();
        await sleep(400);
        assert.equal(spoken.length, 1);
        assert.equal(spoken[0].voice.name, 'Microsoft Ravi - Telugu (India)');
    } finally { window.close(); }
});

test('utterance pitch is lowered to 0.76 and rate stays 0.95', async () => {
    const { window, spoken } = loadPage([
        { name: 'Microsoft Ravi - Telugu (India)', lang: 'te-IN' },
    ]);
    try {
        window.speakMayura();
        await sleep(400);
        assert.equal(spoken.length, 1);
        assert.equal(spoken[0].pitch, 0.76);
        assert.equal(spoken[0].rate, 0.95);
    } finally { window.close(); }
});

test('greeting wording is unchanged in all three languages', async () => {
    const { window, document } = loadPage([
        { name: 'Microsoft Ravi - Telugu (India)', lang: 'te-IN' },
        { name: 'English (India) Male', lang: 'en-IN' },
        { name: 'हिन्दी (भारत) Male', lang: 'hi-IN' },
    ]);
    try {
        for (const lang of ['te', 'en', 'hi']) {
            window.setLanguage(lang);
            window.speakMayura();
            assert.equal(document.getElementById('mayuraPanelText').textContent, GREETING_TEXT[lang], 'greeting text ' + lang);
            window.closeMayuraPanel();
        }
    } finally { window.close(); }
});

test('no male/female voice picker UI is introduced in the Mayura panel', async () => {
    const { window, document } = loadPage([
        { name: 'Microsoft Ravi - Telugu (India)', lang: 'te-IN' },
    ]);
    try {
        const panel = document.getElementById('mayuraPanel');
        assert.equal(panel.querySelectorAll('select').length, 0, 'no dropdown added');
        assert.equal(panel.querySelectorAll('input[type=radio]').length, 0, 'no radio buttons added');
        assert.ok(!/male|female|మగ|ఆడ/i.test(panel.textContent), 'no male/female choice text in panel');
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
