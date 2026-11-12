/**
 * Campaign send timing: business-day delays (skip Sat/Sun) + audience-local send window.
 * Default window: Mon–Fri 09:00–14:00 in the campaign timezone
 * (legacy PKT 19:00–24:00 ≈ US Eastern morning).
 */
import { WORKING_TZ, ymdInTz, zonedStartOfDay, toSqliteUtc } from './periodBounds.js';
import {
  CAMPAIGN_SEND_END_HOUR,
  CAMPAIGN_SEND_START_HOUR,
  DEFAULT_CAMPAIGN_TIMEZONE,
  normalizeCampaignTimezone,
} from './campaignTimezones.js';

/** @deprecated Prefer CAMPAIGN_SEND_* — kept for older imports */
const PEAK_START_HOUR = CAMPAIGN_SEND_START_HOUR;
const PEAK_END_HOUR = CAMPAIGN_SEND_END_HOUR;

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
 * delayDays=0 → same day (still snapped later for weekend/window).
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
 * Snap an instant into the next valid send window on a weekday (09:00–14:00 local).
 * If already inside Mon–Fri 09:00–13:59 in that zone, keep it.
 */
export function snapToSendWindow(date, timeZone = DEFAULT_CAMPAIGN_TIMEZONE) {
  const tz = normalizeCampaignTimezone(timeZone);
  let p = partsInTz(date, tz);
  let ymd = p.ymd;

  // Weekend → next Monday window start
  if (isWeekendYmd(ymd, tz)) {
    ymd = nextWeekdayYmd(ymd, tz);
    return zonedDateTime(ymd, CAMPAIGN_SEND_START_HOUR, 0, 0, tz);
  }

  // Before window → same day at start
  if (p.hour < CAMPAIGN_SEND_START_HOUR) {
    return zonedDateTime(ymd, CAMPAIGN_SEND_START_HOUR, 0, 0, tz);
  }

  // Inside window → keep
  if (p.hour < CAMPAIGN_SEND_END_HOUR) {
    return date;
  }

  // After window → next weekday at start
  ymd = nextWeekdayYmd(addCalendarDays(ymd, 1), tz);
  return zonedDateTime(ymd, CAMPAIGN_SEND_START_HOUR, 0, 0, tz);
}

/**
 * Resolve when a campaign step should send.
 * @param {Date|string} baseInstant - launch (or enrollment) time
 * @param {number} delayBusinessDays - step.delay_days (business days)
 * @param {string} [timeZone] - audience IANA timezone
 */
export function resolveCampaignSendAt(
  baseInstant,
  delayBusinessDays,
  timeZone = DEFAULT_CAMPAIGN_TIMEZONE,
) {
  const tz = normalizeCampaignTimezone(timeZone);
  const base = baseInstant instanceof Date ? baseInstant : new Date(baseInstant);
  const safeBase = Number.isNaN(base.getTime()) ? new Date() : base;
  const launchYmd = ymdInTz(safeBase, tz);
  const targetYmd = addBusinessDays(launchYmd, delayBusinessDays, tz);

  // delay 0: prefer launch clock if already in weekday window; else snap
  if ((Number(delayBusinessDays) || 0) === 0) {
    return snapToSendWindow(safeBase, tz);
  }

  // Follow-ups: target business day at window start in audience TZ
  const atStart = zonedDateTime(targetYmd, CAMPAIGN_SEND_START_HOUR, 0, 0, tz);
  return snapToSendWindow(atStart, tz);
}

export function toScheduleSql(date) {
  return toSqliteUtc(date);
}

export {
  WORKING_TZ,
  PEAK_START_HOUR,
  PEAK_END_HOUR,
  ymdInTz,
  DEFAULT_CAMPAIGN_TIMEZONE,
  CAMPAIGN_SEND_START_HOUR,
  CAMPAIGN_SEND_END_HOUR,
  normalizeCampaignTimezone,
};
