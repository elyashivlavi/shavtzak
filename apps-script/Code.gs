/**
 * שבצ"ק מוצב — לוגיקת שרת (Google Apps Script)
 * ------------------------------------------------
 * מזהה את המשתמש דרך חשבון הגוגל שלו, אוכף הרשאות (מנהל מול חייל),
 * מייצר שיבוץ הוגן, ומנהל מנגנון טיוטה -> אישור -> פרסום.
 *
 * שכבת הנתונים: הגיליון עצמו (5 טאבים). אין מסד נתונים חיצוני.
 */

// ===== שמות הטאבים =====
var SHEET_SOLDIERS  = 'soldiers';
var SHEET_DRAFT     = 'schedule_draft';
var SHEET_PUBLISHED = 'schedule_published';
var SHEET_STATS     = 'stats';
var SHEET_CONFIG    = 'config';

// ===== כותרות =====
var SOLDIER_HEADERS  = ['id', 'name', 'email', 'role', 'active', 'guard_eligible', 'internal_note'];
var SCHEDULE_HEADERS = ['block_date', 'position', 'slot', 'start', 'end', 'day_label',
                        'soldier_id', 'soldier_name', 'standby', 'note'];
var STATS_HEADERS    = ['soldier_id', 'name', 'cumulative_guard_hours', 'guard_blocks', 'last_guard_block'];
var CONFIG_HEADERS   = ['key', 'value'];

// ברירות מחדל לקונפיגורציה
var DEFAULT_CONFIG = {
  anchor_hour:      '12',       // שעת עיגון הרוטציה (12:00 בצהריים)
  shift_hours:      '3',        // אורך משמרת שמירה
  guard_count:      '4',        // כמה חיילים על השמירה בכל בלוק
  patrol_morning:   '06:00',    // שעת פטרול בוקר
  patrol_evening:   '18:00',    // שעת פטרול ערב
  admin_emails:     'elyashivlavi@gmail.com'
};

// ================================================================
//  נקודת כניסה (Web App) + זיהוי משתמש
// ================================================================

