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

// One tab per form type. First column (Timestamp) is filled by the server.
var SHEETS = {
  GatePass:    ['Timestamp', 'Ref', 'Apartment', 'Flat', 'Delivery Partner', 'Photo Captured', 'Language'],
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
  GatePass:    ['ref', 'apartment', 'flat', 'partner', 'photo', 'lang'],
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
      return jsonOut({ ok: true, service: 'AVAILO Database', version: 3 });
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
      }
      var row = [new Date()];
      FIELDS[form].forEach(function (k) {
        var v = data[k];
        row.push(v === undefined || v === null ? '' : String(v));
      });
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
