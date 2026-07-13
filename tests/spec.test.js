/*
 * SPEC coverage tests for the shavtzak Apps Script logic.
 *
 * Apps Script has no native test runner, but Code.gs is plain V8 JS whose only
 * external deps are the Google services (SpreadsheetApp/Utilities/Session/…).
 * We mock those with an in-memory spreadsheet and load Code.gs in a Node vm,
 * then assert the SPEC.md behaviors. Run: `node apps-script/tests/spec.test.js`.
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');

// ---------- in-memory spreadsheet mock ----------
function makeSpreadsheet() {
  const store = {}; // sheetName -> 2D array of cells
  function range(name, row, col, nRows, nCols) {
    return {
      getValues() {
        const out = [];
        for (let r = 0; r < nRows; r++) {
          const src = store[name][row - 1 + r] || [];
          const rowArr = [];
          for (let c = 0; c < nCols; c++) { const v = src[col - 1 + c]; rowArr.push(v !== undefined ? v : ''); }
          out.push(rowArr);
        }
        return out;
      },
      setValues(vals) {
        for (let r = 0; r < vals.length; r++) {
          const tr = row - 1 + r;
          if (!store[name][tr]) store[name][tr] = [];
          for (let c = 0; c < vals[r].length; c++) store[name][tr][col - 1 + c] = vals[r][c];
        }
        return this;
      },
      setNumberFormat() { return this; },
      setFontWeight() { return this; },
    };
  }
  function sheet(name) {
    return {
      _name: name,
      getName() { return name; },
      getDataRange() {
        const d = store[name] || [];
        const nR = d.length || 1;
        const nC = d.reduce((m, r) => Math.max(m, r.length), 0) || 1;
        return range(name, 1, 1, nR, nC);
      },
      getRange(r, c, nr, nc) { return range(name, r, c, nr || 1, nc || 1); },
      getLastRow() { return (store[name] || []).length; },
      clearContents() { store[name] = []; return this; },
      setFrozenRows() { return this; },
    };
  }
  return {
    _store: store,
    getSheetByName(n) { return store[n] !== undefined ? sheet(n) : null; },
    insertSheet(n) { store[n] = []; return sheet(n); },
    getSheets() { return Object.keys(store).map(sheet); },
    deleteSheet(s) { delete store[s._name]; },
    getSpreadsheetTimeZone() { return 'Asia/Jerusalem'; },
    toast() {},
  };
}

let ACTIVE_SS = makeSpreadsheet();
let ACTIVE_EMAIL = '';

const p2 = (n) => (n < 10 ? '0' : '') + n;
const SpreadsheetApp = { getActiveSpreadsheet: () => ACTIVE_SS };
const Session = { getActiveUser: () => ({ getEmail: () => ACTIVE_EMAIL }) };
const ContentService = { createTextOutput: (s) => ({ getContent: () => s }) };
const HtmlService = {
  createTemplateFromFile: () => ({ evaluate: () => ({ setTitle() { return this; }, addMetaTag() { return this; }, setXFrameOptionsMode() { return this; } }) }),
  createHtmlOutputFromFile: () => ({ getContent: () => '' }),
  XFrameOptionsMode: { ALLOWALL: 1 },
};
const Utilities = {
  formatDate(d, tz, fmt) {
    const gmt = tz === 'GMT';
    const Y = gmt ? d.getUTCFullYear() : d.getFullYear();
    const Mo = p2((gmt ? d.getUTCMonth() : d.getMonth()) + 1);
    const Da = p2(gmt ? d.getUTCDate() : d.getDate());
    const H = p2(gmt ? d.getUTCHours() : d.getHours());
    const Mi = p2(gmt ? d.getUTCMinutes() : d.getMinutes());
    if (fmt === 'HH:mm') return H + ':' + Mi;
    if (fmt === 'yyyy-MM-dd') return Y + '-' + Mo + '-' + Da;
    return Y + '-' + Mo + '-' + Da + ' ' + H + ':' + Mi;
  },
};

// ---------- load Code.gs ----------
const code = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
const G = { SpreadsheetApp, Session, ContentService, HtmlService, Utilities, console };
vm.createContext(G);
vm.runInContext(code, G);

// ---------- tiny test runner ----------
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + (e && e.message)); }
}
function reset() { ACTIVE_SS = makeSpreadsheet(); ACTIVE_EMAIL = ''; G.setup(); }
function soldierRow(name) { // returns [rowIndex, headers] for a soldier by name
  const t = ACTIVE_SS._store['soldiers'];
  const h = t[0];
  for (let i = 1; i < t.length; i++) if (t[i][h.indexOf('name')] === name) return [i, h];
  return [-1, h];
}
function setSoldierCell(name, col, value) {
  const [i, h] = soldierRow(name);
  ACTIVE_SS._store['soldiers'][i][h.indexOf(col)] = value;
}
function draftNames() { return G.readTable('schedule_draft').map((r) => r.soldier_name); }
function guardDaysByName(rows) {
  const m = {};
  rows.filter((r) => r.position === 'guard').forEach((r) => { (m[r.soldier_name] = m[r.soldier_name] || {})[r.block_date] = 1; });
  const out = {}; Object.keys(m).forEach((n) => (out[n] = Object.keys(m[n]).length)); return out;
}
function nightsByName(rows) {
  const m = {};
  rows.filter((r) => r.position === 'guard' && G.parseHourNum_(r.start) >= 0 && G.parseHourNum_(r.start) < 6)
    .forEach((r) => (m[r.soldier_name] = (m[r.soldier_name] || 0) + 1));
  return m;
}
const spread = (obj) => { const v = Object.values(obj); return Math.max(...v) - Math.min(...v); };

console.log('SPEC coverage tests\n');

// §3/§4 setup builds all tabs + seeds
test('setup creates 5 tabs, seeds 12 soldiers, seeds first block', () => {
  reset();
  ['soldiers', 'schedule_draft', 'schedule_published', 'stats', 'config'].forEach((t) =>
    assert(ACTIVE_SS._store[t] !== undefined, 'missing tab ' + t));
  assert.strictEqual(G.readTable('soldiers').length, 12);
  assert(G.readTable('schedule_published').length > 0, 'no first block');
});

// §3.4 config has DB-driven shift hours + secret
test('config seeded with shift_starts and admin_password', () => {
  const cfg = G.getConfigAll();
  assert(cfg.shift_starts && cfg.shift_starts.indexOf('12:00') === 0, 'shift_starts');
  assert.strictEqual(cfg.admin_password, 'admin1234');
});

// §8 text storage: times stay strings (not Date)
test('schedule times stored/read as strings, not Dates', () => {
  const g = G.readTable('schedule_published').find((r) => r.position === 'guard');
  assert.strictEqual(typeof g.start, 'string');
  assert.strictEqual(g.start, '12:00');
});

// §1 public bootstrap hides secrets + admin data
test('getBootstrap (anonymous) hides secrets and admin data', () => {
  const b = G.getBootstrap('');
  assert.strictEqual(b.user.isAdmin, false);
  assert.strictEqual(b.config.admin_password, undefined);
  assert.strictEqual(b.config.admin_emails, undefined);
  assert.strictEqual(b.soldiers, undefined);
  assert(Array.isArray(b.roster) && b.roster.length === 12);
  assert.strictEqual(b.roster[0].email, undefined, 'roster must not leak email');
  assert.strictEqual(b.roster[0].internal_note, undefined, 'roster must not leak notes');
});

// §1 admin bootstrap
test('getBootstrap(password) exposes admin data + duty', () => {
  const b = G.getBootstrap('admin1234');
  assert.strictEqual(b.user.isAdmin, true);
  assert(Array.isArray(b.soldiers) && b.soldiers.length === 12);
  assert(Array.isArray(b.duty));
});

// §1 password gate
test('requireAdmin_ enforces the password', () => {
  assert.throws(() => G.requireAdmin_('wrong'));
  assert.strictEqual(G.requireAdmin_('admin1234'), true);
});

// §3.4 shift_starts parsing + fallback
test('shiftStarts_ reads config, falls back to anchor+shift_hours', () => {
  assert.strictEqual(JSON.stringify(G.shiftStarts_({ shift_starts: '12:00,15:00' })), JSON.stringify(['12:00', '15:00']));
  const fb = G.shiftStarts_({ shift_starts: '', anchor_hour: '12', shift_hours: '6' });
  assert.strictEqual(fb.length, 4);
  assert.strictEqual(fb[0], '12:00');
});

// §8 date/window helpers
test('availableAt_ / blockStartInstant_ / advanceDate_', () => {
  const inst = G.blockStartInstant_('2026-07-13', 12);
  assert.strictEqual(G.availableAt_(null, inst), true);
  assert.strictEqual(G.availableAt_({ start: inst + 1, end: null }, inst), false);
  assert.strictEqual(G.availableAt_({ start: null, end: inst - 1 }, inst), false);
  assert.strictEqual(G.availableAt_({ start: inst - 1, end: inst + 1 }, inst), true);
  assert.strictEqual(G.advanceDate_('2026-07-13', 1), '2026-07-14');
});

// §5 exclusions: guard_eligible=false never on guard; inactive never scheduled
test('generateWeek: sergeant never guards, inactive excluded', () => {
  reset();
  setSoldierCell('נתנאל חזקיה', 'active', 'FALSE');
  G.generateWeek(7, 'admin1234');
  const rows = G.readTable('schedule_draft');
  assert(!rows.some((r) => r.position === 'guard' && r.soldier_name === 'אסי פרץ'), 'sergeant guarded');
  assert(!draftNames().includes('נתנאל חזקיה'), 'inactive scheduled');
});

// §5/§6 presence window excludes an unavailable soldier
test('generateWeek: soldier outside presence window is not scheduled', () => {
  reset();
  setSoldierCell('מתן כהן', 'start_date', new Date(2099, 0, 1)); // available only from 2099
  G.generateWeek(7, 'admin1234');
  assert(!draftNames().includes('מתן כהן'), 'unavailable soldier scheduled');
});

// §6 weekly balance: guard-days and nights spread ≤ 1
test('generateWeek balances guard-days and rotates nights', () => {
  reset();
  const res = G.generateWeek(7, 'admin1234');
  assert.strictEqual(res.summary.length, 7);
  const rows = G.readTable('schedule_draft');
  assert(spread(guardDaysByName(rows)) <= 1, 'guard-days not balanced');
  assert(spread(nightsByName(rows)) <= 1, 'nights not balanced');
});

// §2 publish: draft -> published, stats recomputed, draft cleared
test('publishDraft moves draft to published and rebuilds stats', () => {
  reset();
  G.generateWeek(7, 'admin1234');
  const before = G.readTable('schedule_published').length;
  G.publishDraft('admin1234');
  assert.strictEqual(G.readTable('schedule_draft').length, 0, 'draft not cleared');
  assert(G.readTable('schedule_published').length > before, 'published not extended');
  assert(G.readTable('stats').length > 0, 'stats not built');
});

// §7.3 duty breakdown: guard hours vs patrol
test('dutyBreakdown_ splits guard hours / standby / patrol', () => {
  reset();
  G.generateWeek(7, 'admin1234');
  G.publishDraft('admin1234');
  const duty = G.dutyBreakdown_();
  const asi = duty.find((d) => d.name === 'אסי פרץ');
  assert(asi && asi.guard_hours === 0 && asi.patrol_count > 0, 'sergeant should be patrol-only');
  const guardBusy = duty.find((d) => d.guard_hours > 0);
  assert(guardBusy && guardBusy.standby_hours >= 24, 'guard should have standby hours');
});

// §7.3 admin sets join/leave window via updateSoldier
test('updateSoldier persists join/leave (start_date/end_date)', () => {
  reset();
  const id = G.readTable('soldiers').find((s) => s.name === 'מתן כהן').id;
  G.updateSoldier(id, { start_date: '2026-08-01 12:00', end_date: '2026-08-10 12:00' }, 'admin1234');
  const s = G.readTable('soldiers').find((x) => x.id === id);
  assert.strictEqual(s.start_date, '2026-08-01 12:00');
  assert.strictEqual(s.end_date, '2026-08-10 12:00');
  assert.throws(() => G.updateSoldier(id, { start_date: '' }, 'wrong'), 'must require admin');
});

// skills (קלע/רחפן) — multi-value capability tags for scheduling rules
test('skills: updateSoldier normalizes + persists, hasSkill_ queries', () => {
  reset();
  const id = G.readTable('soldiers').find((s) => s.name === 'מתן כהן').id;
  // array input, one bogus value dropped, dedup
  G.updateSoldier(id, { skills: ['קלע', 'רחפן', 'רחפן', 'לא-קיים'] }, 'admin1234');
  let s = G.readTable('soldiers').find((x) => x.id === id);
  assert.strictEqual(s.skills, 'קלע,רחפן');
  assert.strictEqual(G.hasSkill_(s, 'קלע'), true);
  assert.strictEqual(G.hasSkill_(s, 'רחפן'), true);
  assert.strictEqual(G.hasSkill_(s, 'מפקד'), false);
  // string input clears to a single skill
  G.updateSoldier(id, { skills: 'קלע' }, 'admin1234');
  s = G.readTable('soldiers').find((x) => x.id === id);
  assert.strictEqual(s.skills, 'קלע');
  assert.strictEqual(G.soldierSkills_(s).join(','), 'קלע');
  // addSoldier accepts skills as its new 6th arg
  const r = G.addSoldier('לוחם חדש', '', 'soldier', true, '', ['רחפן'], 'admin1234');
  const n = G.readTable('soldiers').find((x) => x.id === r.id);
  assert.strictEqual(n.skills, 'רחפן');
});

// schedule_past — immutable append-only archive + fairness base
test('archivePast_ appends elapsed blocks once, immutable, feeds fairness base', () => {
  reset();
  const sid = G.readTable('soldiers')[0].id;
  const grow = (slot, start, end, dl) => ({
    block_date: '2020-01-01', shift_date: '2020-01-01', position: 'guard', slot: String(slot),
    start, end, day_label: dl, soldier_id: sid, soldier_name: 'X', standby: 'TRUE', note: '',
  });
  G.writeTable('schedule_published', [grow(0, '12:00', '15:00', 'היום'), grow(4, '00:00', '03:00', 'למחרת')]);
  G.archivePast_();
  assert.strictEqual(G.readTable('schedule_past').length, 2, 'elapsed block archived');
  G.archivePast_();
  assert.strictEqual(G.readTable('schedule_past').length, 2, 'idempotent — no duplicates');
  // immutable: wiping published leaves the archive untouched
  G.writeTable('schedule_published', []);
  assert.strictEqual(G.readTable('schedule_past').length, 2, 'archive survives published change');
  // fairness base still counts archived rows though published is empty
  const base = G.fairnessBaseRows_();
  assert.strictEqual(base.filter((r) => r.block_date === '2020-01-01').length, 2);
  const st = G.statsFromRows_(base).find((s) => s.soldier_id === sid);
  assert(st.cumulative_guard_hours >= 6, 'archived hours counted in stats');
});

test('editing an elapsed (archived) block is rejected', () => {
  reset();
  const sid = G.readTable('soldiers')[0].id;
  G.writeTable('schedule_published', [{
    block_date: '2020-01-01', shift_date: '2020-01-01', position: 'guard', slot: '0',
    start: '12:00', end: '15:00', day_label: 'היום', soldier_id: sid, soldier_name: 'X', standby: 'TRUE', note: '',
  }]);
  const sid2 = G.readTable('soldiers')[1].id;
  assert.throws(() => G.editBoardAssignment('2020-01-01', '0', sid2, 'admin1234'), /הסתיים/);
  assert.throws(() => G.swapGuardPerson('2020-01-01', sid, sid2, 'admin1234'), /הסתיים/);
});

// draft a custom full-date range (default tomorrow), re-plannable
test('generateRange builds a block per day in [start..end]', () => {
  reset();
  const r = G.generateRange('2030-05-10', '2030-05-12', [], 'admin1234');
  assert.strictEqual(r.days, 3);
  const dates = Array.from(new Set(G.readTable('schedule_draft').map((x) => x.block_date))).sort();
  assert.strictEqual(dates.join(','), '2030-05-10,2030-05-11,2030-05-12');
  // empty end defaults to start (single day)
  assert.strictEqual(G.generateRange('2030-06-01', '', [], 'admin1234').days, 1);
  assert.throws(() => G.generateRange('2030-05-12', '2030-05-10', [], 'admin1234'), /מוקדם/);
  assert.throws(() => G.generateRange('2030-05-10', '2030-05-10', [], 'wrong'), 'requires admin');
});

// fairness: consecutive static (guard) days — should be 0 under the rest rule
test('dutyFromRows_ reports consecutive guard days (0 when non-adjacent)', () => {
  reset();
  const gd = (sid, date) => ({
    block_date: date, shift_date: date, position: 'guard', slot: '0',
    start: '12:00', end: '15:00', day_label: 'היום', soldier_id: sid, soldier_name: 'X', standby: 'TRUE', note: '',
  });
  const A = G.readTable('soldiers')[0].id, B = G.readTable('soldiers')[1].id;
  // A guards on adjacent days (violation), B on non-adjacent days (fine)
  const rows = [gd(A, '2026-03-01'), gd(A, '2026-03-02'), gd(A, '2026-03-03'), gd(B, '2026-03-01'), gd(B, '2026-03-05')];
  const duty = G.dutyFromRows_(rows);
  const a = duty.find((d) => d.soldier_id === A), b = duty.find((d) => d.soldier_id === B);
  assert.strictEqual(a.consec_static_days, 2, 'A: 3 in a row → 2 extra consecutive');
  assert.strictEqual(b.consec_static_days, 0, 'B: non-adjacent → 0');
});

// §1/§7.2 no double-booking detection
test('findDoubleBooking_ flags overlaps, allows adjacent', () => {
  const ok = [
    { soldier_id: 'x', soldier_name: 'X', position: 'guard', start: '12:00', end: '15:00' },
    { soldier_id: 'x', soldier_name: 'X', position: 'guard', start: '15:00', end: '18:00' },
  ];
  assert.strictEqual(G.findDoubleBooking_(ok, 12), null);
  const bad = [
    { soldier_id: 'x', soldier_name: 'X', position: 'guard', start: '12:00', end: '15:00' },
    { soldier_id: 'x', soldier_name: 'X', position: 'patrol', start: '13:00', end: '' },
  ];
  assert.strictEqual(G.findDoubleBooking_(bad, 12), 'X');
});

// §7.2 admin board switch on published schedule
test('editBoardAssignment swaps guard, de-conflicts patrol, requires admin', () => {
  reset();
  const pub = G.readTable('schedule_published');
  const grow = pub.find((r) => r.position === 'guard');
  const patrolSoldier = pub.find((r) => r.block_date === grow.block_date && r.position === 'patrol');
  G.editBoardAssignment(grow.block_date, grow.slot, patrolSoldier.soldier_id, 'admin1234');
  const after = G.readTable('schedule_published');
  const ng = after.find((r) => r.block_date === grow.block_date && r.position === 'guard' && String(r.slot) === String(grow.slot));
  assert.strictEqual(ng.soldier_id, patrolSoldier.soldier_id);
  assert(!after.some((r) => r.block_date === grow.block_date && r.position === 'patrol' && r.soldier_id === patrolSoldier.soldier_id), 'incoming still on patrol');
  assert.throws(() => G.editBoardAssignment(grow.block_date, grow.slot, patrolSoldier.soldier_id, 'wrong'));
});

// §7.3 fairness include-draft variants
test('getBootstrap admin returns draft-inclusive stats/duty', () => {
  reset();
  G.generateWeek(7, 'admin1234'); // fills draft; published = seed block only
  const b = G.getBootstrap('admin1234');
  assert(Array.isArray(b.statsDraft) && Array.isArray(b.dutyDraft));
  const sum = (a) => a.reduce((t, s) => t + Number(s.cumulative_guard_hours), 0);
  assert(sum(b.statsDraft) > sum(b.stats), 'draft should add guard hours');
});

// §7.3 day/night shift counting (night = 00:00–06:00)
test('dutyFromRows_ counts day vs night shifts', () => {
  reset();
  const id = G.readTable('soldiers')[0].id;
  const rows = [
    { soldier_id: id, soldier_name: 'x', position: 'guard', start: '00:00', end: '03:00', block_date: '2026-07-13' },
    { soldier_id: id, soldier_name: 'x', position: 'guard', start: '03:00', end: '06:00', block_date: '2026-07-13' },
    { soldier_id: id, soldier_name: 'x', position: 'guard', start: '12:00', end: '15:00', block_date: '2026-07-13' },
  ];
  const d = G.dutyFromRows_(rows).find((m) => m.soldier_id === id);
  assert.strictEqual(d.night_shifts, 2);
  assert.strictEqual(d.day_shifts, 1);
});

// §5 rest day — no back-to-back guard days
test('generateWeek: no two consecutive guard-days per soldier', () => {
  reset();
  G.generateWeek(7, 'admin1234');
  const guard = G.readTable('schedule_draft').filter((r) => r.position === 'guard');
  const byS = {};
  guard.forEach((r) => { (byS[r.soldier_name] = byS[r.soldier_name] || new Set()).add(r.block_date); });
  Object.keys(byS).forEach((n) => {
    const dates = [...byS[n]].sort();
    for (let i = 1; i < dates.length; i++) {
      assert(G.advanceDate_(dates[i - 1], 1) !== dates[i], n + ' back-to-back ' + dates[i - 1] + '→' + dates[i]);
    }
  });
});

// §3.2 shift_date = real calendar date of the shift
test('shift_date resolves after-midnight shifts to block_date+1', () => {
  reset();
  G.readTable('schedule_published').concat(
    (function () { G.generateWeek(7, 'admin1234'); return G.readTable('schedule_draft'); })()
  ).forEach(function (r) {
    var expected = G.parseHourNum_(r.start) < 12 ? G.advanceDate_(r.block_date, 1) : r.block_date;
    assert.strictEqual(r.shift_date, expected, r.block_date + ' ' + r.start + ' → ' + r.shift_date);
  });
});

// §7.2 on-call swap: replace a whole guard/standby person across the block
test('swapGuardPerson replaces a guard across all their block shifts', () => {
  reset();
  const pub = G.readTable('schedule_published');
  const bd = pub.find((r) => r.position === 'guard').block_date;
  const oldId = pub.find((r) => r.block_date === bd && r.position === 'guard').soldier_id;
  const patrol = pub.find((r) => r.block_date === bd && r.position === 'patrol' && r.soldier_id !== oldId);
  G.swapGuardPerson(bd, oldId, patrol.soldier_id, 'admin1234');
  const after = G.readTable('schedule_published');
  assert(!after.some((r) => r.block_date === bd && r.position === 'guard' && r.soldier_id === oldId), 'old still on guard');
  assert(after.filter((r) => r.block_date === bd && r.position === 'guard' && r.soldier_id === patrol.soldier_id).length >= 2, 'new should take both shifts');
  assert.throws(() => G.swapGuardPerson(bd, oldId, patrol.soldier_id, 'wrong'));
});

// §8 cellStr_ conversions
test('cellStr_ passes strings, formats Date time/date/datetime', () => {
  assert.strictEqual(G.cellStr_('12:00'), '12:00');
  assert.strictEqual(G.cellStr_(new Date(Date.UTC(1899, 11, 30, 12, 0, 0))), '12:00');
  assert.strictEqual(G.cellStr_(new Date(Date.UTC(2026, 6, 12, 0, 0, 0))), '2026-07-12');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