function doGet(e) {
  var t = HtmlService.createTemplateFromFile('Index');
  return t.evaluate()
    .setTitle('שבצ"ק מוצב')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** מאפשר לפצל את ה-HTML לקבצים ולהכליל (include) אותם */
function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/** מחזיר את הקשר המשתמש הנוכחי לפי המייל המחובר */
function getUserContext() {
  var email = (Session.getActiveUser().getEmail() || '').toLowerCase();
  var soldiers = readTable(SHEET_SOLDIERS);
  var me = null;
  for (var i = 0; i < soldiers.length; i++) {
    if (String(soldiers[i].email || '').toLowerCase() === email && email) { me = soldiers[i]; break; }
  }
  var adminEmails = getConfig('admin_emails').split(',').map(function (s) { return s.trim().toLowerCase(); });
  var isAdmin = (me && me.role === 'admin') || adminEmails.indexOf(email) !== -1;

  return {
    email: email,
    isKnown: !!me,
    isAdmin: isAdmin,
    soldierId: me ? me.id : '',
    name: me ? me.name : '',
    role: me ? me.role : 'guest'
  };
}

function requireAdmin_() {
  var ctx = getUserContext();
  if (!ctx.isAdmin) throw new Error('אין הרשאה — פעולה זו מיועדת למנהל בלבד.');
  return ctx;
}

// ================================================================
//  API לצד הלקוח
// ================================================================

/** כל מה שהממשק צריך בטעינה: המשתמש, קונפיג, החיילים, השיבוץ המפורסם, וטיוטה (למנהל) */
function getBootstrap() {
  ensureReady_();
  var ctx = getUserContext();
  var out = {
    user: ctx,
    config: getConfigAll(),
    published: buildScheduleView_(readTable(SHEET_PUBLISHED)),
    hasDraft: readTable(SHEET_DRAFT).length > 0
  };
  if (ctx.isAdmin) {
    out.soldiers = readTable(SHEET_SOLDIERS);
    out.draft = buildScheduleView_(readTable(SHEET_DRAFT));
    out.stats = readTable(SHEET_STATS);
  } else {
    // חייל רגיל: רק השיבוץ האישי שלו + הרשימה הכללית המפורסמת (בלי מידע פנימי)
    out.mySchedule = ctx.isKnown ? filterMySchedule_(out.published, ctx.soldierId) : [];
  }
  return out;
}

/** מייצר את הבלוק הבא (24 שעות) לטיוטה — לפי הוגנות. לא נחשף לחיילים עד לאישור. */
function generateNextRotation() {
  requireAdmin_();
  var cfg = getConfigAll();
  var anchorHour = parseInt(cfg.anchor_hour, 10);
  var shiftHours = parseInt(cfg.shift_hours, 10);
  var guardCount = parseInt(cfg.guard_count, 10);
  var shiftsPerDay = Math.round(24 / shiftHours);

  var blockDate = nextBlockDate_();

  var soldiers = readTable(SHEET_SOLDIERS).filter(function (s) {
    return truthy_(s.active);
  });
  var stats = statsMap_();

  // מועמדים לשמירה: פעילים + כשירים לעמדות (אסי הסמל מסומן false ולכן לא ייכנס)
  var guardPool = soldiers.filter(function (s) { return truthy_(s.guard_eligible); });

  guardPool.sort(function (a, b) {
    var ha = stats[a.id] ? Number(stats[a.id].cumulative_guard_hours) : 0;
    var hb = stats[b.id] ? Number(stats[b.id].cumulative_guard_hours) : 0;
    if (ha !== hb) return ha - hb;                       // הכי מעט שעות שמירה קודם
    var la = stats[a.id] ? String(stats[a.id].last_guard_block) : '';
    var lb = stats[b.id] ? String(stats[b.id].last_guard_block) : '';
    if (la !== lb) return la < lb ? -1 : 1;              // מי ששמר הכי מזמן קודם
    return String(a.name).localeCompare(String(b.name));
  });

  if (guardPool.length < guardCount) {
    throw new Error('אין מספיק חיילים כשירים לשמירה (' + guardPool.length + ' מתוך ' + guardCount + ' נדרשים).');
  }
  var guards = guardPool.slice(0, guardCount);
  var guardIds = {};
  guards.forEach(function (g) { guardIds[g.id] = true; });

  var rows = [];

  // --- משמרות שמירה: כל אחד עושה 2 משמרות של 3 שעות, עם 9 שעות מנוחה ביניהן ---
  for (var slot = 0; slot < shiftsPerDay; slot++) {
    var guard = guards[slot % guardCount];
    var startH = anchorHour + slot * shiftHours;
    var endH = startH + shiftHours;
    rows.push({
      block_date: blockDate,
      position: 'guard',
      slot: String(slot),
      start: hh_(startH),
      end: hh_(endH),
      day_label: dayLabel_(startH),
      soldier_id: guard.id,
      soldier_name: guard.name,
      standby: 'TRUE',           // בשמירה => בכוננות לכל אורך ה-24 שעות
      note: ''
    });
  }

  // --- פטרול: כל שאר החיילים הפעילים (בוקר + ערב) ---
  var patrol = soldiers.filter(function (s) { return !guardIds[s.id]; });
  ['morning', 'evening'].forEach(function (part) {
    var time = part === 'morning' ? cfg.patrol_morning : cfg.patrol_evening;
    patrol.forEach(function (s) {
      rows.push({
        block_date: blockDate,
        position: 'patrol',
        slot: part,
        start: time,
        end: '',
        day_label: part === 'morning' ? 'בוקר' : 'ערב',
        soldier_id: s.id,
        soldier_name: s.name,
        standby: '',
        note: ''
      });
    });
  });

  writeTable(SHEET_DRAFT, rows);
  return { ok: true, blockDate: blockDate, guards: guards.map(function (g) { return g.name; }) };
}

/** אישור ופרסום: מעתיק את הטיוטה ל"מפורסם" ומעדכן את צבירת השעות. רק אחרי זה החיילים רואים. */
function publishDraft() {
  requireAdmin_();
  var draft = readTable(SHEET_DRAFT);
  if (!draft.length) throw new Error('אין טיוטה לפרסום. צור שיבוץ קודם.');

  // מוסיפים את בלוקי הטיוטה למפורסם (מחליפים בלוק קיים עם אותו תאריך אם יש)
  var published = readTable(SHEET_PUBLISHED);
  var draftDates = {};
  draft.forEach(function (r) { draftDates[r.block_date] = true; });
  published = published.filter(function (r) { return !draftDates[r.block_date]; });
  published = published.concat(draft);
  published.sort(scheduleSort_);

  writeTable(SHEET_PUBLISHED, published);
  clearTable_(SHEET_DRAFT);
  recomputeStats_();
  return { ok: true };
}

/** מבטל את הטיוטה בלי לפרסם */
function discardDraft() {
  requireAdmin_();
  clearTable_(SHEET_DRAFT);
  return { ok: true };
}

/** עריכה ידנית של משבצת בטיוטה (מחליף חייל במשמרת). משפיע רק על הטיוטה — לא חשוף לחיילים. */
function editAssignment(blockDate, position, slot, newSoldierId) {
  requireAdmin_();
  var draft = readTable(SHEET_DRAFT);
  if (!draft.length) throw new Error('אין טיוטה פעילה לעריכה.');
  var soldiers = soldiersMap_();
  var target = soldiers[newSoldierId];
  if (!target) throw new Error('חייל לא נמצא.');

  var found = false;
  draft.forEach(function (r) {
    if (r.block_date === blockDate && r.position === position && String(r.slot) === String(slot)) {
      r.soldier_id = target.id;
      r.soldier_name = target.name;
      found = true;
    }
  });
  if (!found) throw new Error('המשבצת לא נמצאה.');
  writeTable(SHEET_DRAFT, draft);
  return { ok: true };
}

// ================================================================
//  ניהול חיילים
// ================================================================

function addSoldier(name, email, role, guardEligible) {
  requireAdmin_();
  if (!name) throw new Error('חובה שם.');
  var soldiers = readTable(SHEET_SOLDIERS);
  var id = 's' + (soldiers.length + 1) + '_' + Date.now().toString(36);
  soldiers.push({
    id: id,
    name: name,
    email: email || '',
    role: role || 'soldier',
    active: 'TRUE',
    guard_eligible: guardEligible === false ? 'FALSE' : 'TRUE',
    internal_note: ''
  });
  writeTable(SHEET_SOLDIERS, soldiers);
  return { ok: true, id: id };
}

function updateSoldier(id, fields) {
  requireAdmin_();
  var soldiers = readTable(SHEET_SOLDIERS);
  var found = false;
  soldiers.forEach(function (s) {
    if (s.id === id) {
      ['name', 'email', 'role', 'active', 'guard_eligible', 'internal_note'].forEach(function (k) {
        if (fields[k] !== undefined) s[k] = fields[k];
      });
      found = true;
    }
  });
  if (!found) throw new Error('חייל לא נמצא.');
  writeTable(SHEET_SOLDIERS, soldiers);
  return { ok: true };
}

/** הורדת חייל = סימון כלא-פעיל (שומר היסטוריה וסטטיסטיקה) */
function removeSoldier(id) {
  return updateSoldier(id, { active: 'FALSE' });
}

// ================================================================
//  סטטיסטיקה / הוגנות
// ================================================================

/** בונה מחדש את צבירת השעות מכל ההיסטוריה המפורסמת — אידמפוטנטי */
function recomputeStats_() {
  var cfg = getConfigAll();
  var shiftHours = parseInt(cfg.shift_hours, 10);
  var published = readTable(SHEET_PUBLISHED);
  var soldiers = readTable(SHEET_SOLDIERS);

  var agg = {};
  soldiers.forEach(function (s) {
    agg[s.id] = { soldier_id: s.id, name: s.name, cumulative_guard_hours: 0, blocks: {}, last_guard_block: '' };
  });

  published.forEach(function (r) {
    if (r.position !== 'guard') return;
    var a = agg[r.soldier_id];
    if (!a) { a = agg[r.soldier_id] = { soldier_id: r.soldier_id, name: r.soldier_name, cumulative_guard_hours: 0, blocks: {}, last_guard_block: '' }; }
    a.cumulative_guard_hours += shiftHours;
    a.blocks[r.block_date] = true;
    if (r.block_date > a.last_guard_block) a.last_guard_block = r.block_date;
  });

  var rows = Object.keys(agg).map(function (id) {
    var a = agg[id];
    return {
      soldier_id: a.soldier_id,
      name: a.name,
      cumulative_guard_hours: a.cumulative_guard_hours,
      guard_blocks: Object.keys(a.blocks).length,
      last_guard_block: a.last_guard_block
    };
  });
  writeTable(SHEET_STATS, rows);
}

function statsMap_() {
  var m = {};
  readTable(SHEET_STATS).forEach(function (r) { m[r.soldier_id] = r; });
  return m;
}

// ================================================================
//  בניית תצוגה לממשק
// ================================================================

/** ממיר שורות גולמיות למבנה מקובץ לפי בלוק (יום) לתצוגה נוחה */
function buildScheduleView_(rows) {
  rows = rows.slice().sort(scheduleSort_);
  var blocks = {};
  var order = [];
  rows.forEach(function (r) {
    if (!blocks[r.block_date]) { blocks[r.block_date] = { block_date: r.block_date, guard: [], patrol: [] }; order.push(r.block_date); }
    var item = {
      position: r.position, slot: r.slot, start: r.start, end: r.end,
      day_label: r.day_label, soldier_id: r.soldier_id, soldier_name: r.soldier_name,
      standby: truthy_(r.standby), note: r.note
    };
    if (r.position === 'guard') blocks[r.block_date].guard.push(item);
    else blocks[r.block_date].patrol.push(item);
  });
  return order.map(function (d) { return blocks[d]; });
}

function filterMySchedule_(view, soldierId) {
  var out = [];
  view.forEach(function (block) {
    var mine = { block_date: block.block_date, items: [] };
    block.guard.concat(block.patrol).forEach(function (it) {
      if (it.soldier_id === soldierId) mine.items.push(it);
    });
    if (mine.items.length) out.push(mine);
  });
  return out;
}

// ================================================================
//  עזרי גיליון / קונפיג / תאריך
// ================================================================

function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }

