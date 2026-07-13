# שבצ"ק מוצב — Product Specification (implementation-agnostic)

A duty-roster system for a small military outpost (~12 soldiers) that schedules **guard shifts**
and **patrols**, distributes them fairly, and exposes a public read-only view plus an admin editor.

This spec describes **what is stored** and **what is shown** — not how. It is deliberately free of
any database engine, hosting, or UI-framework choice, so it can be re-implemented on any stack.

---

## 1. Roles & access

| Role | How identified | Can do |
|------|----------------|--------|
| **Visitor / soldier** | No login. Public access. | View the board and any soldier's personal schedule; use contact buttons. |
| **Admin** | A shared **password** (stored in config). No per-user accounts. | Everything a visitor can, plus: generate/edit/publish schedules, manage soldiers, view fairness stats. |

Requirements:
- **No mandatory login** for viewing. The public UI must work for an unauthenticated visitor.
- Since there is no login, a **soldier is identified in the personal view by picking their name** from a list (not by session identity).
- Admin actions are gated by a password check on every privileged operation (the secret must **never** be sent to non-admin clients).
- Admin mode **persists on the device for 24 hours** (so the password isn't re-entered each visit); after 24h, or if the stored password no longer validates, it's cleared and re-prompted.
- **No double-booking:** the system must reject any edit that places the same soldier in two positions at overlapping times.

---

## 2. Core mechanism: Draft → Approve → Publish

- The admin edits a **private draft** schedule. Soldiers never see the draft.
- Soldiers read **only** the **published** schedule.
- An explicit **"Approve & Publish"** action copies draft → published and recomputes fairness stats. Nothing leaks to soldiers before that.
- The admin can **discard** a draft without publishing.

This implies two separate stored schedules: `draft` (private) and `published` (public).

---

## 3. Data model (entities & fields)

Field types are logical. **Important:** times and calendar dates in the *schedule/config* entities
must be stored as **plain text strings** (e.g. `"12:00"`, `"2026-07-12"`), never as native
date/time values — native time cells are corrupted by timezone/epoch conversions. The **soldier
availability window** fields are the exception: they must be true **date+time** values so they can
be compared chronologically.

### 3.1 Soldier
| Field | Type | Meaning |
|-------|------|---------|
| `id` | string | Stable unique id. |
| `name` | string | Full name (display + identity in picker). |
| `email` | string (optional) | Informational only; not used for auth. |
| `role` | enum: `admin`,`officer`,`sergeant`,`soldier` | Display + role label. |
| `active` | boolean | Inactive soldiers are excluded from all scheduling but retained for history. |
| `guard_eligible` | boolean | If false → **never** placed on guard positions (always patrol). |
| `phone` | string (optional) | Public contact number for call/WhatsApp. Empty = not shown. |
| `internal_note` | string (optional) | **Private to admin.** Never shown in the public UI. |
| `start_date` | datetime (optional) | Start of the soldier's presence window in the base. |
| `end_date` | datetime (optional) | End of the presence window. Empty start+end = **always present**. |

### 3.2 Schedule entry (used for both `draft` and `published`)
A flat list of rows; a "block" is all rows sharing a `block_date`.
| Field | Type | Meaning |
|-------|------|---------|
| `block_date` | date-string `YYYY-MM-DD` | The 24-hour block this row belongs to. |
| `position` | enum: `guard`,`patrol` | Kind of duty. |
| `slot` | string | For guard: shift index `0..n-1`. For patrol: `morning`/`evening`. |
| `start` | time-string `HH:MM` | Shift start (guard) or patrol time. |
| `end` | time-string `HH:MM` | Shift end (guard). Empty for patrol. |
| `day_label` | string | Human label: `היום`/`למחרת` (guard, relative to anchor) or `בוקר`/`ערב` (patrol). |
| `soldier_id` | string | Assigned soldier. |
| `soldier_name` | string | Denormalized name for display. |
| `standby` | boolean | True for guards → on call the whole 24h. |
| `note` | string (optional) | Free note. |

### 3.3 Fairness stats (derived, rebuildable)
One row per soldier, **recomputed from the full published history** on every publish (idempotent).
| Field | Type | Meaning |
|-------|------|---------|
| `soldier_id` | string | |
| `name` | string | |
| `cumulative_guard_hours` | number | Total guard hours accrued. Drives fairness. |
| `guard_blocks` | number | Count of blocks in which the soldier guarded. |
| `last_guard_block` | date-string | Most recent guard block (tie-breaker). |

### 3.4 Config (key/value)
| Key | Default | Meaning |
|-----|---------|---------|
| `anchor_hour` | `12` | Hour the 24h block starts (noon). Also the `היום`/`למחרת` boundary. |
| `shift_hours` | `3` | Fallback shift length if `shift_starts` is empty. |
| `shift_starts` | `12:00,15:00,18:00,21:00,00:00,03:00,06:00,09:00` | **Guard shift start times** (comma list). Editable in the DB — defines the shift grid without code changes. Shift end = next start. |
| `guard_count` | `4` | Guards per block. |
| `patrol_morning` | `06:00` | Morning patrol time. |
| `patrol_evening` | `18:00` | Evening patrol time. |
| `admin_password` | (secret) | Admin gate. Never exposed to clients. |

---

## 4. Scheduling logic

- Rotation is anchored to `anchor_hour` (noon); each **block = 24 hours**.
- A block has `guard_count` guards. Shift start times come from `shift_starts`; there are
  `shift_starts.length` shifts per block, assigned round-robin `[g0,g1,…,g_{k-1},g0,…]` so each
  guard does an equal number of shifts spread across the day (default: 2 shifts of 3h, 6h total,
  with rest between them).
- Every guard is on **standby** (`standby=true`) for the entire 24h block.
- All other **present, active** soldiers are on **patrol** (morning + evening).
- `guard_eligible=false` and forced-patrol soldiers are never placed on guard.

---

## 5. Fairness & placement rules

Placement (who guards, in which shift) must satisfy, in order:

1. **Least cumulative hours first:** choose the `guard_count` eligible soldiers with the lowest
   `cumulative_guard_hours`. Tie-breakers: earliest `last_guard_block`, then alphabetical.
2. **Night-shift fairness:** a soldier who worked night shifts (**00:00–03:00 / 03:00–06:00**) in a
   block should get **non-night** shifts next time they guard. Never assign the same person night
   shifts twice in a row; spread nights across soldiers over the week.
3. **Presence:** only soldiers whose availability window (`start_date`..`end_date`) covers the
   block's start time are eligible (empty window = always eligible).
4. **Hard exclusions:** `guard_eligible=false` → never on guard; `active=false` → never scheduled.
5. **Forced patrol:** a per-block set of soldiers who must stay on patrol (not placed on guard) this
   block. They don't accrue guard hours, so fairness raises them sooner afterward (compensation).

Fairness stats are always **rebuilt from published history** so manual edits are reflected correctly.

---

## 6. Weekly generation

- The admin can generate a **whole week** (default 7 consecutive 24h blocks) into the draft in one action.
- The generator must, in priority order:
  1. **Balance guard-days across the week** — each block, prefer soldiers with the fewest guard-days so far this week, so static/patrol load is even across everyone.
  2. **Historical fairness** — then lowest `cumulative_guard_hours`, then earliest `last_guard_block`.
  3. **Rotate night shifts** — assign the night positions (shifts starting 00:00–06:00) to whoever has done the fewest nights so far this week.
- Fairness accumulates **across the generated blocks** (a running tally), so the week is balanced end-to-end, not just per-block.
- Presence windows and exclusions are respected per block (a soldier present only part of the week is placed only on covered days).

---

## 7. UI

Hebrew, right-to-left. Light, clean, mobile-first. Two public tabs; three more for admin.

### 7.1 Tab "לוז אישי" (Personal) — public
- **Soldier picker**: choose a name from the active roster. The selection **persists** across reloads (per device).
- **Date navigation**: `‹  [date input, default today]  ›  היום`. Changing it filters to that day.
- **"כרגע" (Now)** card: current status for the selected soldier — on guard / not on guard now / on patrol-or-base — plus a **"בכוננות 12:00–12:00"** badge when on standby. Always reflects **today**, unaffected by the date picker.
- **"המשמרת הבאה" (Next shift)** card: the soldier's next upcoming guard shift (time + date), independent of the picked day.
- **Contact** card: phone + **call** and **WhatsApp** buttons (only if a phone exists).
- **Date navigation** (`‹ [date, default today] › היום`) — scopes **only the shift list below it**, not the "כרגע"/next/contact cards.
- **List** of the soldier's shifts for the selected day (guard shifts with times + standby tag; patrols).

### 7.2 Tab "שבצק" (Board) — public (admin can edit)
- **Date navigation** identical to the personal tab (shared selected date). Defaults to today; prev/next step one day.
- **"כוח אפקטיבי" (Effective force)** summary for the selected day (headcount).
- For the selected day's block, **three titled cards**:
  - **עמדה (Position)** — the guard rotation table: shift label, hours, soldier.
  - **כוננות (Standby)** — the standby soldiers, shown as **two sets**: **עד 12:00** (the previous block's guards) and **מ-12:00** (this block's guards). A calendar day is covered by two consecutive blocks.
  - **פטרול (Patrol)** — the patrol soldiers as a **single merged list** (no morning/evening split).
- If no schedule exists for the chosen date, show a clear empty message.
- **Admin inline switch:** an admin sees each guard slot as a dropdown and can swap the assigned soldier directly on the published board. On save the server **rejects any change that double-books a soldier at an overlapping time** (a soldier may not be in two positions at once); it also keeps guard/patrol consistent (the incoming soldier is removed from patrol; the displaced one is moved to patrol) and recomputes fairness stats.

### 7.3 Admin-only tabs (behind password)
- **"טיוטה" (Draft):** generate next block, **generate week (7 days)**, optionally mark "must-patrol" soldiers for the next block, edit any guard slot inline, then **Approve & Publish** or **Discard**. A banner reminds that the draft is not visible to soldiers.
- **"חיילים" (Soldiers):** add a soldier (name, phone, email, role, guard-eligible); list all with a private-note indicator; **set each soldier's join/leave presence window** (`start_date`/`end_date`, date+time) inline — outside the window the soldier isn't scheduled; empty both = permanently in base; remove (soft-delete → inactive, history kept).
- **"הוגנות" (Fairness):** (a) cumulative guard hours per soldier, sorted ascending, so the admin sees who's next; (b) a **load table** per soldier of **guard (static) hours** + **standby hours** (guard-days × 24) vs **patrol count**. A **"include draft" toggle (default on)** recomputes both tables over published **+ the unpublished draft** (projected view) vs published-only.

---

## 8. Behaviors & constraints (non-functional requirements)

- **Public, no-login viewing.** Admin identified only by password; the password is never sent to clients.
- **Privacy:** `internal_note` is admin-only and never rendered publicly. Phone numbers are public by design but empty by default (opt-in per soldier).
- **Persistence:** the personal-view soldier selection is remembered on the device.
- **Time storage:** schedule/config times and dates are stored as **strings**; only soldier
  presence windows are true datetimes. (Learned constraint — native time cells drift under
  timezone/epoch conversion.)
- **Idempotent setup & stats:** re-running setup must not overwrite existing data; stats rebuild deterministically from published history.
- **Localization:** Hebrew RTL throughout; short shareable public URL.
