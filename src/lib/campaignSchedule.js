/**
 * Campaign send timing: business-day delays (skip Sat/Sun) + US peak window in PKT.
 * Peak window: 19:00–23:59 Asia/Karachi (targets US daytime / agreed CRM window).
 */
import { WORKING_TZ, ymdInTz, zonedStartOfDay, toSqliteUtc } from './periodBounds.js';

const PEAK_START_HOUR = 19; // 7 PM PKT
const PEAK_END_HOUR = 24; // midnight (exclusive end)

function pad(n) {
  return String(n).padStart(2, '0');
}

function addCalendarDays(ymd, days) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

/** Weekday in office TZ for a calendar YMD (0=Sun … 6=Sat). */
export function weekdayInTz(ymd, timeZone = WORKING_TZ) {
  const probe = zonedStartOfDay(ymd, timeZone);
  const name = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(probe);
  const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[name] ?? 0;
}

export function isWeekendYmd(ymd, timeZone = WORKING_TZ) {
  const w = weekdayInTz(ymd, timeZone);
  return w === 0 || w === 6;
}

/** Next Mon–Fri on or after ymd. */
export function nextWeekdayYmd(ymd, timeZone = WORKING_TZ) {
  let cur = ymd;
  for (let i = 0; i < 14; i += 1) {
    if (!isWeekendYmd(cur, timeZone)) return cur;
    cur = addCalendarDays(cur, 1);
  }
  return cur;
}

/**
 * Add N business days (Mon–Fri only) after fromYmd.
 * delayDays=0 → same day (still snapped later for weekend/peak).
 * delayDays=3 from Wed → Mon (Thu, Fri, Mon).
 */
export function addBusinessDays(fromYmd, delayDays, timeZone = WORKING_TZ) {
  const n = Math.max(0, Number(delayDays) || 0);
  let cur = String(fromYmd).slice(0, 10);
  if (n === 0) return nextWeekdayYmd(cur, timeZone);

  let left = n;
  // Start counting from the next calendar day after launch day
  cur = addCalendarDays(cur, 1);
  while (left > 0) {
    if (!isWeekendYmd(cur, timeZone)) left -= 1;
    if (left === 0) break;
    cur = addCalendarDays(cur, 1);
  }
  return cur;
}

/** Instant for ymd at hour:minute:second in timeZone. */
export function zonedDateTime(ymd, hour, minute = 0, second = 0, timeZone = WORKING_TZ) {
  const start = zonedStartOfDay(ymd, timeZone);
  return new Date(start.getTime() + ((hour * 60 + minute) * 60 + second) * 1000);
}

/** Parts of a Date in office TZ. */
export function partsInTz(date, timeZone = WORKING_TZ) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      weekday: 'short',
    })
      .formatToParts(date)
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, p.value]),
  );
  const hour = Number(parts.hour === '24' ? '0' : parts.hour);
  return {
    ymd: `${parts.year}-${parts.month}-${parts.day}`,
    hour,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: parts.weekday,
  };
}

/**
 * Snap an instant into the next valid peak window on a weekday (7pm–midnight PKT).
 * If already inside Mon–Fri 19:00–23:59 PKT, keep it.
 */
export function snapToSendWindow(date, timeZone = WORKING_TZ) {
  let p = partsInTz(date, timeZone);
  let ymd = p.ymd;

  // Weekend → next Monday 19:00
  if (isWeekendYmd(ymd, timeZone)) {
    ymd = nextWeekdayYmd(ymd, timeZone);
    return zonedDateTime(ymd, PEAK_START_HOUR, 0, 0, timeZone);
  }

  // Before 7pm → same day 7pm
  if (p.hour < PEAK_START_HOUR) {
    return zonedDateTime(ymd, PEAK_START_HOUR, 0, 0, timeZone);
  }

  // Inside peak (19–23) → keep
  if (p.hour < PEAK_END_HOUR) {
    return date;
  }

  // At/after midnight boundary (hour 0–… already handled as before peak next day)
  // hour >= 24 shouldn't happen; if somehow past end, next weekday 19:00
  ymd = nextWeekdayYmd(addCalendarDays(ymd, 1), timeZone);
  return zonedDateTime(ymd, PEAK_START_HOUR, 0, 0, timeZone);
}

/**
 * Resolve when a campaign step should send.
 * @param {Date|string} baseInstant - launch (or enrollment) time
 * @param {number} delayBusinessDays - step.delay_days (business days)
 */
export function resolveCampaignSendAt(baseInstant, delayBusinessDays) {
  const base = baseInstant instanceof Date ? baseInstant : new Date(baseInstant);
  const safeBase = Number.isNaN(base.getTime()) ? new Date() : base;
  const launchYmd = ymdInTz(safeBase, WORKING_TZ);
  const targetYmd = addBusinessDays(launchYmd, delayBusinessDays, WORKING_TZ);

  // delay 0: prefer launch clock if already in peak weekday window; else snap
  if ((Number(delayBusinessDays) || 0) === 0) {
    const sameDayPeak = snapToSendWindow(safeBase, WORKING_TZ);
    // If snap moved to another day because launch was after midnight window, OK
    return sameDayPeak;
  }

  // Follow-ups: target business day at peak start (7pm PKT)
  const atPeak = zonedDateTime(targetYmd, PEAK_START_HOUR, 0, 0, WORKING_TZ);
  return snapToSendWindow(atPeak, WORKING_TZ);
}

export function toScheduleSql(date) {
  return toSqliteUtc(date);
}

export { WORKING_TZ, PEAK_START_HOUR, PEAK_END_HOUR, ymdInTz };
