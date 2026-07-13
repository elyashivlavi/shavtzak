# CLAUDE.md — project context for שבצ"ק מוצב (outpost duty roster)

This doc gets a fresh Claude session up to speed immediately. Day-to-day setup/usage also lives in
`README.md`. An implementation-agnostic product spec is in `SPEC.md`.

## What it is
A duty-roster system (guard shifts + patrols) for a small outpost of ~12 soldiers. Built **entirely
on Google Sheets + Google Apps Script** — free, no server, no external hosting. The spreadsheet is
the database. UI is Hebrew, RTL.

## Architecture decisions
- **Backend/DB:** Google Sheets (5 tabs) + Apps Script. Chosen over Supabase for simplicity and "free existing tools".
- **Access:** **Public, no Google login** — `webapp.access: ANYONE_ANONYMOUS`, `executeAs: USER_DEPLOYING` (the app runs entirely as the deployer; this also sidesteps the "app blocked" screen that `ANYONE` hit). With no login there is no `getActiveUser`, so: the personal view (**"לוז אישי"**) identifies a soldier via a **client-side name picker**, and **admin is gated by a password** (`config.admin_password`, default `admin1234`). Every admin function takes `pw` as its last argument and validates via `requireAdmin_(pw)`; the client appends `STATE.adminPw` through `callAdmin()`. *Note: the deployer must still authorize scopes once by running `setup`/`doGet` from the editor — otherwise the public URL errors.*
- **UI:** Served from `HtmlService` (`Index.html`, Heebo font, light theme, RTL). Two public tabs inspired by `shavtzak-gaash.site`: **"לוז אישי"** (soldier picker → "כרגע"/"המשמרת הבאה"/shift list + call/WhatsApp buttons) and **"שבצק"** (board + "כוח אפקטיבי"). Admin (after password) also gets: **"טיוטה"** (draft), **"חיילים"** (soldiers), **"הוגנות"** (fairness).
- **Core mechanism — draft → approve → publish:** admin edits `schedule_draft` (private). Soldiers read **only** `schedule_published`. The "אישור ופרסום" (Approve & Publish) button copies draft→published and recomputes stats. Nothing leaks to soldiers before approval.

## File structure
- `apps-script/Code.gs` — all server logic: user/permission checks, client API, fairness algorithm, publish mechanism, **and `setup()`** (one-time install that creates tabs and seeds data). *`Setup.gs` was merged into `Code.gs` to keep it to 2 files to paste.*
- `apps-script/Index.html` — the whole UI (inline CSS+JS, one file).
- `apps-script/appsscript.json` — manifest (timezone Asia/Jerusalem; webapp: `executeAs USER_DEPLOYING`, `access ANYONE_ANONYMOUS`; non-sensitive `oauthScopes` only — `spreadsheets.currentonly` + `userinfo.email`; do NOT add `script.container.ui`, it's sensitive and triggers the "app blocked" hard block).
- `README.md` — setup guide; `SPEC.md` — implementation-agnostic spec.

## Spreadsheet tabs
| Tab | Contents |
|-----|----------|
| `soldiers` | id, name, email, role, active, guard_eligible, phone, internal_note, start_date, end_date |
| `schedule_draft` | schedule being edited (admin-private) |
| `schedule_published` | schedule visible to soldiers |
| `stats` | soldier_id, name, cumulative_guard_hours, guard_blocks, last_guard_block |
| `config` | anchor_hour, shift_hours, shift_starts, guard_count, patrol_morning/evening, admin_emails, admin_password |

## Roster logic (defaults — all in the `config` tab, not in code)
- Rotation anchored to **12:00 noon** (`anchor_hour`); a block = 24 hours.
- **Shift hours come from the sheet:** `config.shift_starts` = comma-separated start times (default `12:00,15:00,18:00,21:00,00:00,03:00,06:00,09:00`). Shift end = next start. Editing the sheet changes the shifts with no code change. `guard_count` (4) sets how many guards; order `[g0,g1,g2,g3,...]` → each guard does 2 shifts (6h) with rest between.
- Everyone on guard is on **standby** for the full 24h (`standby=TRUE`). Other active soldiers are on **patrol**.
- **Presence (in/out of base):** each soldier has `start_date`/`end_date` in the `soldiers` tab (**date+time**, stored as a real Date). Empty = always in base. Generation (`buildBlockRows_`/`generateWeek`) only places soldiers available at the block's start time (`soldierWindows_` + `availableAt_`, epoch comparison — timezone-safe).
- **Weekly generation:** `generateWeek(days=7)` produces 7 draft blocks with running cumulative fairness (`advanceStats_`).
- ⚠️ **Text storage:** schedule/config times & dates are stored as text (`writeTable` sets number format `@` for every tab except `soldiers`). Critical — otherwise Sheets converts "12:00" to a Date and corrupts it via the 1899 LMT offset (observed 12:00→09:39). The `soldiers` tab stays normal so start/end_date remain real dates.

## Fairness algorithm + placement rules (placement is done by Claude — keep everything here)
The user wants placements done through Claude. On every roster generation, Claude must honor:
1. **Cumulative hours:** pick the `guard_count` eligible soldiers with the lowest `cumulative_guard_hours`. Tie-breakers: earliest `last_guard_block`, then alphabetical.
2. **Night-shift fairness (implemented in `generateWeek`):** night = a shift starting **00:00–06:00**. Target **~25% nights** for every guard soldier. The weekly generator assigns the night positions each block to the guards with the lowest **nights-per-guard-day ratio** (`nightRate_`), spreading nights proportionally. Integer limits mean a soldier with 3 guard-days (6 shifts) lands on 17% or 33%; more shifts converge to 25%. The **"יום/לילה" card** in הוגנות shows each soldier's day/night counts and night % (flags deviation >15pts).
3. **Presence:** only soldiers available (their `start_date`/`end_date` window covers the block time) enter placement.
4. **Hard exclusions:** `guard_eligible=FALSE` → never on positions (אסי פרץ). `active=FALSE` → never scheduled.
5. **Forced patrol:** `forcePatrolIds` — marked soldiers don't go on positions this block (they don't accrue hours → fairness raises them sooner as compensation).
- Stats are rebuilt (`recomputeStats_` → `statsFromRows_`) from all published history on every publish — idempotent. `dutyFromRows_` produces the load + day/night breakdown. Both stats and duty have published-only and published+draft variants (the הוגנות "include draft" toggle, default on).
- Rules 1–3 are **implemented in `generateWeek`** (balance = fewest guard-days first; night rotation via `nightRate_`). The single-block `generateNextRotation`/`buildBlockRows_` does plain cumulative-hours fairness only.

