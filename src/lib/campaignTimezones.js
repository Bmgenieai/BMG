/**
 * Audience timezones for cold-email campaigns.
 * Send window is Mon–Fri 09:00–14:00 in the selected zone
 * (same US-morning window previously expressed as 7pm–midnight PKT).
 */

export const DEFAULT_CAMPAIGN_TIMEZONE = 'America/New_York';

/** Local Mon–Fri send window in the campaign timezone. */
export const CAMPAIGN_SEND_START_HOUR = 9;
export const CAMPAIGN_SEND_END_HOUR = 14;

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

const ALLOWED = new Set(CAMPAIGN_TIMEZONES.map((t) => t.value));

export function normalizeCampaignTimezone(raw) {
  const tz = String(raw || '').trim();
  if (ALLOWED.has(tz)) return tz;
  return DEFAULT_CAMPAIGN_TIMEZONE;
}

export function campaignTimezoneMeta(raw) {
  const value = normalizeCampaignTimezone(raw);
  return CAMPAIGN_TIMEZONES.find((t) => t.value === value) || CAMPAIGN_TIMEZONES[0];
}

/** True if Instant is inside Mon–Fri send window for this IANA zone. */
export function isCampaignSendWindowNow(date = new Date(), timeZone = DEFAULT_CAMPAIGN_TIMEZONE) {
  const tz = normalizeCampaignTimezone(timeZone);
  // Lazy import cycle avoided: inline weekday/hour via Intl
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'short',
      hour: '2-digit',
      hour12: false,
    })
      .formatToParts(date)
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, p.value]),
  );
  const weekday = parts.weekday;
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  const hour = Number(parts.hour === '24' ? '0' : parts.hour);
  return hour >= CAMPAIGN_SEND_START_HOUR && hour < CAMPAIGN_SEND_END_HOUR;
}