function readTable(sheetName) {
  var sheet = ss_().getSheetByName(sheetName);
  if (!sheet) return [];
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  var headers = values[0];
  var out = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    if (row.join('') === '') continue;
    var obj = {};
    for (var j = 0; j < headers.length; j++) obj[headers[j]] = row[j];
    out.push(obj);
  }
  return out;
}

function writeTable(sheetName, rows) {
  var sheet = ss_().getSheetByName(sheetName);
  var headers = headersFor_(sheetName);
  sheet.clearContents();
  var out = [headers];
  rows.forEach(function (r) {
    out.push(headers.map(function (h) { return r[h] !== undefined ? r[h] : ''; }));
  });
  sheet.getRange(1, 1, out.length, headers.length).setValues(out);
}

function clearTable_(sheetName) {
  var sheet = ss_().getSheetByName(sheetName);
  var headers = headersFor_(sheetName);
  sheet.clearContents();
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
}

function headersFor_(name) {
  if (name === SHEET_SOLDIERS) return SOLDIER_HEADERS;
  if (name === SHEET_STATS) return STATS_HEADERS;
  if (name === SHEET_CONFIG) return CONFIG_HEADERS;
  return SCHEDULE_HEADERS; // draft + published
}

function soldiersMap_() {
  var m = {};
  readTable(SHEET_SOLDIERS).forEach(function (s) { m[s.id] = s; });
  return m;
}

