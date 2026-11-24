// AVAILO Database — Google Apps Script web app.
// Bound to the "AVAILO Database" Google Sheet. Receives JSON POSTs from
// availoservices.in (availo-db.js) and appends one row per form submission.
// Free: no API keys, no external services, no paid add-ons.
// Deploy as a Web app — Execute as: Me, Who has access: Anyone.
// Setup steps: see SHEETS-SETUP.md in the repo root.
// v2 (18 Nov 2026): added Salon + Cube tabs. When re-deploying, create a
// NEW VERSION on the SAME deployment (Deploy > Manage deployments > edit) —
// the /exec URL stays the same, so availo-db.js needs no change.
// v3 (18 Nov 2026): doGet ?form=<TabName> list endpoint for admin.html.
// Re-deploy the SAME way (new version, same deployment, same /exec URL).
// v4 (18 Nov 2026): GatePass gains Mobile, Gender, Date, Time, Photo
// (appended at the end — old rows stay valid). The photo is saved to a
// Google Drive folder and its link goes in the Photo column. DriveApp
// needs the Drive scope: on the next deploy Google asks to authorise
// Drive access. Files stay private to the owner (no public link) — the
// admin opens them while signed in as the Availo account.
// v5 (23 Nov 2026): doGet reads now need ?token=<READ_TOKEN> (B1 — the
// /exec URL is public in availo-db.js, so an open read leaked every
// visitor's mobile number + photo link). The token lives ONLY in this
// file and in admin.html (fetchForm); doPost writes need no token.
// Re-deploy the SAME way (new version, same deployment, same /exec URL).
// v6 (24 Nov 2026): conversational Mayura — doPost { form: 'Mayura',
// question, lang } calls the Gemini API and returns { ok, answer }.
// The key lives ONLY in Script Properties (GEMINI_API_KEY) — never in
// this file, never in the site. No key configured → { ok: false, error:
// 'no_key' } and the site falls back to its canned answers. Nothing is
// written to any Sheet for Mayura questions. Re-deploy the SAME way
// (new version, same deployment, same /exec URL) — this also activates B1.

// Read token for doGet — keep this ONLY here and in admin.html, never in
// the public site JS (availo-db.js, index.html, ...).
var READ_TOKEN = 'fce7d355f2ada8f515653a33a408b281';

// One tab per form type. First column (Timestamp) is filled by the server.
var SHEETS = {
  GatePass:    ['Timestamp', 'Ref', 'Apartment', 'Flat', 'Delivery Partner', 'Photo Captured', 'Language', 'Mobile', 'Gender', 'Date', 'Time', 'Photo'],
  Technicians: ['Timestamp', 'Ref', 'Name', 'Phone', 'Skill', 'Experience', 'Service Area', 'ID Proof', 'Language'],
  Business:    ['Timestamp', 'Ref', 'Category', 'Plan Type', 'Business Name', 'Contact Name', 'Phone', 'Location', 'Language'],
  NRI:         ['Timestamp', 'Ref', 'Plan', 'Sponsor', 'Phone', 'Parents Name', 'Address', 'Needs', 'Language'],
  Orders:      ['Timestamp', 'Ref', 'Source', 'Hotel / Restaurant', 'Table', 'Items', 'Total', 'Language'],
  Contact:     ['Timestamp', 'Ref', 'Message', 'Language'],
  // v2 (18 Nov 2026): Salon booking page + Smart Cube trial enquiry.
  Salon:       ['Timestamp', 'Ref', 'Name', 'Phone', 'Service', 'Date/Time', 'Area', 'Language'],
  Cube:        ['Timestamp', 'Ref', 'Message', 'Language']
};

// Field keys the site sends, in the same order as the headers above
// (Timestamp is server-filled, so it is not listed here).
var FIELDS = {
  GatePass:    ['ref', 'apartment', 'flat', 'partner', 'photo', 'lang', 'mobile', 'gender', 'date', 'time', 'photoUrl'],
  Technicians: ['ref', 'name', 'phone', 'skill', 'experience', 'area', 'idProof', 'lang'],
  Business:    ['ref', 'category', 'planType', 'businessName', 'contactName', 'phone', 'location', 'lang'],
  NRI:         ['ref', 'plan', 'sponsor', 'phone', 'parentsName', 'address', 'needs', 'lang'],
  Orders:      ['ref', 'source', 'hotel', 'table', 'items', 'total', 'lang'],
  Contact:     ['ref', 'message', 'lang'],
  // v2 (18 Nov 2026): Salon booking page + Smart Cube trial enquiry.
  Salon:       ['ref', 'name', 'phone', 'service', 'datetime', 'area', 'lang'],
  Cube:        ['ref', 'message', 'lang']
};

