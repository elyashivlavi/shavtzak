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
var SOLDIER_HEADERS  = ['id', 'name', 'email', 'role', 'active', 'guard_eligible', 'phone', 'internal_note', 'start_date', 'end_date', 'skills'];
// כישורים ניתנים-לשיבוץ-כללים (רב-ערכי, פסיקים ב-skills). role נשאר יחיד; skills מצטבר.
var SKILL_OPTIONS = ['קלע', 'רחפן'];
/** מערך הכישורים של חייל (מפצל את שדה skills המופרד בפסיקים) */
function soldierSkills_(s) {
  return String((s && s.skills) || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean);
}
/** האם לחייל יש כישור מסוים (למשל 'קלע') */
function hasSkill_(s, skill) { return soldierSkills_(s).indexOf(skill) !== -1; }
/** מנרמל קלט כישורים (מערך או מחרוזת) למחרוזת פסיקים מתוך SKILL_OPTIONS בלבד, ללא כפילויות */
function normSkills_(input) {
  var arr = Array.isArray(input) ? input : String(input || '').split(',');
  var seen = {}, out = [];
  arr.map(function (x) { return String(x).trim(); }).forEach(function (x) {
    if (x && SKILL_OPTIONS.indexOf(x) !== -1 && !seen[x]) { seen[x] = 1; out.push(x); }
  });
  return out.join(',');
}
var SCHEDULE_HEADERS = ['block_date', 'shift_date', 'position', 'slot', 'start', 'end', 'day_label',
                        'soldier_id', 'soldier_name', 'standby', 'note'];
var STATS_HEADERS    = ['soldier_id', 'name', 'cumulative_guard_hours', 'guard_blocks', 'last_guard_block'];
var CONFIG_HEADERS   = ['key', 'value'];

// ברירות מחדל לקונפיגורציה
var DEFAULT_CONFIG = {
  anchor_hour:      '12',       // שעת עיגון הרוטציה (12:00 בצהריים) — גבול "היום/למחרת" ותחילת הבלוק
  shift_hours:      '3',        // אורך משמרת ברירת מחדל (אם shift_starts ריק)
  shift_starts:     '12:00,15:00,18:00,21:00,00:00,03:00,06:00,09:00', // שעות תחילת משמרות השמירה (עריכה בגיליון)
  guard_count:      '4',        // כמה חיילים על השמירה בכל בלוק
  patrol_morning:   '06:00',    // שעת פטרול בוקר
  patrol_evening:   '18:00',    // שעת פטרול ערב
  admin_emails:     'elyashivlavi@gmail.com',
  admin_password:   'admin1234'  // סיסמת מצב מנהל (אין התחברות גוגל) — שנה בטאב config
};

// ================================================================
//  נקודת כניסה (Web App) + זיהוי משתמש
// ================================================================

function doGet(e) {
  ensureReady_(); // התקנה אוטומטית בטעינה הראשונה המורשית (במקום הרצת setup ידנית)
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

/** אימות מצב מנהל לפי סיסמה (אין התחברות גוגל — הגישה ציבורית) */
function isAdminPassword_(pw) {
  var real = String(getConfig('admin_password') || '');
  return real !== '' && String(pw || '') === real;
}

function requireAdmin_(pw) {
  if (!isAdminPassword_(pw)) throw new Error('אין הרשאה — סיסמת מנהל שגויה.');
  return true;
}

/**
 * חלונות הנוכחות של החיילים (start_date/end_date כ-Date+שעה גולמי מהגיליון).
 * קורא גולמי (לא דרך readTable/cellStr_) כדי לשמור על ה-Date להשוואת epoch.
 */
function soldierWindows_() {
  var sheet = ss_().getSheetByName(SHEET_SOLDIERS);
  var values = sheet.getDataRange().getValues();
  var map = {};
  if (values.length < 2) return map;
  var h = values[0];
  var iId = h.indexOf('id'), iS = h.indexOf('start_date'), iE = h.indexOf('end_date');
  for (var r = 1; r < values.length; r++) {
    var id = values[r][iId];
    if (!id) continue;
    var sv = iS >= 0 ? values[r][iS] : '', ev = iE >= 0 ? values[r][iE] : '';
    map[id] = {
      start: Object.prototype.toString.call(sv) === '[object Date]' ? sv.getTime() : null,
      end:   Object.prototype.toString.call(ev) === '[object Date]' ? ev.getTime() : null
    };
  }
  return map;
}

/** האם החייל זמין (בבסיס) ברגע נתון (epoch ms). חלון ריק = תמיד זמין. */
function availableAt_(win, instant) {
  if (!win) return true;
  if (win.start != null && instant < win.start) return false;
  if (win.end != null && instant > win.end) return false;
  return true;
}

/** רגע תחילת הבלוק (שעת העיגון, בשעון הסקריפט = Asia/Jerusalem) כ-epoch ms. */
function blockStartInstant_(blockDate, anchorHour) {
  var p = String(blockDate).split('-');
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]), anchorHour, 0, 0).getTime();
}