function getConfigAll() {
  var m = {};
  Object.keys(DEFAULT_CONFIG).forEach(function (k) { m[k] = DEFAULT_CONFIG[k]; });
  readTable(SHEET_CONFIG).forEach(function (r) { if (r.key) m[r.key] = String(r.value); });
  return m;
}

function getConfig(key) { return getConfigAll()[key]; }

function truthy_(v) {
  if (v === true) return true;
  var s = String(v).toLowerCase().trim();
  return s === 'true' || s === 'כן' || s === '1' || s === 'yes';
}

/** תאריך הבלוק הבא ("yyyy-MM-dd") — יום אחרי הבלוק המפורסם האחרון, או היום אם אין */
function nextBlockDate_() {
  var published = readTable(SHEET_PUBLISHED);
  var last = '';
  published.forEach(function (r) { if (r.block_date > last) last = r.block_date; });
  var base;
  if (last) {
    base = parseDate_(last);
    base.setDate(base.getDate() + 1);
  } else {
    base = new Date();
  }
  return fmtDate_(base);
}

function parseDate_(ymd) {
  var p = String(ymd).split('-');
  return new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10));
}

function fmtDate_(d) {
  return Utilities.formatDate(d, ss_().getSpreadsheetTimeZone() || 'Asia/Jerusalem', 'yyyy-MM-dd');
}