// GET — no params: status. ?form=<TabName>&token=<READ_TOKEN>: that tab's
// rows as JSON { ok, form, headers, rows } — rows newest first, capped
// at 500. Used by admin.html (same web app, same /exec URL). Reads only.
// A read without the matching token returns { ok: false, error:
// 'unauthorized' } and NO rows (B1, 23 Nov 2026).
function doGet(e) {
  try {
    var token = (e && e.parameter && e.parameter.token) || '';
    if (token !== READ_TOKEN) {
      return jsonOut({ ok: false, error: 'unauthorized' });
    }
    var form = (e && e.parameter && e.parameter.form) || '';
    if (!form) {
      return jsonOut({ ok: true, service: 'AVAILO Database', version: 4 });
    }
    if (!SHEETS[form]) {
      return jsonOut({ ok: false, error: 'unknown form: ' + form });
    }
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(form);
    if (!sheet) {
      return jsonOut({ ok: true, form: form, headers: SHEETS[form], rows: [] });
    }
    // Display values keep timestamps as the readable strings shown in the
    // sheet (no timezone shift from Date serialisation).
    var values = sheet.getDataRange().getDisplayValues();
    var headers = values.length ? values[0] : SHEETS[form];
    var rows = values.length > 1 ? values.slice(1) : [];
    rows.reverse(); // newest first (append order is oldest first)
    if (rows.length > 500) rows = rows.slice(0, 500);
    return jsonOut({ ok: true, form: form, headers: headers, rows: rows });
  } catch (err) {
    return jsonOut({ ok: false, error: String(err) });
  }
}

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents || '{}');
    var form = data.form;
    // v6 (24 Nov 2026): conversational Mayura — answered by Gemini, no
    // Sheet write. Kept BEFORE the SHEETS check (Mayura is not a tab).
    if (form === 'Mayura') {
      return jsonOut(mayuraAnswer_(data));
    }
    if (!SHEETS[form]) {
      return jsonOut({ ok: false, error: 'unknown form: ' + form });
    }
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(10000)) {
      return jsonOut({ ok: false, error: 'busy, please retry' });
    }
    try {
      var ss = SpreadsheetApp.getActiveSpreadsheet();
      var sheet = ss.getSheetByName(form);
      if (!sheet) {
        sheet = ss.insertSheet(form);
        sheet.getRange(1, 1, 1, SHEETS[form].length).setValues([SHEETS[form]]);
        sheet.getRange(1, 1, 1, SHEETS[form].length).setFontWeight('bold');
        sheet.setFrozenRows(1);
      } else {
        // v4: extend the header row when the tab was created by an older
        // version (new columns append at the end; old rows stay valid).
        var head = sheet.getRange(1, 1, 1, SHEETS[form].length).getValues()[0];
        var needHead = false;
        for (var i = 0; i < SHEETS[form].length; i++) {
          if ((head[i] || '') !== SHEETS[form][i]) { needHead = true; break; }
        }
        if (needHead) {
          sheet.getRange(1, 1, 1, SHEETS[form].length).setValues([SHEETS[form]]);
          sheet.getRange(1, 1, 1, SHEETS[form].length).setFontWeight('bold');
        }
      }
      var row = [new Date()];
      FIELDS[form].forEach(function (k) {
        var v = data[k];
        row.push(v === undefined || v === null ? '' : String(v));
      });
      // v4: Gate Pass photo — save the image to Drive, store its link in
      // the Photo column (the last FIELDS entry). A failed save never
      // blocks the row: the column stays empty and the pass still logs.
      if (form === 'GatePass' && data.photoData) {
        row[row.length - 1] = saveGatePhoto_(data);
      }
      sheet.appendRow(row);
    } finally {
      lock.releaseLock();
    }
    return jsonOut({ ok: true, form: form });
  } catch (err) {
    return jsonOut({ ok: false, error: String(err) });
  }
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// v6 (24 Nov 2026): conversational Mayura — free tier (Gemini 3.8 Flash;
// gemini-2.5-flash is RETIRED — the API returns 404 for it, verified
// 24 Nov 2026; the API itself recommends gemini-3.8-flash).
// The visitor's question is sent to Gemini with a guardrail system
// prompt (AVAILO topics only, never invent prices, never medical/legal
// advice, never claim to be human, answer in the visitor's language,
// short). The API key comes ONLY from Script Properties (GEMINI_API_KEY)
// — set it in the Apps Script editor (Project Settings > Script
// Properties) with a key created in the AVAILO Google account's AI
// Studio. The key is sent in the x-goog-api-key header, never in the
// URL and never in any log. Nothing is written to any Sheet and the
// question is never stored. Any failure returns ok:false and the site
// falls back to its canned answers — the visitor always gets an answer.
function mayuraAnswer_(data) {
  try {
    var question = String((data && data.question) || '').trim();
    var lang = String((data && data.lang) || 'te');
    if (!question) return { ok: false, error: 'empty question' };
    if (question.length > 500) question = question.slice(0, 500);
    if (lang !== 'te' && lang !== 'en' && lang !== 'hi') lang = 'te';
    var key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
    if (!key) return { ok: false, error: 'no_key' };
    var langName = lang === 'hi' ? 'Hindi' : lang === 'en' ? 'English' : 'Telugu';
    var prompt = 'You are Mayura, the voice assistant of AVAILO Digital Services (Vijayawada and Guntur, India — "Scan and Go, No App"). ' +
      'Answer ONLY about AVAILO: Dine food ordering (Khaleel Bhai Family Restaurant), gate pass for apartments, home services, salon queue, table booking, and how to contact AVAILO on WhatsApp 9966157369. ' +
      'Rules: answer in ' + langName + ', in 2-3 short sentences. NEVER invent prices, rates, timings or facts — if a price or rate is asked and you do not know it, say the rates are not fixed yet and to ask on WhatsApp. NEVER give medical or legal advice. NEVER claim to be human — you are Mayura, an AI assistant. NEVER use the word "flash". ' +
      'If the question is NOT about AVAILO, politely decline in ' + langName + ' and offer WhatsApp 9966157369. ' +
      'Visitor question: ' + question;
    var res = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent', {
      method: 'post',
      contentType: 'application/json',
      muteHttpExceptions: true,
      headers: { 'x-goog-api-key': key },
      payload: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 300 }
      })
    });
    var out = JSON.parse(res.getContentText() || '{}');
    var text = '';
    var cands = out.candidates || [];
    if (cands.length && cands[0].content && cands[0].content.parts) {
      text = cands[0].content.parts.map(function (p) { return p.text || ''; }).join('').trim();
    }
    if (!text) return { ok: false, error: 'no_answer' };
    if (text.length > 600) text = text.slice(0, 600);
    return { ok: true, answer: text, source: 'ai' };
  } catch (err) {
    return { ok: false, error: 'ai_unavailable' };
  }
}

