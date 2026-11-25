/**
 * Campaign send timing: business-day delays (skip Sat/Sun) + audience-local window.
 * Window: Mon–Fri 09:00–17:00 local. Preferred hour (default 9) sets Email 1 + follow-ups.
 */
import { WORKING_TZ, ymdInTz, zonedStartOfDay, toSqliteUtc } from './periodBounds.js';
import {
  CAMPAIGN_SEND_END_HOUR,
  CAMPAIGN_SEND_START_HOUR,
  DEFAULT_CAMPAIGN_SEND_HOUR,
  DEFAULT_CAMPAIGN_SEND_MINUTE,
  DEFAULT_CAMPAIGN_TIMEZONE,
  normalizeCampaignSendHour,
  normalizeCampaignSendMinute,
  normalizeCampaignTimezone,
  normalizeSendWindow,
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
 */
export function addBusinessDays(fromYmd, delayDays, timeZone = WORKING_TZ) {
  const n = Math.max(0, Number(delayDays) || 0);
  let cur = String(fromYmd).slice(0, 10);
  if (n === 0) return nextWeekdayYmd(cur, timeZone);

  let left = n;
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

/** Parts of a Date in a TZ. */
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
 * Snap into next valid Mon–Fri business-hours send window [startHour, endHour) local.
 * - Weekend → next Monday at clamped preferred time
 * - Before preferred time (or before startHour) today → same day at clamped preferred time
 * - At/after endHour today → next business day at clamped preferred time
 * - Inside [preferred, endHour) today → send at `date` (within business hours)
 */
export function snapToSendWindow(
  date,
  timeZone = DEFAULT_CAMPAIGN_TIMEZONE,
  preferredHour = DEFAULT_CAMPAIGN_SEND_HOUR,
  preferredMinute = DEFAULT_CAMPAIGN_SEND_MINUTE,
  startHour = CAMPAIGN_SEND_START_HOUR,
  endHour = CAMPAIGN_SEND_END_HOUR,
) {
  const tz = normalizeCampaignTimezone(timeZone);
  const { startHour: sH, endHour: eH } = normalizeSendWindow(startHour, endHour);
  const prefH = normalizeCampaignSendHour(preferredHour, sH, eH - 1);
  const prefM = normalizeCampaignSendMinute(preferredMinute);
  const p = partsInTz(date, tz);
  let ymd = p.ymd;

  if (isWeekendYmd(ymd, tz)) {
    ymd = nextWeekdayYmd(ymd, tz);
    return zonedDateTime(ymd, prefH, prefM, 0, tz);
  }

  const curMinutes = p.hour * 60 + p.minute;
  const startMinutes = sH * 60;
  const endMinutes = eH * 60;
  const prefMinutes = Math.max(startMinutes, Math.min(endMinutes - 1, prefH * 60 + prefM));

  // Past end of business hours today → next business day at preferred time
  if (curMinutes >= endMinutes) {
    const nextDay = addBusinessDays(ymd, 1, tz);
    return zonedDateTime(nextDay, Math.floor(prefMinutes / 60), prefMinutes % 60, 0, tz);
  }

  // Before preferred time today → same day at preferred time
  if (curMinutes < prefMinutes) {
    return zonedDateTime(ymd, Math.floor(prefMinutes / 60), prefMinutes % 60, 0, tz);
  }

  // Inside business hours and at/after preferred time → keep instant
  return date;
}

/**
 * Resolve when a campaign step should send, strictly within Mon–Fri business hours.
 * @param {Date|string} baseInstant
 * @param {number} delayBusinessDays
 * @param {string} [timeZone]
 * @param {number} [preferredHour] - local hour
 * @param {number} [preferredMinute] - local minute 0–59
 * @param {{ startHour?: number, endHour?: number, staggerSeconds?: number }} [opts]
 */
export function resolveCampaignSendAt(
  baseInstant,
  delayBusinessDays,
  timeZone = DEFAULT_CAMPAIGN_TIMEZONE,
  preferredHour = DEFAULT_CAMPAIGN_SEND_HOUR,
  preferredMinute = DEFAULT_CAMPAIGN_SEND_MINUTE,
  opts = {},
) {
  const tz = normalizeCampaignTimezone(timeZone);
  const { startHour: sH, endHour: eH } = normalizeSendWindow(
    opts.startHour ?? CAMPAIGN_SEND_START_HOUR,
    opts.endHour ?? CAMPAIGN_SEND_END_HOUR,
  );
  const prefH = normalizeCampaignSendHour(preferredHour, sH, eH - 1);
  const prefM = normalizeCampaignSendMinute(preferredMinute);
  const staggerSec = Math.max(0, Number(opts.staggerSeconds) || 0);

  const base = baseInstant instanceof Date ? baseInstant : new Date(baseInstant);
  const safeBase = Number.isNaN(base.getTime()) ? new Date() : base;
  const launchYmd = ymdInTz(safeBase, tz);
  const targetYmd = addBusinessDays(launchYmd, delayBusinessDays, tz);

  let resolved;
  if ((Number(delayBusinessDays) || 0) === 0) {
    resolved = snapToSendWindow(safeBase, tz, prefH, prefM, sH, eH);
  } else {
    resolved = zonedDateTime(targetYmd, prefH, prefM, 0, tz);
  }

  if (staggerSec > 0) {
    const shifted = new Date(resolved.getTime() + staggerSec * 1000);
    // If stagger pushed past business hours, wrap into next business day
    resolved = snapToSendWindow(shifted, tz, sH, 0, sH, eH);
  }
  return resolved;
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
  DEFAULT_CAMPAIGN_SEND_HOUR,
  CAMPAIGN_SEND_START_HOUR,
  CAMPAIGN_SEND_END_HOUR,
  normalizeCampaignTimezone,
  normalizeCampaignSendHour,
};
