/**
 * התקנה חד-פעמית.
 * להריץ פעם אחת מתוך עורך Apps Script: בוחרים את הפונקציה setup ולוחצים "הפעל".
 * הפעולה יוצרת את כל הטאבים, מזינה את רשימת החיילים ואת הקונפיגורציה,
 * ומכינה בלוק שיבוץ ראשון (עם עופר קאסה שומר מ-12:00).
 *
 * הרצה חוזרת בטוחה — לא מוחקת נתונים קיימים אלא רק משלימה מה שחסר.
 */

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