// v4 (18 Nov 2026): Gate Pass photo storage.
// The site sends the photo as a base64 data URL (already resized to max
// 800px). The photo is stored CLEAR in the owner's Drive — it is NOT
// blurred at storage; blurring happens only at DISPLAY in admin.html
// (Female / gender-blank rows show a blurred thumbnail there). The file
// is saved in the owner's Drive and its link goes in the Photo column.
// Files stay private (no public sharing) — the admin opens them while
// signed in as the Availo account.
// DriveApp needs the Drive scope: on the next deploy Google asks to
// authorise Drive access (one extra consent screen, same deployment).
function getGatePhotoFolder_() {
  var it = DriveApp.getFoldersByName('Availo Gate Pass Photos');
  if (it.hasNext()) return it.next();
  return DriveApp.createFolder('Availo Gate Pass Photos');
}

function saveGatePhoto_(data) {
  try {
    var b64 = data.photoData;
    if (!b64 || typeof b64 !== 'string') return '';
    var comma = b64.indexOf(',');
    var raw = comma >= 0 ? b64.slice(comma + 1) : b64;
    if (!raw || raw.length > 7000000) return ''; // ~5 MB cap
    var bytes = Utilities.base64Decode(raw);
    var folder = getGatePhotoFolder_();
    var name = 'gate-pass-' + (data.ref || 'noref') + '.jpg';
    var file = folder.createFile(Utilities.newBlob(bytes, 'image/jpeg', name));
    return file.getUrl();
  } catch (err) {
    return '';
  }
}