/** שעה בפורמט HH:mm מתוך מספר שעות (מטפל בגלישה מעבר לחצות) */
function hh_(hour) {
  var h = ((hour % 24) + 24) % 24;
  return (h < 10 ? '0' + h : h) + ':00';
}

/** תווית יום — האם המשמרת ביום הבלוק או למחרת */
function dayLabel_(startHour) {
  return startHour >= 24 ? 'למחרת' : 'היום';
}

function scheduleSort_(a, b) {
  if (a.block_date !== b.block_date) return a.block_date < b.block_date ? -1 : 1;
  if (a.position !== b.position) return a.position === 'guard' ? -1 : 1;
  return String(a.slot).localeCompare(String(b.slot), undefined, { numeric: true });
}

// ================================================================
//  התקנה חד-פעמית — הרץ את setup פעם אחת מהעורך
//  יוצר את כל הטאבים, מזין את רשימת החיילים ואת הקונפיגורציה,
//  ומכין בלוק שיבוץ ראשון. הרצה חוזרת בטוחה (לא דורסת נתונים קיימים).
// ================================================================

// רשימת החיילים ההתחלתית. שדה email ריק => החייל עדיין לא יכול להתחבר לצפייה אישית.
var SEED_SOLDIERS = [
  // שם              מייל                        תפקיד      כשיר לעמדות  הערה פנימית (לא מוצג בממשק)
  ['אלישיב לביא',    'elyashivlavi@gmail.com',   'admin',    true,  ''],
  ['נתנאל חזקיה',    '',                          'soldier',  true,  ''],
  ['ארי פריי',       '',                          'soldier',  true,  ''],
  ['גלעד דביר',      '',                          'soldier',  true,  ''],
  ['שמואל אטלי',     '',                          'officer',  true,  'קצין מוצב'],
  ['יהודה ונדרמן',   '',                          'soldier',  true,  ''],
  ['עופר קאסה',      '',                          'soldier',  true,  ''],
  ['אביאל גיאת',     '',                          'soldier',  true,  ''],
  ['אורי אברג\'יל',  '',                          'soldier',  true,  ''],
  ['מתן כהן',        '',                          'soldier',  true,  ''],
  ['בנג\'י פירר',    '',                          'soldier',  true,  ''],
  ['אסי פרץ',        '',                          'sergeant', false, 'סמל — תמיד בפטרול, אף פעם לא בעמדות']
];

function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  ensureSheet_(ss, SHEET_SOLDIERS,  SOLDIER_HEADERS);
  ensureSheet_(ss, SHEET_DRAFT,     SCHEDULE_HEADERS);
  ensureSheet_(ss, SHEET_PUBLISHED, SCHEDULE_HEADERS);
  ensureSheet_(ss, SHEET_STATS,     STATS_HEADERS);
  ensureSheet_(ss, SHEET_CONFIG,    CONFIG_HEADERS);

  // מוחקים גיליון ברירת מחדל ריק ("Sheet1"/"גיליון1") אם קיים
  ['Sheet1', 'גיליון1'].forEach(function (n) {
    var s = ss.getSheetByName(n);
    if (s && ss.getSheets().length > 1) ss.deleteSheet(s);
  });

  seedConfig_();
  seedSoldiers_();
  seedFirstBlock_();

  SpreadsheetApp.getUi && flashMsg_('ההתקנה הושלמה. פרוס את האפליקציה: Deploy → New deployment → Web app.');
}