// ================================================================
//  API לצד הלקוח
// ================================================================

/** כל מה שהממשק צריך בטעינה: המשתמש, קונפיג, החיילים, השיבוץ המפורסם, וטיוטה (למנהל) */
function getBootstrap(pw) {
  ensureReady_();
  var ctx = getUserContext();
  ctx.isAdmin = isAdminPassword_(pw);  // מצב מנהל לפי סיסמה בלבד (גישה ציבורית ללא התחברות)

  // ספריית חיילים ציבורית לבחירת "לוז אישי" ולכפתורי יצירת קשר — בלי מייל/הערה פנימית
  var roster = readTable(SHEET_SOLDIERS)
    .filter(function (s) { return s.active + '' !== 'FALSE' && s.active !== false; })
    .map(function (s) { return { id: s.id, name: s.name, role: s.role, phone: s.phone || '' }; });

  var cfg = getConfigAll();
  delete cfg.admin_password;  // אסור לחשוף סוד ללקוח
  delete cfg.admin_emails;
  var out = {
    user: ctx,
    config: cfg,
    published: buildScheduleView_(readTable(SHEET_PUBLISHED)),
    hasDraft: readTable(SHEET_DRAFT).length > 0,
    roster: roster
  };
  if (ctx.isAdmin) {
    var pub = readTable(SHEET_PUBLISHED);
    var draftRows = readTable(SHEET_DRAFT);
    var withDraft = pub.concat(draftRows);
    out.soldiers = readTable(SHEET_SOLDIERS);
    out.draft = buildScheduleView_(draftRows);
    out.stats = statsFromRows_(pub);
    out.statsDraft = statsFromRows_(withDraft);   // כולל טיוטה
    out.duty = dutyFromRows_(pub);
    out.dutyDraft = dutyFromRows_(withDraft);
  }
  return out;
}

/**
 * מייצר את הבלוק הבא (24 שעות) לטיוטה — לפי הוגנות. לא נחשף לחיילים עד לאישור.
 * forcePatrolIds — רשימת מזהי חיילים שחייבים להיות בפטרול בבלוק הזה (לא ייכנסו לעמדות).
 */
function generateNextRotation(forcePatrolIds, pw) {
  requireAdmin_(pw);
  var cfg = getConfigAll();
  var forced = {};
  (forcePatrolIds || []).forEach(function (id) { forced[id] = true; });

  var blockDate = nextBlockDate_();
  var block = buildBlockRows_(blockDate, statsMap_(), forced, soldierWindows_(), cfg);
  writeTable(SHEET_DRAFT, block.rows);
  return { ok: true, blockDate: blockDate, guards: block.guards.map(function (g) { return g.name; }) };
}

/**
 * מייצר שבצ"ק לשבוע שלם (ברירת מחדל 7 בלוקים) לטיוטה. מיישם את כללי ההוגנות:
 * (1) איזון עמדה/פטרול לאורך השבוע — מי שעשה הכי מעט ימי-עמדה השבוע קודם;
 * (2) הוגנות היסטורית — cumulative_guard_hours ואז last_guard_block;
 * (3) סבב לילות — מי שעשה הכי מעט לילות השבוע מקבל את עמדות-הלילה (00:00–06:00);
 * (4) נוכחות (חלונות start/end_date) והחרגות (guard_eligible/active).
 */