## UI capabilities (current)
- **Public tabs:** **"לוז אישי"** — soldier picker (persisted per device) → "כרגע"/"המשמרת הבאה"/contact (call+WhatsApp) + a date picker that scopes **only the shift list**. **"שבצק"** — date picker (‹ today ›), "כוח אפקטיבי", three cards **עמדה / כוננות (two sets: עד 12:00 = prev block, מ-12:00 = this block) / פטרול (merged)**.
- **Admin (password, persists 24h via localStorage):** extra tabs **"טיוטה"** (generate next block / **ייצר שבוע** / must-patrol / inline draft edit / publish / discard), **"חיילים"** (add; set **join/leave** window `start_date`/`end_date` inline; remove), **"הוגנות"** (cumulative hours; **load table** guard/standby vs patrol; **day/night card** ~25% target; **include-draft toggle**).
- **Board inline switch (admin):** in שבצק each guard slot is a dropdown → `editBoardAssignment` on the **published** schedule; server **rejects double-booking** (`findDoubleBooking_` — same soldier overlapping times), auto-fixes guard/patrol, recomputes stats. The draft editor (`editAssignment`) runs the same check.

## Soldier-specific rules (important to preserve)
- **אלישיב לביא** (elyashivlavi@gmail.com) = **admin** (role=admin).
- **שמואל אטלי** = **outpost officer** (role=officer), `guard_eligible=FALSE` → **always patrol, never on positions** (user request; reason kept in `internal_note`).
- **אסי פרץ** = **sergeant**, `guard_eligible=FALSE` → **always patrol, never on positions**. The reason is kept in `internal_note` only and **not shown in the public UI** (user request: keep it aside, not visible).
- **גלעד דביר** and **אביאל גיאת** — must be on patrol **in the initial block (today)**. Implemented via `SEED_FORCE_PATROL` in `Code.gs`. One-time for the current block (not a permanent rule — pending user decision whether to make it permanent).
- Initial block guard order (from 12:00): **עופר קאסה, יהודה ונדרמן, בנג׳י פירר, אלישיב לביא** — via `SEED_FIRST_GUARDS`.
- Full 12-soldier list is in `SEED_SOLDIERS` in `Code.gs`.

## "Must-patrol" capability
The "טיוטה" (draft) tab has "חייבים בפטרול בבלוק הבא" (must patrol next block) checkboxes → they pass `forcePatrolIds` to `generateNextRotation`, and the marked soldiers won't go on positions that block.

## Deploy / run (current state — deployed and live)
The project is **already deployed** via `clasp` (installed and logged in). Full deploy guide: the `deploy-shavtzak` skill.
- **Permanent deployment id (web app):** `AKfycbxRABLTIGwN6LIJwVmFT9NHg2hXtEJpEx3xeAbZKjUrpcT9TDBefBW7Kep_PX2AXhTzhg`
- **Permanent short URL:** https://tinyurl.com/shavtzak-motzav → points to that deployment's `…/exec`.
- **Golden rule for keeping the URL:** for **code** changes always `clasp redeploy <same id>` — the URL doesn't change and the tinyurl stays valid automatically. **Never `create-deployment`** (mints a new URL and breaks the tinyurl; free TinyURL aliases can't be repointed). `create-deployment` is only needed for a `webapp.access` change — already done (ANONYMOUS), won't recur.
- **Deployer authorization (one-time):** done. An anonymous app runs as the deployer, so the deployer must authorize scopes once from the editor (running `setup`/`doGet`). With non-sensitive scopes only, authorization is silent (no "unverified app" screen).
- Note: the open editor sometimes shows an old local version; after `clasp push`, refresh. In the browser, hard-refresh (Cmd+Shift+R) to bypass cache.

## Dev conventions
- **Every `clasp redeploy` is immediately followed by `git commit` + `git push origin main`** (user instruction). Never leave a deploy unpushed. The active branch is `main` (tracks `origin/main`).
- **On every spec/behavior change, update `SPEC.md`** in the same change (user instruction). `SPEC.md` is the implementation-agnostic source of truth for what's stored and what's shown — keep it in sync with the code.
- The developer's identity is not mentioned in commits/code.
- `.gs` syntax is checked locally by copying to `.js` and running `node -c`; the JS in `Index.html` is checked via `vm.createScript` (Apps Script runs V8).
- **Tests:** `node tests/spec.test.js` — loads `apps-script/Code.gs` in a Node vm with a mocked Sheets API and asserts the SPEC behaviors (fairness/balance, presence windows, exclusions, publish, secret-stripping, text storage, duty breakdown). Run before every deploy; extend when SPEC changes. **Tests live OUTSIDE `apps-script/`** (repo-root `tests/`) and `apps-script/.claspignore` excludes `*.test.js` — a Node file with `require` inside the clasp root breaks the whole Apps Script project (`ReferenceError: require is not defined`), taking the site down.
