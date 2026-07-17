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
| `role` | enum: `admin`,`officer`,`sergeant`,`soldier` | Single exclusive rank/role. Display + role label. |
| `active` | boolean | Inactive soldiers are excluded from all scheduling but retained for history. |
| `guard_eligible` | boolean | If false → **never** placed on guard positions (always patrol). |
| `phone` | string (optional) | Public contact number for call/WhatsApp. Empty = not shown. |
| `internal_note` | string (optional) | **Private to admin.** Never shown in the public UI. |
| `start_date` | datetime (optional) | Start of the soldier's presence window in the base. |
| `end_date` | datetime (optional) | End of the presence window. Empty start+end = **always present**. |
| `skills` | comma-separated set from `{קלע, רחפן}` (optional) | **Multi-value capability tags**, orthogonal to `role` — a soldier may hold both, and any rank. Used to apply scheduling rules to marksmen (קלע) / drone operators (רחפן). Edited via the admin "חיילים" tab (checkboxes). Not shown in the public UI. |

### 3.2 Schedule entry (used for `draft`, `published`, and `past`)
A flat list of rows; a "block" is all rows sharing a `block_date`. The same shape backs three stores: `schedule_draft` (admin-private edit buffer), `schedule_published` (soldier-visible), and **`schedule_past`** — an **immutable, append-only** archive of blocks that have already fully elapsed. `schedule_past` is never edited or overwritten, only appended to; it is the frozen ground-truth base for fairness so history can't be altered by later edits or regeneration.
| Field | Type | Meaning |
|-------|------|---------|
| `block_date` | date-string `YYYY-MM-DD` | The 12:00-anchored 24-hour block this row belongs to (grouping/rotation key). |
| `shift_date` | date-string `YYYY-MM-DD` | The **real calendar date** the shift occurs on = `block_date` for daytime/evening shifts, `block_date + 1` for after-midnight/morning shifts (start hour < anchor). Disambiguates the DB (a `למחרת` row's actual day). |
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
One row per soldier, **recomputed from the fairness base** on every publish/edit (idempotent). The fairness base = `schedule_past` (immutable, completed blocks) ∪ `schedule_published`, deduped per shift (past wins). A block is archived to `schedule_past` once it has fully elapsed (now past `block_date + 1` at the anchor hour); archiving is automatic, idempotent, and runs on load and before every generate/publish. Consequently: elapsed shifts count from the frozen archive even if `published` is later edited or regenerated, upcoming published shifts still count for planning, and no shift is double-counted. **Editing a block that has already elapsed is rejected** (board swap / on-call swap) — the past cannot change.
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

### 3.5 מחלקה (squad)
A grouping of soldiers who should preferably serve together (see rule §5.10). Stored as its own table
(`מחלקה` tab): **one row per squad**, a `commander` column plus soldier columns (`soldier1..N`). Members
are referenced **by name** (matched against the `soldiers` roster; unknown names are ignored). A squad
with fewer than 2 resolvable members is inert. Seeded with one squad: commander **אביאל גיאת**, soldiers
**אורי אברג׳יל, נתנאל חזקיה, מתן כהן**. Edited directly in the DB tab (no dedicated UI).

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
6. **Rest day:** after a guard-day (24h static/standby block) a soldier gets **at least one patrol
   day** before guarding again — never two consecutive guard-days (no 48h back-to-back static).
   Relax only if too few soldiers are otherwise available. The fairness view surfaces a
   **consecutive-static-days** metric that must read 0 for everyone.
7. **קלע (marksman) on patrol:** at least one soldier carrying the `קלע` skill must remain on
   **patrol** each block. If every present marksman was picked for guard, the generator releases the
   lowest-priority one (most accrued) back to patrol and pulls up the next-fairest non-marksman.
   **Only enforced when 2+ marksmen are present** — with a single marksman the rule is ignored (so
   the sole marksman isn't permanently benched to patrol). Also skipped when no non-marksman
   candidate exists.
8. **רחפן (drone operator) shift restriction:** a soldier with the `רחפן` skill may guard, but must
   **never** hold the guard shift that starts **06:00 (06–09)** or **18:00 (18–21)** — the drone
   operator is needed for other tasks in those windows. If a רחפן is placed on such a position, the
   generator swaps positions with a non-רחפן guard in an allowed position. Best-effort.
9. **Night → day two days later (best-effort):** if a soldier held a **night** on-call position
   (guard shift starting 00:00–06:00) on a guard-day, and they guard again **exactly two days
   later**, prefer giving them a **day/evening** position on that later day (a non-night guard
   position — with the default grid, shifts starting **18:00 (18–21)** or **21:00 (21–00)**). Applied
   as the top priority when ordering the chosen guards into positions; if every chosen guard is in
   that situation, night-rotation fairness decides instead. Does not change **who** guards, only
   **which** position — so it never breaks balance/presence/rest.
10. **מחלקה cohesion (soft nudge):** soldiers belonging to the same *מחלקה* (a commander + their
    soldiers, see §3.5) are preferably scheduled **together** — either all on guard (on-call+static)
    the same block, or all on patrol together. Implemented as a soft nudge: after the fair guard set
    is chosen, the generator pulls additional present squad members onto guard **only** by swapping
    out a non-squad guard in the **same balance tier** (equal guard-days-so-far), so it never degrades
    the primary guard-day balance. If no zero-cost swap exists the squad may split (fairness wins).
    Squad members who aren't picked for guard remain on patrol together automatically. The rest rule
    (§5.6) still applies, so a full squad that guards together rests together the next day (a large
    squad naturally alternates halves across days).
11. **No two patrol-days in a row (soft preference):** prefer **not** to leave a guard-eligible
    soldier on **patrol two blocks in a row** — a soldier who was on patrol the previous block is
    preferred for guard this block (over one who wasn't), **within the same balance tier** (equal
    guard-days-so-far). **Priority:** this is **stronger than the מחלקה cohesion nudge (§5.10)** —
    the squad swap will not bench a soldier onto a second consecutive patrol-day if another swap-out
    is available — but **weaker than the guard-rest rule (§5.6)**, which still forbids two guard-days
    in a row outright. Best-effort: on a tight roster (more guard-eligible present than guard slots)
    some soldiers must patrol on consecutive days; the preference only keeps those runs as short as
    the balance allows. The **consecutive-patrol-days** figure in the הוגנות "עמדה רצופה" card
    surfaces the result (informational, no hard target). Applies only to guard-eligible soldiers —
    those never on positions (e.g. אסי פרץ, שמואל אטלי) are always on patrol by design.

Fairness stats are always **rebuilt from the immutable history base** so manual edits are reflected correctly.

**Weekly fairness window (Sunday → Sunday):** fairness is counted **only within the current week**,
defined as **Sunday 12:00 (anchor) → the next Sunday 12:00**. The window rolls forward automatically
(it is derived from today's date, so every Sunday noon it advances). Blocks outside the current week
are **ignored** for fairness. This applies to **both** the הוגנות display metrics (cumulative hours,
day/night, patrol %, consecutive-static-days) **and** the generator's fairness seed (a soldier's
accrued load resets each week for placement decisions). **Exception:** the safety rules that need real
day-adjacency — the **rest rule** (no back-to-back guard-days) and **night spacing** (night → day two
days later) — still read the true immediately-preceding blocks even across the week boundary, so a
Saturday→Sunday back-to-back can't slip through. (Membership is by `block_date`, which uniquely places
each 24h block in one week.)

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
- **List** of the soldier's shifts for the selected **calendar day (midnight → midnight)**, chosen by `shift_date` and ordered chronologically (guard shifts with times + standby tag; patrols). Mirroring the board: shifts **before 12:00 noon are greyed out** (dimmed) — they belong to the tail of the previous 12:00-anchored block.

### 7.2 Tab "שבצק" (Board) — public (admin can edit)
- **Date navigation** identical to the personal tab (shared selected date). Defaults to today; prev/next step one day.
- **"כוח אפקטיבי" (Effective force)** summary for the selected day (headcount).
- For the selected day, **three titled cards**:
  - **עמדה (Position)** — the guard rotation table for the selected day spans **00:00 of that day → 12:00 the next day (36 hours)**: the after-midnight shifts of the previous 12:00-anchored block plus the full current block. Each row shows **weekday (ראשון…שבת)**, date, hours, soldier.
  - **כוננות (Standby)** — the standby soldiers, shown as **two sets**: **עד 12:00** (the previous block's guards) and **מ-12:00** (this block's guards). A calendar day is covered by two consecutive blocks.
  - **פטרול (Patrol)** — the patrol soldiers as a **single merged list** (no morning/evening split), under a static **החל מ12:00** label (the list belongs to the block starting at 12:00).
- If no schedule exists for the chosen date, show a clear empty message.
- **Admin inline switch:** an admin sees each guard slot as a dropdown and can swap the assigned soldier directly on the published board. On save the server **rejects any change that double-books a soldier at an overlapping time** (a soldier may not be in two positions at once); it also keeps guard/patrol consistent (the incoming soldier is removed from patrol; the displaced one is moved to patrol) and recomputes fairness stats.
- **On-call (כוננות):** on-call = the block's guards, so the כוננות card is **read-only** (shown to everyone, not editable even in admin) — it's derived from the עמדה shifts and updates automatically when the guard slots change.
- **Loading indicator:** any server round-trip that refreshes data (entering admin mode, editing a shift, publishing, generating, etc.) shows a spinner overlay until it completes.

### 7.3 Admin-only tabs (behind password)
- **"טיוטה" (Draft):** generate a draft for a **chosen full-date range** — pick a start and end date (whole dates only, **default both = tomorrow**); a single day generates one block, a wider range one block per day. The range **may cover dates that were already planned/published** (re-plan). Optionally mark "must-patrol" soldiers (applied to the **first** day of the range), edit any guard slot inline, then **Approve & Publish** (merges into published, replacing same-date blocks) or **Discard**. A banner reminds that the draft is not visible to soldiers.
- **"חיילים" (Soldiers):** add a soldier (name, phone, email, role, guard-eligible, **skills** קלע/רחפן); list all with a private-note indicator; **toggle each soldier's skills** (קלע/רחפן checkboxes) inline; **set each soldier's join/leave presence window** (`start_date`/`end_date`, date+time) inline — outside the window the soldier isn't scheduled; empty both = permanently in base; remove (soft-delete → inactive, history kept).
- **"הוגנות" (Fairness):** (a) cumulative guard hours per soldier, sorted ascending, so the admin sees who's next; (b) a **load table** per soldier of **guard (static) hours** + **standby hours** (guard-days × 24) vs **patrol shift count (morning/evening)** — patrol is **never shown as hours** (patrol hours are not meaningful; count morning/evening shifts instead). The load table also shows, **relative to each soldier's presence**, the **present-days** (guard-days + patrol-days, which are disjoint), the **standby/on-call %** (guard-days ÷ present-days) and the **patrol %** (patrol-days ÷ present-days) — so fairness is comparable across soldiers who were in base for different lengths of time (a soldier present 3 days vs 10 days is judged by proportion, not raw count). (c) a **day/night card** — per soldier, count of **day** vs **night** shifts (night = a shift starting 00:00–06:00) and the **night %**, with a target of **~25%** for everyone who does guard duty (flag deviations beyond ±15 points). (d) a **"עמדה רצופה" (consecutive static days) card** — per soldier, the number of **consecutive guard (static-position) days beyond the first** in their longest adjacent-day run. The rest-day rule forbids two guard-days in a row, so this **should be 0 for every soldier**; any value > 0 is flagged in red. The same card also shows, per soldier, the **consecutive patrol days** = the length of their longest run of adjacent patrol days (a day = the 12:00-noon→12:00-noon block, i.e. adjacent `block_date`s) — informational only, no target. A **"include draft" toggle (default on)** recomputes all tables over published **+ the unpublished draft** (projected view) vs published-only.

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
