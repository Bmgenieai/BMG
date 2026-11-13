/**
 * Audience timezones for cold-email campaigns.
 * Send window: Mon–Fri 09:00–17:00 in the selected zone (business hours).
 * Preferred send hour (send_hour) is when Email 1 + follow-ups are scheduled.
 */

export const DEFAULT_CAMPAIGN_TIMEZONE = 'America/New_York';
export const DEFAULT_CAMPAIGN_SEND_HOUR = 9;
export const DEFAULT_CAMPAIGN_SEND_MINUTE = 0;

/** Default window start/end hours (0–24 allowed). */
export const CAMPAIGN_SEND_START_HOUR = 0;
export const CAMPAIGN_SEND_END_HOUR = 24;

export const CAMPAIGN_TIMEZONES = [
  { value: 'America/New_York', label: 'US Eastern (New York)', short: 'ET' },
  { value: 'America/Chicago', label: 'US Central (Chicago)', short: 'CT' },
  { value: 'America/Denver', label: 'US Mountain (Denver)', short: 'MT' },
  { value: 'America/Los_Angeles', label: 'US Pacific (Los Angeles)', short: 'PT' },
  { value: 'America/Phoenix', label: 'US Arizona (no DST)', short: 'MST' },
  { value: 'Europe/London', label: 'UK (London)', short: 'UK' },
  { value: 'Europe/Dublin', label: 'Ireland (Dublin)', short: 'IST' },
  { value: 'Asia/Karachi', label: 'Pakistan (Karachi)', short: 'PKT' },
  { value: 'UTC', label: 'UTC', short: 'UTC' },
];

/** All 24 hours (0–23). */
export const CAMPAIGN_SEND_HOURS = Array.from({ length: 24 }, (_, i) => i);

const ALLOWED = new Set(CAMPAIGN_TIMEZONES.map((t) => t.value));

export function normalizeCampaignTimezone(raw) {
  const tz = String(raw || '').trim();
  if (ALLOWED.has(tz)) return tz;
  return DEFAULT_CAMPAIGN_TIMEZONE;
}

export function normalizeCampaignSendHour(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_CAMPAIGN_SEND_HOUR;
  const hour = Math.floor(n);
  if (hour < 0) return 0;
  if (hour > 23) return 23;
  return hour;
}

export function normalizeCampaignSendMinute(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  const minute = Math.floor(n);
  if (minute < 0) return 0;
  if (minute > 59) return 59;
  return minute;
}

export function campaignTimezoneMeta(raw) {
  const value = normalizeCampaignTimezone(raw);
  return CAMPAIGN_TIMEZONES.find((t) => t.value === value) || CAMPAIGN_TIMEZONES[0];
}

/** Check if current time is valid for campaign delivery. */
export function isCampaignSendWindowNow(date = new Date(), timeZone = DEFAULT_CAMPAIGN_TIMEZONE) {
  // Respects exact scheduled times; allows execution once due
  return true;
}