function generateWeek(days, pw) {
  requireAdmin_(pw);
  var cfg = getConfigAll();
  var n = parseInt(days, 10) || 7;
  var guardCount = parseInt(cfg.guard_count, 10);
  var anchorHour = parseInt(cfg.anchor_hour, 10);
  var starts = shiftStarts_(cfg);

  // אילו עמדות (positions) נושאות משמרת לילה (שעת תחילה 00:00–06:00)
  var nightPos = {};
  for (var p = 0; p < guardCount; p++) {
    for (var s = p; s < starts.length; s += guardCount) {
      var hnum = parseHourNum_(starts[s]);
      if (hnum >= 0 && hnum < 6) { nightPos[p] = true; break; }
    }
  }

  var stats = statsMap_(), windows = soldierWindows_();
  var weekGuardDays = {}, weekNight = {};   // מונים מצטברים לאורך השבוע (איזון + סבב לילות)
  var guardedPrev = {};                      // מי שמר בבלוק הקודם (כלל מנוחה: אין יומיים עמדה רצופים)
  var rows = [], summary = [], bd = nextBlockDate_();
  // מאתחלים לפי הבלוק המפורסם האחרון שלפני תחילת השבוע, כדי שהיום הראשון יכבד את כלל המנוחה
  var prevPublished = advanceDate_(bd, -1);
  readTable(SHEET_PUBLISHED).forEach(function (r) {
    if (r.block_date === prevPublished && r.position === 'guard') guardedPrev[r.soldier_id] = 1;
  });

  for (var i = 0; i < n; i++) {
    var instant = blockStartInstant_(bd, anchorHour);
    var present = readTable(SHEET_SOLDIERS).filter(function (s) {
      return truthy_(s.active) && availableAt_(windows[s.id], instant);
    });
    var pool = present.filter(function (s) { return truthy_(s.guard_eligible); });
    // איזון קודם (הכי מעט ימי-עמדה השבוע), ואז הוגנות היסטורית
    pool.sort(function (a, b) {
      var ga = weekGuardDays[a.id] || 0, gb = weekGuardDays[b.id] || 0;
      if (ga !== gb) return ga - gb;
      var ha = stats[a.id] ? Number(stats[a.id].cumulative_guard_hours) : 0;
      var hb = stats[b.id] ? Number(stats[b.id].cumulative_guard_hours) : 0;
      if (ha !== hb) return ha - hb;
      var la = stats[a.id] ? String(stats[a.id].last_guard_block) : '';
      var lb = stats[b.id] ? String(stats[b.id].last_guard_block) : '';
      if (la !== lb) return la < lb ? -1 : 1;
      return String(a.name).localeCompare(String(b.name));
    });
    // כלל מנוחה: אחרי יום עמדה חייב לפחות יום פטרול — מי ששמר בבלוק הקודם לא נכנס היום.
    // נופלים חזרה רק אם אין מספיק חיילים אחרים (כדי לא להיכשל).
    var rested = pool.filter(function (s) { return !guardedPrev[s.id]; });
    if (rested.length >= guardCount) pool = rested;
    if (pool.length < guardCount) {
      throw new Error('אין מספיק חיילים כשירים בתאריך ' + bd + ' (' + pool.length + '/' + guardCount + ').');
    }
    var chosen = pool.slice(0, guardCount);

    // סבב לילות: יעד ~25% לילות לכל שומר. ממיינים לפי יחס לילות-לימי-עמדה (הנמוך קודם),
    // כדי שהלילות יתחלקו יחסית למספר ימי-העמדה ולא רק במספר מוחלט.
    function nightRate_(id) { return (weekNight[id] || 0) / ((weekGuardDays[id] || 0) + 1); }
    var byNight = chosen.slice().sort(function (a, b) {
      return nightRate_(a.id) - nightRate_(b.id) ||
        (weekNight[a.id] || 0) - (weekNight[b.id] || 0) ||
        String(a.name).localeCompare(String(b.name));
    });
    var ordered = new Array(guardCount), nightList = [], dayList = [], idx = 0;
    for (var pp = 0; pp < guardCount; pp++) (nightPos[pp] ? nightList : dayList).push(pp);
    nightList.forEach(function (p) { ordered[p] = byNight[idx++]; });
    dayList.forEach(function (p) { ordered[p] = byNight[idx++]; });

    var guardIds = {};
    ordered.forEach(function (g) { guardIds[g.id] = true; });
    for (var slot = 0; slot < starts.length; slot++) {
      var g = ordered[slot % guardCount];
      var start = starts[slot], end = starts[(slot + 1) % starts.length];
      rows.push({
        block_date: bd, shift_date: shiftDate_(bd, start, anchorHour), position: 'guard', slot: String(slot),
        start: start, end: end, day_label: parseHourNum_(start) < anchorHour ? 'למחרת' : 'היום',
        soldier_id: g.id, soldier_name: g.name, standby: 'TRUE', note: ''
      });
    }
    var patrol = present.filter(function (s) { return !guardIds[s.id]; });
    ['morning', 'evening'].forEach(function (part) {
      var time = part === 'morning' ? cfg.patrol_morning : cfg.patrol_evening;
      patrol.forEach(function (s) {
        rows.push({
          block_date: bd, shift_date: shiftDate_(bd, time, anchorHour), position: 'patrol', slot: part, start: time, end: '',
          day_label: part === 'morning' ? 'בוקר' : 'ערב',
          soldier_id: s.id, soldier_name: s.name, standby: '', note: ''
        });
      });
    });

    guardedPrev = {};
    ordered.forEach(function (g) { weekGuardDays[g.id] = (weekGuardDays[g.id] || 0) + 1; guardedPrev[g.id] = 1; });
    nightList.forEach(function (p) { var g = ordered[p]; weekNight[g.id] = (weekNight[g.id] || 0) + 1; });
    advanceStats_(stats, ordered, bd, 24 / guardCount);
    summary.push({ date: bd, guards: ordered.map(function (g) { return g.name; }) });
    bd = advanceDate_(bd, 1);
  }
  writeTable(SHEET_DRAFT, rows);
  return { ok: true, days: n, summary: summary };
}

/**
 * בונה את שורות בלוק ה-24ש' (שמירה + פטרול) לתאריך נתון, לפי מפת הוגנות וחלונות נוכחות.
 * לא כותב לגיליון — מחזיר { rows, guards, hoursPerGuard }.
 */
