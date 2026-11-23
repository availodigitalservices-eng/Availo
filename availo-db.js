/* AVAILO Sheets database — fire-and-forget logging of form submissions.
 *
 * HOW IT WORKS: every form submit calls sendToSheet(formType, data) right
 * before WhatsApp opens. The POST runs in parallel (no-cors + text/plain,
 * so there is no CORS preflight) and NEVER blocks WhatsApp: the WhatsApp
 * window opens whether the Sheets call succeeds or fails.
 *
 * RETRY + QUEUE (21 Nov 2026, scalability review Risk 5): a failed POST
 * is retried up to 2 times (3 attempts, 1.5 s then 3 s apart — override
 * AVAILO_SHEETS_RETRY_DELAYS in tests). If it still fails, the record is
 * queued in localStorage and re-sent on the next submit or next page
 * load — never lost silently. While anything is queued, a small
 * trilingual "saved on this device, will send" note shows at the bottom
 * of the page.
 *
 * HONEST LIMIT: mode 'no-cors' makes the response opaque, so the Apps
 * Script "busy, please retry" JSON can never be read by the client — a
 * "busy" reply (HTTP 200 + error body) looks like success to us. Retries
 * therefore fire only on network-level failure (fetch rejects). The
 * queue is the safety net for those failures; a "busy" lock contention
 * that reaches the server still needs the server side to accept it.
 *
 * SETUP: paste the deployed Apps Script web-app URL (the /exec URL) into
 * AVAILO_SHEETS_URL below. See SHEETS-SETUP.md for the exact steps.
 * Until the URL is filled in, every call is a harmless no-op.
 */

// <-- PASTE THE APPS SCRIPT WEB-APP /exec URL HERE (after deploying Code.gs) -->
var AVAILO_SHEETS_URL = "https://script.google.com/macros/s/AKfycbyNQ-IJFYaU2TYLQtqLz_qXiHMVEyCP52wOYnyFBCzjp0lSdwVdFEp6g_LDZmIZJaSp/exec";

// Retry gaps in ms between the 3 attempts (attempt 1 is immediate).
// Tests override this with [0, 0] for speed.
var AVAILO_SHEETS_RETRY_DELAYS = [1500, 3000];
// localStorage key for records that failed all retries.
var AVAILO_SHEETS_QUEUE_KEY = 'availo_sheet_queue';
// Cap: the queue never grows past this (oldest dropped first).
var AVAILO_SHEETS_MAX_QUEUE = 50;
var availoSheetFlushing = false;

// Reference numbers: AV-YYYYMMDD-XXXX (same format as the site's availoRef).
function availoSheetRef() {
    var d = new Date();
    var p = function (n) { return String(n).padStart(2, '0'); };
    return 'AV-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + String(Math.floor(1000 + Math.random() * 9000));
}

function availoSheetSleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

// One POST attempt. keepalive caps the body at ~64 KB, so it is kept
// whenever the WHOLE serialised payload fits (small or no photo) — the
// POST then survives the tab closing. A big Gate Pass photo exceeds the
// cap, so keepalive is dropped for it; the page stays open while
// WhatsApp opens in a new tab, so the POST still lands in practice.
function availoSheetPost(payload) {
    var body = JSON.stringify(payload);
    return fetch(AVAILO_SHEETS_URL, {
        method: 'POST',
        mode: 'no-cors',
        keepalive: body.length < 60000,
        headers: { 'Content-Type': 'text/plain' },
        body: body
    });
}

// One payload, up to 2 retries on transport failure. Resolves true if a
// POST attempt resolved, false if every attempt rejected. Never throws.
async function availoSheetSendWithRetry(payload) {
    var delays = (typeof AVAILO_SHEETS_RETRY_DELAYS !== 'undefined' && AVAILO_SHEETS_RETRY_DELAYS)
        ? AVAILO_SHEETS_RETRY_DELAYS : [1500, 3000];
    for (var attempt = 0; attempt <= delays.length; attempt++) {
        if (attempt > 0) await availoSheetSleep(delays[attempt - 1]);
        try {
            await availoSheetPost(payload);
            return true;
        } catch (err) {
            console.warn('[AVAILO Sheets] log attempt ' + (attempt + 1) + ' failed:', err);
        }
    }
    return false;
}