function ensureSheet_(ss, name, headers) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  var first = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  if (first.join('') === '') {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function seedConfig_() {
  var existing = readTable(SHEET_CONFIG);
  if (existing.length) return; // כבר מוגדר — לא דורסים
  var rows = Object.keys(DEFAULT_CONFIG).map(function (k) { return { key: k, value: DEFAULT_CONFIG[k] }; });
  writeTable(SHEET_CONFIG, rows);
}

function seedSoldiers_() {
  var existing = readTable(SHEET_SOLDIERS);
  if (existing.length) return; // כבר קיימת רשימה — לא דורסים
  var rows = SEED_SOLDIERS.map(function (s, i) {
    return {
      id: 's' + (i + 1),
      name: s[0],
      email: s[1],
      role: s[2],
      active: 'TRUE',
      guard_eligible: s[3] ? 'TRUE' : 'FALSE',
      internal_note: s[4]
    };
  });
  writeTable(SHEET_SOLDIERS, rows);
}

/** בלוק ראשון: עופר קאסה שומר מ-12:00, ואז שלושה כשירים נוספים; השאר בפטרול */
function seedFirstBlock_() {
  if (readTable(SHEET_PUBLISHED).length) return; // כבר יש היסטוריה

  var cfg = getConfigAll();
  var anchorHour = parseInt(cfg.anchor_hour, 10);
  var shiftHours = parseInt(cfg.shift_hours, 10);
  var guardCount = parseInt(cfg.guard_count, 10);
  var shiftsPerDay = Math.round(24 / shiftHours);

  var soldiers = readTable(SHEET_SOLDIERS).filter(function (s) { return truthy_(s.active); });
  var pool = soldiers.filter(function (s) { return truthy_(s.guard_eligible); });

  // מסדרים כך שעופר קאסה ראשון (שומר מ-12:00)
  pool.sort(function (a, b) {
    if (a.name === 'עופר קאסה') return -1;
    if (b.name === 'עופר קאסה') return 1;
    return String(a.name).localeCompare(String(b.name));
  });
  var guards = pool.slice(0, guardCount);
  var guardIds = {};
  guards.forEach(function (g) { guardIds[g.id] = true; });

  var blockDate = fmtDate_(new Date());
  var rows = [];

  for (var slot = 0; slot < shiftsPerDay; slot++) {
    var guard = guards[slot % guardCount];
    var startH = anchorHour + slot * shiftHours;
    rows.push({
      block_date: blockDate, position: 'guard', slot: String(slot),
      start: hh_(startH), end: hh_(startH + shiftHours), day_label: dayLabel_(startH),
      soldier_id: guard.id, soldier_name: guard.name, standby: 'TRUE', note: ''
    });
  }

  var patrol = soldiers.filter(function (s) { return !guardIds[s.id]; });
  ['morning', 'evening'].forEach(function (part) {
    var time = part === 'morning' ? cfg.patrol_morning : cfg.patrol_evening;
    patrol.forEach(function (s) {
      rows.push({
        block_date: blockDate, position: 'patrol', slot: part,
        start: time, end: '', day_label: part === 'morning' ? 'בוקר' : 'ערב',
        soldier_id: s.id, soldier_name: s.name, standby: '', note: ''
      });
    });
  });

  writeTable(SHEET_PUBLISHED, rows);
  recomputeStats_();
}

/** מוודא שהמערכת מותקנת לפני שהממשק עולה */
function ensureReady_() {
  if (!ss_().getSheetByName(SHEET_SOLDIERS)) setup();
}

function flashMsg_(msg) {
  try { SpreadsheetApp.getActiveSpreadsheet().toast(msg, 'שבצ"ק', 8); } catch (e) {}
}