function buildBlockRows_(blockDate, stats, forced, windows, cfg) {
  var anchorHour = parseInt(cfg.anchor_hour, 10);
  var guardCount = parseInt(cfg.guard_count, 10);
  var starts = shiftStarts_(cfg);
  var shiftsPerDay = starts.length;
  var instant = blockStartInstant_(blockDate, anchorHour);

  // רק חיילים פעילים שנמצאים בבסיס בזמן הבלוק (חלון נוכחות ריק = תמיד)
  var soldiers = readTable(SHEET_SOLDIERS).filter(function (s) {
    return truthy_(s.active) && availableAt_(windows[s.id], instant);
  });

  var guardPool = soldiers.filter(function (s) { return truthy_(s.guard_eligible) && !forced[s.id]; });
  guardPool.sort(function (a, b) {
    var ha = stats[a.id] ? Number(stats[a.id].cumulative_guard_hours) : 0;
    var hb = stats[b.id] ? Number(stats[b.id].cumulative_guard_hours) : 0;
    if (ha !== hb) return ha - hb;
    var la = stats[a.id] ? String(stats[a.id].last_guard_block) : '';
    var lb = stats[b.id] ? String(stats[b.id].last_guard_block) : '';
    if (la !== lb) return la < lb ? -1 : 1;
    return String(a.name).localeCompare(String(b.name));
  });
  if (guardPool.length < guardCount) {
    throw new Error('אין מספיק חיילים כשירים לשמירה בתאריך ' + blockDate +
      ' (' + guardPool.length + ' מתוך ' + guardCount + ' נדרשים).');
  }
  var guards = guardPool.slice(0, guardCount);
  var guardIds = {};
  guards.forEach(function (g) { guardIds[g.id] = true; });

  var rows = [];
  for (var slot = 0; slot < shiftsPerDay; slot++) {
    var guard = guards[slot % guardCount];
    var start = starts[slot];
    var end = starts[(slot + 1) % shiftsPerDay];
    rows.push({
      block_date: blockDate, shift_date: shiftDate_(blockDate, start, anchorHour), position: 'guard', slot: String(slot),
      start: start, end: end, day_label: parseHourNum_(start) < anchorHour ? 'למחרת' : 'היום',
      soldier_id: guard.id, soldier_name: guard.name, standby: 'TRUE', note: ''
    });
  }
  var patrol = soldiers.filter(function (s) { return !guardIds[s.id]; });
  ['morning', 'evening'].forEach(function (part) {
    var time = part === 'morning' ? cfg.patrol_morning : cfg.patrol_evening;
    patrol.forEach(function (s) {
      rows.push({
        block_date: blockDate, shift_date: shiftDate_(blockDate, time, anchorHour), position: 'patrol', slot: part, start: time, end: '',
        day_label: part === 'morning' ? 'בוקר' : 'ערב',
        soldier_id: s.id, soldier_name: s.name, standby: '', note: ''
      });
    });
  });
  return { rows: rows, guards: guards, hoursPerGuard: 24 / guardCount };
}

/** מעדכן מפת הוגנות רצה אחרי בלוק (לצורך ייצור שבועי מצטבר) — לא כותב לגיליון. */
function advanceStats_(stats, guards, blockDate, hoursPerGuard) {
  guards.forEach(function (g) {
    var s = stats[g.id] || { soldier_id: g.id, name: g.name, cumulative_guard_hours: 0, guard_blocks: 0, last_guard_block: '' };
    s.cumulative_guard_hours = Number(s.cumulative_guard_hours || 0) + hoursPerGuard;
    s.guard_blocks = Number(s.guard_blocks || 0) + 1;
    s.last_guard_block = blockDate;
    stats[g.id] = s;
  });
}

/** מקדם מחרוזת תאריך yyyy-MM-dd ב-n ימים. */
function advanceDate_(dateStr, n) {
  var d = parseDate_(dateStr);
  d.setDate(d.getDate() + n);
  return fmtDate_(d);
}

