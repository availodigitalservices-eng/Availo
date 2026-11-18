# AVAILO Database — Google Sheets Setup

The AVAILO site is static (GitHub Pages, no server), so form data only went
to WhatsApp or stayed in the visitor's browser. This integration also logs
**every form submission into one Google Sheet**, so all customers and orders
can be seen in one place. No API keys, no paid service — Google Sheets +
Apps Script are free.

**What is already done in the code:** `availo-db.js` is included on every
page with a form, and every submit calls `sendToSheet(...)` right before
WhatsApp opens. The WhatsApp flow is never blocked — if Sheets fails, the
WhatsApp message still goes out. **The only missing piece is the web-app
URL** (`AVAILO_SHEETS_URL` is empty until step (e) below).

## Steps (do once, ~10 minutes)

### (a) Create the Google Sheet
1. Sign in to Google as **availodigitalservices@gmail.com**.
2. Go to https://sheets.google.com and create a **new blank spreadsheet**.
3. Rename it to **AVAILO Database** (File > Rename).
4. Leave it empty — the script creates the tabs itself on the first
   submission of each form.

### (b) Add the Apps Script code
1. In the sheet, go to **Extensions > Apps Script**. A script editor opens.
2. Delete any placeholder code in `Code.gs`.
3. Open the file `sheets-apps-script/Code.gs` from the Availo repo and
   paste its **entire contents** into the editor.
4. Click **Save** (floppy-disk icon). Name the project `AVAILO Database`
   if asked.

### (c) Deploy as a Web app
1. Click **Deploy > New deployment**.
2. Click the gear icon next to "Select type" and choose **Web app**.
3. Set:
   - **Description:** `AVAILO Database v1` (optional)
   - **Execute as:** `Me` (availodigitalservices@gmail.com)
   - **Who has access:** `Anyone`
4. Click **Deploy**.
5. If Google asks for authorisation: click **Authorize access**, choose
   the Availo Google account, click **Advanced > Go to AVAILO Database
   (unsafe)** (this warning appears because the script is not Google-verified
   — it is our own code), then **Allow**.
6. Copy the **Web app URL** shown after deploying. It ends in **`/exec`**.

### (d) — (e) Put the URL into the site
1. In the repo, open `availo-db.js`.
2. Find the line `var AVAILO_SHEETS_URL = "";` and paste the URL between
   the quotes, e.g.:
   `var AVAILO_SHEETS_URL = "https://script.google.com/macros/s/AKfy.../exec";`
3. Commit + publish the site (same way as other Availo updates) and wait
   1–2 minutes for GitHub Pages to deploy.

### (f) Test it
1. Open https://availoservices.in/ on your phone.
2. Submit a **test Gate Pass** (any flat + partner + photo).
3. Open the **AVAILO Database** sheet — a new tab called **GatePass**
   should appear with one row: Timestamp, Ref, Apartment, Flat,
   Delivery Partner, Photo Captured, Language.
4. Submit one test of each other form (Technician, Business trial, NRI,
   Dine order, chat message) and check their tabs appear the same way.

## Tabs (created automatically, first submission each)

| Tab | Filled by |
|---|---|
| GatePass | Gate Pass — index.html + gate.html (flat, apartment, delivery partner, ref; photo itself is NOT uploaded, only "captured") |
| Technicians | Technician signup form (name, phone, skill, experience, area, ID-proof note) |
| Business | Business trial form (category, plan type, business/contact name, phone, location) |
| NRI | NRI parents-care form (plan, sponsor, phone, parents name, address, needs) |
| Orders | Dine orders + bills, Smart Dine, AI Waiter, Home Service bookings, Dine refills (hotel, table, items, total) |
| Contact | Chat / helpline messages (chat.html) + Mayura questions + preset enquiry buttons |
| Salon | Salon bookings from salon.html (name, phone, service, date/time, area) |
| Cube | Smart Cube trial enquiries from cube.html |

## Admin panel — see all customers/orders in one place

Open **https://availoservices.in/admin.html** (unlisted — it is NOT linked
from the site navigation or any tile, so only the owner who knows the
address can open it). It asks for a **passcode first**, then shows a
dashboard: one count card per section + one tab per Sheet tab (GatePass,
Orders, Technicians, Business, NRI, Salon, Cube, Contact), each with a
search box, a Refresh button, and an "Open Google Sheet" button.

- **Placeholder passcode: `availo123`** — change it in `admin.html`
  (search for `ADMIN_PASSCODE`). After 3 wrong tries the page blocks
  further tries for 60 seconds.
- The panel reads data through the **same Apps Script web app**
  (`doGet ?form=<TabName>` — added in Code.gs v3). It needs the same
  `/exec` URL in `availo-db.js`; until the URL is filled in it shows
  "setup pending" instead of tables.
- **Privacy caveat:** the passcode is a simple browser-side gate, not a
  bank-grade login — it is visible in the page's source. Do NOT share
  the admin link or the passcode with anyone.

**After editing Code.gs, always re-deploy the SAME deployment:** Apps
Script > **Deploy > Manage deployments > Edit (pencil) > Version: New
version > Deploy** — the `/exec` URL stays the same, so `availo-db.js`
needs no change.

## Troubleshooting

- **Rows don't appear:** the most common cause is the deployment access.
  Open the Apps Script project > **Deploy > Manage deployments** — check
  **"Who has access" is `Anyone`** and the URL you pasted ends in
  **`/exec`** (not `/dev`). The `/dev` URL only works for the script owner.
- **"Authorization required" after re-deploying:** every **new deployment**
  needs the authorisation step again (step c-5). If you edit Code.gs, click
  **Deploy > Manage deployments > Edit (pencil) > Version: New version >
  Deploy** so the live URL picks up the change.
- **Old rows in WhatsApp only:** submissions made before the URL was added
  were never sent to Sheets (by design — the code no-ops until configured).
  They stay in WhatsApp chats; nothing is backfilled.
- **Check the browser console:** open the site, press F12 > Console —
  a failed Sheets call only logs `[AVAILO Sheets] log failed: ...` and
  never blocks WhatsApp.
- **Privacy:** the Sheet lives in the Availo Google account only. Do not
  share the Sheet link publicly. Gate Pass photos are never uploaded to
  the Sheet (only the fact a photo was captured).
