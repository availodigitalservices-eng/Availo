/* AVAILO Sheets database — fire-and-forget logging of form submissions.
 *
 * HOW IT WORKS: every form submit calls sendToSheet(formType, data) right
 * before WhatsApp opens. The POST runs in parallel (no-cors + text/plain,
 * so there is no CORS preflight) and NEVER blocks WhatsApp: the WhatsApp
 * window opens whether the Sheets call succeeds or fails. Failures are
 * only logged to the browser console — the visitor never sees an error.
 *
 * SETUP: paste the deployed Apps Script web-app URL (the /exec URL) into
 * AVAILO_SHEETS_URL below. See SHEETS-SETUP.md for the exact steps.
 * Until the URL is filled in, every call is a harmless no-op.
 */

// <-- PASTE THE APPS SCRIPT WEB-APP /exec URL HERE (after deploying Code.gs) -->
var AVAILO_SHEETS_URL = "https://script.google.com/macros/s/AKfycbyNQ-IJFYaU2TYLQtqLz_qXiHMVEyCP52wOYnyFBCzjp0lSdwVdFEp6g_LDZmIZJaSp/exec";

// Reference numbers: AV-YYYYMMDD-XXXX (same format as the site's availoRef).
function availoSheetRef() {
    var d = new Date();
    var p = function (n) { return String(n).padStart(2, '0'); };
    return 'AV-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + String(Math.floor(1000 + Math.random() * 9000));
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
        if (typeof fetch !== 'function') return;
        fetch(AVAILO_SHEETS_URL, {
            method: 'POST',
            mode: 'no-cors',
            keepalive: true,
            headers: { 'Content-Type': 'text/plain' },
            body: JSON.stringify(payload)
        }).catch(function (err) { console.warn('[AVAILO Sheets] log failed:', err); });
    } catch (err) {
        console.warn('[AVAILO Sheets] log failed:', err);
    }
}