/** אישור ופרסום: מעתיק את הטיוטה ל"מפורסם" ומעדכן את צבירת השעות. רק אחרי זה החיילים רואים. */
function publishDraft(pw) {
  requireAdmin_(pw);
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
function discardDraft(pw) {
  requireAdmin_(pw);
  clearTable_(SHEET_DRAFT);
  return { ok: true };
}

/** עריכה ידנית של משבצת בטיוטה (מחליף חייל במשמרת). משפיע רק על הטיוטה — לא חשוף לחיילים. */
function editAssignment(blockDate, position, slot, newSoldierId, pw) {
  requireAdmin_(pw);
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
  var dc = findDoubleBooking_(draft.filter(function (r) { return r.block_date === blockDate; }), parseInt(getConfigAll().anchor_hour, 10));
  if (dc) throw new Error('התנגשות: ' + dc + ' משובץ פעמיים באותו זמן.');
  writeTable(SHEET_DRAFT, draft);
  return { ok: true };
}

/** מחליף חייל במשמרת שמירה בלוח המפורסם (שבצק), עם ולידציית אי-כפילות. משנה גם פטרול לשמירת עקביות. */
function editBoardAssignment(blockDate, slot, newSoldierId, pw) {
  requireAdmin_(pw);
  var cfg = getConfigAll();
  var anchorHour = parseInt(cfg.anchor_hour, 10);
  var pub = readTable(SHEET_PUBLISHED);
  var soldiers = soldiersMap_();
  var target = soldiers[newSoldierId];
  if (!target) throw new Error('חייל לא נמצא.');

  var found = false, oldId = null;
  pub.forEach(function (r) {
    if (r.block_date === blockDate && r.position === 'guard' && String(r.slot) === String(slot)) {
      oldId = r.soldier_id; r.soldier_id = newSoldierId; r.soldier_name = target.name; found = true;
    }
  });
  if (!found) throw new Error('המשמרת לא נמצאה.');

  // החייל הנכנס לא יכול להישאר בפטרול באותו בלוק
  pub = pub.filter(function (r) { return !(r.block_date === blockDate && r.position === 'patrol' && r.soldier_id === newSoldierId); });

  // החייל שיצא — אם אינו שומר יותר בבלוק ואינו בפטרול, הכנס אותו לפטרול (בוקר+ערב) לשמירת עקביות
  var oldStillGuard = pub.some(function (r) { return r.block_date === blockDate && r.position === 'guard' && r.soldier_id === oldId; });
  var oldInPatrol = pub.some(function (r) { return r.block_date === blockDate && r.position === 'patrol' && r.soldier_id === oldId; });
  if (oldId && oldId !== newSoldierId && !oldStillGuard && !oldInPatrol && soldiers[oldId] && truthy_(soldiers[oldId].active)) {
    ['morning', 'evening'].forEach(function (part) {
      var ptime = part === 'morning' ? cfg.patrol_morning : cfg.patrol_evening;
      pub.push({
        block_date: blockDate, shift_date: shiftDate_(blockDate, ptime, anchorHour), position: 'patrol', slot: part,
        start: ptime, end: '',
        day_label: part === 'morning' ? 'בוקר' : 'ערב',
        soldier_id: oldId, soldier_name: soldiers[oldId].name, standby: '', note: ''
      });
    });
  }

  var conflict = findDoubleBooking_(pub.filter(function (r) { return r.block_date === blockDate; }), anchorHour);
  if (conflict) throw new Error('התנגשות: ' + conflict + ' משובץ פעמיים באותו זמן.');

  pub.sort(scheduleSort_);
  writeTable(SHEET_PUBLISHED, pub);
  recomputeStats_();
  return { ok: true };
}

/**
 * מחליף חייל-כוננות שלם (על כל משמרות השמירה שלו בבלוק) בלוח המפורסם.
 * כוננות = השומרים, לכן החלפה זו מעדכנת את סט הכוננות. שומר על אי-כפילות ועקביות פטרול.
 */
function swapGuardPerson(blockDate, oldSoldierId, newSoldierId, pw) {
  requireAdmin_(pw);
  if (oldSoldierId === newSoldierId) return { ok: true };
  var cfg = getConfigAll(), anchorHour = parseInt(cfg.anchor_hour, 10);
  var pub = readTable(SHEET_PUBLISHED);
  var soldiers = soldiersMap_();
  var target = soldiers[newSoldierId];
  if (!target) throw new Error('חייל לא נמצא.');

  var found = false;
  pub.forEach(function (r) {
    if (r.block_date === blockDate && r.position === 'guard' && r.soldier_id === oldSoldierId) {
      r.soldier_id = newSoldierId; r.soldier_name = target.name; found = true;
    }
  });
  if (!found) throw new Error('החייל אינו בעמדות הבלוק.');

  pub = pub.filter(function (r) { return !(r.block_date === blockDate && r.position === 'patrol' && r.soldier_id === newSoldierId); });
  var oldGuard = pub.some(function (r) { return r.block_date === blockDate && r.position === 'guard' && r.soldier_id === oldSoldierId; });
  var oldPatrol = pub.some(function (r) { return r.block_date === blockDate && r.position === 'patrol' && r.soldier_id === oldSoldierId; });
  if (!oldGuard && !oldPatrol && soldiers[oldSoldierId] && truthy_(soldiers[oldSoldierId].active)) {
    ['morning', 'evening'].forEach(function (part) {
      var ptime = part === 'morning' ? cfg.patrol_morning : cfg.patrol_evening;
      pub.push({
        block_date: blockDate, shift_date: shiftDate_(blockDate, ptime, anchorHour), position: 'patrol', slot: part,
        start: ptime, end: '', day_label: part === 'morning' ? 'בוקר' : 'ערב',
        soldier_id: oldSoldierId, soldier_name: soldiers[oldSoldierId].name, standby: '', note: ''
      });
    });
  }
  var conflict = findDoubleBooking_(pub.filter(function (r) { return r.block_date === blockDate; }), anchorHour);
  if (conflict) throw new Error('התנגשות: ' + conflict + ' משובץ פעמיים באותו זמן.');
  pub.sort(scheduleSort_);
  writeTable(SHEET_PUBLISHED, pub);
  recomputeStats_();
  return { ok: true };
}

/** דקות מוחלטות מתחילת הבלוק (שעת העיגון). */
function toAbsMin_(hhmm, anchorHour) {
  var h = parseHourNum_(hhmm);
  var mm = (String(hhmm).match(/:(\d{2})/) || [])[1];
  return ((h - anchorHour + 24) % 24) * 60 + (mm ? parseInt(mm, 10) : 0);
}

/** מחזיר שם חייל שמשובץ פעמיים בחפיפת-זמן באותו בלוק, או null. פטרול = נקודת-זמן. */
function findDoubleBooking_(rows, anchorHour) {
  var byS = {};
  rows.forEach(function (r) {
    var a = toAbsMin_(r.start, anchorHour);
    var b = r.position === 'guard' ? a + shiftDurationHours_(r.start, r.end) * 60 : a + 1;
    (byS[r.soldier_id] = byS[r.soldier_id] || []).push({ a: a, b: b, name: r.soldier_name });
  });
  var offender = null;
  Object.keys(byS).forEach(function (id) {
    var iv = byS[id].sort(function (x, y) { return x.a - y.a; });
    for (var i = 1; i < iv.length; i++) if (iv[i].a < iv[i - 1].b) offender = iv[i].name;
  });
  return offender;
}

// ================================================================
//  ניהול חיילים
// ================================================================

function addSoldier(name, email, role, guardEligible, phone, skills, pw) {
  requireAdmin_(pw);
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
    phone: phone || '',
    internal_note: '',
    start_date: '',
    end_date: '',
    skills: normSkills_(skills)
  });
  writeTable(SHEET_SOLDIERS, soldiers);
  return { ok: true, id: id };
}

