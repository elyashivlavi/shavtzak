---
name: deploy-shavtzak
description: Deploy the shavtzak duty-roster Apps Script project to Google (push + web-app deployment) via clasp, as autonomously as Google allows. Use when asked to deploy, install, publish, or push the shavtzak / שבצ"ק app, or to cut a new web-app deployment after code changes.
---

# Deploy shavtzak (Google Apps Script) via clasp

This project is pure Google Apps Script (`apps-script/Code.gs` + `Index.html` + `appsscript.json`).
The Sheet is the DB. Deploy = push files + create a Web app deployment with `clasp`.

## Access model (IMPORTANT)
- `appsscript.json` → `webapp.access: ANYONE_ANONYMOUS`, `executeAs: USER_DEPLOYING`.
  = **no Google login for visitors**; the app runs entirely as the deployer. This also sidesteps
  the consumer "unverified app / האפליקציה חסומה" block that `ANYONE` (requires sign-in) hit.
- No login ⇒ no `Session.getActiveUser()` identity. So: **לוז אישי = client-side soldier picker**,
  and **admin = password** (config key `admin_password`, default `admin1234`). Every privileged
  server fn takes `pw` as its LAST arg and calls `requireAdmin_(pw)`; the client appends
  `STATE.adminPw` via `callAdmin()`.

## OAuth scopes — keep them NON-SENSITIVE (this is what fixed "האפליקציה חסומה")
The consumer hard-block **"האפליקציה הזו חסומה / tried to access sensitive info"** (no Advanced
bypass, blocks even the OWNER, even from the editor Run flow) is caused by an **unverified app
requesting a *sensitive* scope**. `ANYONE_ANONYMOUS` alone does NOT fix it for the deployer's own
one-time authorization — the *scopes* must be non-sensitive.
- Pin explicit `oauthScopes` in `appsscript.json` to ONLY non-sensitive scopes. For this app:
  `spreadsheets.currentonly` (bound-sheet full access) + `userinfo.email`. Both non-sensitive.
- **`script.container.ui` is SENSITIVE — do NOT declare it.** It was the block trigger here.
  Avoid the code that pulls it: don't call `SpreadsheetApp.getUi()` (even a `getUi &&` truthy
  reference is fine, but drop it to be safe). `getActiveSpreadsheet().toast()` works under
  `currentonly`, so `flashMsg_` is OK.
- With only non-sensitive scopes, the deployer's editor Run authorizes **silently** — the
  "Review permissions" dialog may appear once, but there is NO "unverified app" warning screen.

## Deployer authorization (one time, still required)
An anonymous web app still runs AS the deployer, so the deployer must grant the (non-sensitive)
scopes once or the `/exec` URL errors. Anonymous visitors can't be shown consent, so do it once:
open the editor, Run `setup` (or `doGet` — both call `ensureReady_()` which also builds the DB).
This can be driven headlessly: `cliclick` on the editor Run button + the "בדיקת ההרשאות" button
(coords computed from `getBoundingClientRect()` + `window.screenX/Y`), after enabling Chrome's
View → Developer → Allow JavaScript from Apple Events. Synthetic JS `.click()` is ignored by
Google's Material UI (isTrusted) — use real `cliclick` OS-level clicks.

## Preconditions (check, fix if missing)
1. `clasp` installed + logged in: `clasp show-authorized-user` (should print an email).
   If not: `npm install -g @google/clasp` then tell the user to run `! clasp login`.
2. Apps Script API enabled for the account. If `clasp create` errors
   `User has not enabled the Apps Script API`, tell the user to open
   https://script.google.com/home/usersettings, toggle it ON, wait ~1 min, retry.
3. `apps-script/.clasp.json` exists → project already linked. If absent, create it (below).

## Deploy an EXISTING linked project (the common case)
```bash
cd apps-script
cp Code.gs /tmp/c.js && node -c /tmp/c.js   # syntax-check V8 (.gs) locally
clasp push -f
clasp create-deployment --description "shavtzak web app"
```
Web app URL = `https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec`
(DEPLOYMENT_ID = the `AKfyc…` id printed by create-deployment / `clasp list-deployments`).