function availoSheetQueueLoad() {
    try {
        if (typeof localStorage === 'undefined') return [];
        var raw = localStorage.getItem(AVAILO_SHEETS_QUEUE_KEY);
        if (!raw) return [];
        var parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) { return []; }
}

function availoSheetQueueSave(queue) {
    try {
        if (typeof localStorage === 'undefined') return;
        localStorage.setItem(AVAILO_SHEETS_QUEUE_KEY, JSON.stringify(queue));
    } catch (e) { /* storage full/blocked: WhatsApp already went; record is lost */ }
}

// Small fixed note while anything is queued — the visitor can see their
// record is safe on the device and will be sent. Best-effort only.
function availoSheetQueueNote(show) {
    try {
        if (typeof document === 'undefined' || !document.body) return;
        var el = document.getElementById('availoSheetQueueNote');
        if (!show) { if (el) el.remove(); return; }
        var lang = (typeof currentLang !== 'undefined' ? currentLang : 'te');
        var text = lang === 'en' ? '⚠️ Saved on this device — will send when the internet is back.'
            : lang === 'hi' ? '⚠️ इस डिवाइस पर सहेजा गया — इंटरनेट आते ही भेजा जाएगा।'
            : '⚠️ ఈ ఫోన్‌లో సేవ్ అయ్యింది — ఇంటర్నెట్ రాగానే పంపబడుతుంది.';
        if (el) { el.textContent = text; return; } // re-label if the language changed
        el = document.createElement('div');
        el.id = 'availoSheetQueueNote';
        el.textContent = text;
        el.style.cssText = 'position:fixed;left:12px;right:12px;bottom:12px;z-index:9999;background:#78350f;color:#fef3c7;padding:10px 14px;border-radius:10px;font-size:13px;text-align:center;';
        document.body.appendChild(el);
    } catch (e) { /* note is best-effort */ }
}

function availoSheetEnqueue(payload) {
    var queue = availoSheetQueueLoad();
    queue.push({ payload: payload, queuedAt: new Date().toISOString() });
    while (queue.length > AVAILO_SHEETS_MAX_QUEUE) queue.shift();
    availoSheetQueueSave(queue);
    availoSheetQueueNote(true);
}

// Send queued records (oldest first), one attempt each. Stops at the
// first failure so the rest stay queued for next time. Never throws.
async function availoSheetFlushQueue() {
    if (availoSheetFlushing) return;
    if (typeof fetch !== 'function') return;
    var queue = availoSheetQueueLoad();
    if (!queue.length) return;
    availoSheetFlushing = true;
    try {
        while (queue.length) {
            var sent = false;
            try { await availoSheetPost(queue[0].payload); sent = true; }
            catch (err) { sent = false; }
            if (!sent) break;
            queue.shift();
            availoSheetQueueSave(queue);
        }
    } catch (e) { /* keep the rest queued */ }
    availoSheetFlushing = false;
    if (!availoSheetQueueLoad().length) availoSheetQueueNote(false);
}

// formType: 'GatePass' | 'Technicians' | 'Business' | 'NRI' | 'Orders' | 'Contact' | 'Salon' | 'Cube'
// data: plain object of fields for that form (see sheets-apps-script/Code.gs).
// Never throws, never blocks the caller.
function sendToSheet(formType, data) {
    try {
        if (!AVAILO_SHEETS_URL) return; // not configured yet — WhatsApp flow continues
        var payload = {
            form: formType,
            lang: (typeof currentLang !== 'undefined' ? currentLang : 'te'),
            clientTime: new Date().toISOString()
        };
        var d = data || {};
        for (var k in d) {
            if (Object.prototype.hasOwnProperty.call(d, k)) payload[k] = d[k];
        }
        if (!payload.ref) payload.ref = availoSheetRef();
        if (typeof fetch !== 'function') { availoSheetEnqueue(payload); return; }
        // Records queued from earlier failures go first (best effort,
        // async — never blocks this submit or the WhatsApp flow).
        availoSheetFlushQueue();
        availoSheetSendWithRetry(payload).then(function (sent) {
            if (!sent) availoSheetEnqueue(payload);
        }).catch(function () { availoSheetEnqueue(payload); });
    } catch (err) {
        console.warn('[AVAILO Sheets] log failed:', err);
    }
}

// Flush any records queued by an earlier failed submit when the page loads.
try { availoSheetFlushQueue(); } catch (e) { /* queue is best-effort */ }