function updateSoldier(id, fields, pw) {
  requireAdmin_(pw);
  var soldiers = readTable(SHEET_SOLDIERS);
  var found = false;
  soldiers.forEach(function (s) {
    if (s.id === id) {
      ['name', 'email', 'role', 'active', 'guard_eligible', 'phone', 'internal_note', 'start_date', 'end_date', 'skills'].forEach(function (k) {
        if (fields[k] !== undefined) s[k] = k === 'skills' ? normSkills_(fields[k]) : fields[k];
      });
      found = true;
    }
  });
  if (!found) throw new Error('חייל לא נמצא.');
  writeTable(SHEET_SOLDIERS, soldiers);
  return { ok: true };
}

/** הורדת חייל = סימון כלא-פעיל (שומר היסטוריה וסטטיסטיקה) */
function removeSoldier(id, pw) {
  return updateSoldier(id, { active: 'FALSE' }, pw);
}

// ================================================================
//  סטטיסטיקה / הוגנות
// ================================================================

/** בונה מחדש את צבירת השעות מכל ההיסטוריה המפורסמת — אידמפוטנטי */
/** בונה מערך סטטיסטיקת הוגנות מתוך שורות שיבוץ נתונות (טהור — לא כותב). */
function statsFromRows_(rows) {
  var agg = {};
  readTable(SHEET_SOLDIERS).forEach(function (s) {
    agg[s.id] = { soldier_id: s.id, name: s.name, cumulative_guard_hours: 0, blocks: {}, last_guard_block: '' };
  });
  rows.forEach(function (r) {
    if (r.position !== 'guard') return;
    var a = agg[r.soldier_id] || (agg[r.soldier_id] = { soldier_id: r.soldier_id, name: r.soldier_name, cumulative_guard_hours: 0, blocks: {}, last_guard_block: '' });
    a.cumulative_guard_hours += shiftDurationHours_(r.start, r.end);
    a.blocks[r.block_date] = true;
    if (r.block_date > a.last_guard_block) a.last_guard_block = r.block_date;
  });
  return Object.keys(agg).map(function (id) {
    var a = agg[id];
    return { soldier_id: a.soldier_id, name: a.name, cumulative_guard_hours: a.cumulative_guard_hours, guard_blocks: Object.keys(a.blocks).length, last_guard_block: a.last_guard_block };
  });
}

function recomputeStats_() { writeTable(SHEET_STATS, statsFromRows_(readTable(SHEET_PUBLISHED))); }

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
      day_label: r.day_label, shift_date: r.shift_date, soldier_id: r.soldier_id, soldier_name: r.soldier_name,
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

/**
 * ממיר ערך תא לטקסט בטוח לסריאליזציה. Google Sheets מחזיר תאי תאריך/שעה כאובייקטי Date,
 * ו-google.script.run נכשל בסריאליזציה שלהם (מחזיר null ללקוח). מעצבים ב-GMT כדי לשחזר
 * את השעה/תאריך המקוריים (התא מאוחסן כ-UTC של שעון הקיר).
 */