**redeploy for CODE, create-deployment for ACCESS:**
- Code/manifest-scope changes → `clasp redeploy <deploymentId>` keeps the SAME `/exec` URL. Do this.
- **Changing `webapp.access` (e.g. ANYONE → ANYONE_ANONYMOUS) does NOT take effect on `redeploy`** —
  the access level is bound at deployment CREATION. You MUST `clasp create-deployment` (which mints
  a NEW URL) for an access change to apply. Symptom of getting this wrong: anonymous `curl /exec`
  returns **HTTP 403 "הגישה נדחתה"** even though the manifest says ANYONE_ANONYMOUS.
- Live web-app deployment id (anonymous): `AKfycbxRABLTIGwN6LIJwVmFT9NHg2hXtEJpEx3xeAbZKjUrpcT9TDBefBW7Kep_PX2AXhTzhg`.
- Short public URL: https://tinyurl.com/shavtzak-motzav (TinyURL custom alias; `is.gd`/`v.gd`
  were failing with "database insert failed" — use `tinyurl.com/api-create.php?alias=…&url=…`).
  It points at the FIXED `AKfycbxRAB…/exec` URL, so it stays valid across every `redeploy`
  automatically. It only breaks if someone runs `create-deployment` (new URL) — and TinyURL free
  aliases can't be repointed, so **never create-deployment again**; always `redeploy` the fixed id.

## Verify anonymously (the app UI is in a cross-origin sandbox iframe)
`curl -sL "<exec-url>"` → HTTP 200 + markers (`getBootstrap`, `לוז אישי`, `טוען את השיבוץ`) proves
it's served & public. You CANNOT read the rendered UI via AppleScript JS injection — HtmlService
renders user HTML in a `*.googleusercontent.com` sandbox iframe (cross-origin). To see the actual
render, screenshot a browser, or launch an isolated logged-out Chrome (also the correct
anonymous-soldier test): `open -na "Google Chrome" --args --user-data-dir=/tmp/verify --new-window "<url>"`.

## Runtime gotchas (cost real debugging time — keep these)
- **google.script.run drops Date values → delivers `null` to the success handler**, and the client
  crashes (`Cannot read properties of null (reading 'user')` in `render`). Google Sheets returns
  date/time cells as `Date` objects. FIX: `readTable` coerces every `Date` cell to a clean string
  via `cellStr_` (format in **GMT** — the cell stores the wall-clock time as UTC, so GMT `HH:mm` /
  `yyyy-MM-dd` recovers `12:00` / `06:00` / `2026-07-12`). Never return raw sheet Dates to the client.
- **Never send secrets to the client:** `getBootstrap` must `delete cfg.admin_password` /
  `delete cfg.admin_emails` before returning `config` — otherwise the admin password ships in the
  public bootstrap payload to every anonymous visitor.
- Diagnose server returns without GCP logs (which need a linked Cloud project) via a temporary
  `doGet(e){ if(e.parameter.debug) return ContentService.createTextOutput(JSON.stringify(getBootstrap(''))) }`
  branch, `curl …/exec?debug=1`, then REMOVE it. Don't leave data-mutating GET endpoints deployed.

## First-time link (no .clasp.json yet)
```bash
cd apps-script
clasp create --type sheets --title "שבצ״ק מוצב"
```
GOTCHA: `clasp create` OVERWRITES local `appsscript.json` with a default (wrong timezone,
no `webapp` block). Immediately restore the repo version, then push:
```bash
git checkout HEAD -- apps-script/appsscript.json   # Asia/Jerusalem, executeAs USER_DEPLOYING, access ANYONE_ANONYMOUS, non-sensitive oauthScopes
clasp push -f
clasp create-deployment --description "shavtzak web app"
```
`clasp create` also creates the bound Sheet (the DB) — note its Drive URL from the output.

## Hand-off to the user
The app is **public, no login** — soldiers just open the short URL, no Google account needed.
The only one-time step is the **deployer authorization** (see "Deployer authorization" above): the
owner (elyashivlavi@gmail.com) runs `setup`/`doGet` once from the editor to grant the non-sensitive
scopes and build the DB. After that, share the short URL with soldiers. Admin uses the "מצב מנהל"
button + password (`config.admin_password`).

## Verify
- `clasp list-deployments` shows the new `AKfyc…` deployment.
- `clasp open-web-app <deploymentId>` opens it in a browser (optional, needs the user).
