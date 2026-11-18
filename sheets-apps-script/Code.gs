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
// Re-deploy the SAME way (new version, same deployment, same /exec URL).

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

// GET — no params: status. ?form=<TabName>: that tab's rows as JSON
// { ok, form, headers, rows } — rows newest first, capped at 500.
// Used by admin.html (same web app, same /exec URL). Reads only.
function doGet(e) {
  try {
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

// v4 (18 Nov 2026): Gate Pass photo storage.
// The site sends the photo as a base64 data URL (already resized to max
// 800px, already blurred when Gender is Female — the raw image never
// leaves the phone). The file is saved in the owner's Drive and its link
// goes in the Photo column. Files stay private (no public sharing) — the
// admin opens them while signed in as the Availo account.
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