function cellStr_(v) {
  if (Object.prototype.toString.call(v) === '[object Date]') {
    if (v.getUTCFullYear() < 1900) return Utilities.formatDate(v, 'GMT', 'HH:mm');       // שעה בלבד (משמרות)
    if (v.getUTCHours() === 0 && v.getUTCMinutes() === 0) return Utilities.formatDate(v, 'GMT', 'yyyy-MM-dd'); // תאריך בלבד
    return Utilities.formatDate(v, ss_().getSpreadsheetTimeZone() || 'Asia/Jerusalem', 'yyyy-MM-dd HH:mm');    // תאריך+שעה (חלון נוכחות)
  }
  return v;
}

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
    for (var j = 0; j < headers.length; j++) obj[headers[j]] = cellStr_(row[j]);
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
  var range = sheet.getRange(1, 1, out.length, headers.length);
  // שעות/תאריכי-שיבוץ נשמרים כטקסט — אחרת Sheets ממיר אותם ל-Date ומקלקל את השעה (באג אזור-זמן 1899).
  // גיליון soldiers נשאר רגיל כדי ש-start_date/end_date יהיו תאריכים אמיתיים (להשוואת חלון נוכחות).
  if (sheetName !== SHEET_SOLDIERS) range.setNumberFormat('@');
  range.setValues(out);
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

/** שעות תחילת משמרות השמירה מהגיליון (config.shift_starts). נפילה חזרה: נגזר מ-anchor+shift_hours. */
function shiftStarts_(cfg) {
  var raw = String(cfg.shift_starts || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  if (raw.length) return raw;
  var anchor = parseInt(cfg.anchor_hour, 10), sh = parseInt(cfg.shift_hours, 10), n = Math.round(24 / sh);
  var out = [];
  for (var i = 0; i < n; i++) out.push(hh_(anchor + i * sh));
  return out;
}

function parseHourNum_(t) { var m = String(t).match(/^(\d{1,2})/); return m ? parseInt(m[1], 10) : 0; }

/** התאריך היומני האמיתי של משמרת: שעת התחלה לפני שעת העיגון → יום למחרת. */
function shiftDate_(blockDate, start, anchorHour) {
  return parseHourNum_(start) < anchorHour ? advanceDate_(blockDate, 1) : blockDate;
}

/** משך משמרת בשעות מתוך "HH:MM"–"HH:MM" (עוטף חצות). */
function shiftDurationHours_(start, end) {
  var d = parseHourNum_(end) - parseHourNum_(start);
  if (d <= 0) d += 24;
  return d;
}

/**
 * פירוק עומסים לכל חייל מההיסטוריה המפורסמת: שעות עמדה/כוננות (שמירה) מול פטרול.
 * עמדה = סכום שעות משמרות השמירה; כוננות = מספר ימי-שמירה × 24 (בכוננות לכל הבלוק);
 * פטרול = מספר שיבוצי פטרול.
 */
function dutyBreakdown_() { return dutyFromRows_(readTable(SHEET_PUBLISHED)); }

/** פירוק עומסים מתוך שורות שיבוץ נתונות (טהור). */
function dutyFromRows_(pub) {
  var map = {};
  readTable(SHEET_SOLDIERS).forEach(function (s) {
    map[s.id] = { soldier_id: s.id, name: s.name, guard_hours: 0, guard_days: {}, patrol_count: 0, day_shifts: 0, night_shifts: 0 };
  });
  pub.forEach(function (r) {
    var m = map[r.soldier_id];
    if (!m) return;
    if (r.position === 'guard') {
      m.guard_hours += shiftDurationHours_(r.start, r.end);
      m.guard_days[r.block_date] = 1;
      if (isNightShift_(r.start)) m.night_shifts++; else m.day_shifts++;   // לילה = תחילת משמרת 00:00–06:00
    } else m.patrol_count++;
  });
  return Object.keys(map).map(function (k) {
    var m = map[k];
    return {
      soldier_id: m.soldier_id, name: m.name,
      guard_hours: m.guard_hours,
      standby_hours: Object.keys(m.guard_days).length * 24,
      patrol_count: m.patrol_count,
      day_shifts: m.day_shifts, night_shifts: m.night_shifts
    };
  }).filter(function (m) { return m.guard_hours || m.patrol_count; });
}

/** משמרת לילה = שעת תחילה בטווח 00:00–06:00. */
function isNightShift_(start) { var h = parseHourNum_(start); return h >= 0 && h < 6; }

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
  ['שמואל אטלי',     '',                          'officer',  false, 'קצין מוצב — תמיד בפטרול, לא בעמדות'],
  ['יהודה ונדרמן',   '',                          'soldier',  true,  ''],
  ['עופר קאסה',      '',                          'soldier',  true,  ''],
  ['אביאל גיאת',     '',                          'soldier',  true,  ''],
  ['אורי אברג\'יל',  '',                          'soldier',  true,  ''],
  ['מתן כהן',        '',                          'soldier',  true,  ''],
  ['בנג\'י פירר',    '',                          'soldier',  true,  ''],
  ['אסי פרץ',        '',                          'sergeant', false, 'סמל — תמיד בפטרול, אף פעם לא בעמדות']
];

// חיילים שחייבים בפטרול בבלוק ההתחלתי (היום) — לא ייכנסו לעמדות בבלוק הראשון.
var SEED_FORCE_PATROL = ['גלעד דביר', 'אביאל גיאת'];

// שומרי הבלוק ההתחלתי (כוננות/סבב קרוב), לפי סדר המשמרות מ-12:00. אם ריק — נופל לברירת מחדל.
var SEED_FIRST_GUARDS = ['עופר קאסה', 'יהודה ונדרמן', 'בנג\'י פירר', 'אלישיב לביא'];

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

  flashMsg_('ההתקנה הושלמה. פרוס את האפליקציה: Deploy → New deployment → Web app.');
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
      phone: s[5] || '',
      internal_note: s[4],
      start_date: '',
      end_date: ''
    };
  });
  writeTable(SHEET_SOLDIERS, rows);
}

/** בלוק ראשון: עופר קאסה שומר מ-12:00, ואז שלושה כשירים נוספים; השאר בפטרול */
function seedFirstBlock_() {
  if (readTable(SHEET_PUBLISHED).length) return; // כבר יש היסטוריה

  var cfg = getConfigAll();
  var anchorHour = parseInt(cfg.anchor_hour, 10);
  var guardCount = parseInt(cfg.guard_count, 10);
  var starts = shiftStarts_(cfg);
  var shiftsPerDay = starts.length;

  var soldiers = readTable(SHEET_SOLDIERS).filter(function (s) { return truthy_(s.active); });
  var byName = {};
  soldiers.forEach(function (s) { byName[s.name] = s; });

  var guards;
  if (SEED_FIRST_GUARDS && SEED_FIRST_GUARDS.length) {
    // רשימת שומרים מפורשת לבלוק ההתחלתי, לפי הסדר הנתון (מ-12:00 והלאה)
    guards = SEED_FIRST_GUARDS.map(function (n) { return byName[n]; })
      .filter(Boolean).slice(0, guardCount);
  } else {
    // ברירת מחדל: כשירים לעמדות (למעט מוחרגי-פטרול), עופר קאסה מ-12:00, ואז אלפביתי
    var pool = soldiers.filter(function (s) {
      return truthy_(s.guard_eligible) && SEED_FORCE_PATROL.indexOf(s.name) === -1;
    });
    pool.sort(function (a, b) {
      if (a.name === 'עופר קאסה') return -1;
      if (b.name === 'עופר קאסה') return 1;
      return String(a.name).localeCompare(String(b.name));
    });
    guards = pool.slice(0, guardCount);
  }
  var guardIds = {};
  guards.forEach(function (g) { guardIds[g.id] = true; });

  var blockDate = fmtDate_(new Date());
  var rows = [];

  for (var slot = 0; slot < shiftsPerDay; slot++) {
    var guard = guards[slot % guardCount];
    var start = starts[slot];
    var end = starts[(slot + 1) % shiftsPerDay];
    rows.push({
      block_date: blockDate, shift_date: shiftDate_(blockDate, start, anchorHour), position: 'guard', slot: String(slot),
      start: start, end: end, day_label: parseHourNum_(start) < anchorHour ? 'למחרת' : 'היום',
      soldier_id: guard.id, soldier_name: guard.name, standby: 'TRUE', note: ''
    });
  }

  var patrol = soldiers.filter(function (s) { return !guardIds[s.id]; });
  ['morning', 'evening'].forEach(function (part) {
    var time = part === 'morning' ? cfg.patrol_morning : cfg.patrol_evening;
    patrol.forEach(function (s) {
      rows.push({
        block_date: blockDate, shift_date: shiftDate_(blockDate, time, anchorHour), position: 'patrol', slot: part,
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
  if (!ss_().getSheetByName(SHEET_SOLDIERS)) { setup(); return; }
  migrateColumns_(SHEET_SOLDIERS);  // מוסיף עמודות חדשות (phone/start_date/end_date) לגיליון קיים
}

/** מוודא שכותרות הגיליון כוללות את כל העמודות המוגדרות בקוד; אם לא — משכתב פעם אחת (ערכים חסרים = ריק). */
function migrateColumns_(sheetName) {
  var sheet = ss_().getSheetByName(sheetName);
  if (!sheet) return;
  var want = headersFor_(sheetName);
  var have = sheet.getRange(1, 1, 1, want.length).getValues()[0];
  if (have.join('') !== want.join('')) writeTable(sheetName, readTable(sheetName));
}

function flashMsg_(msg) {
  try { SpreadsheetApp.getActiveSpreadsheet().toast(msg, 'שבצ"ק', 8); } catch (e) {}
}
