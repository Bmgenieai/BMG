/**
 * Audience timezones for cold-email campaigns.
 * Send window: Mon–Fri 09:00–17:00 in the selected zone (business hours).
 * Preferred send hour (send_hour) is when Email 1 + follow-ups are scheduled.
 */

export const DEFAULT_CAMPAIGN_TIMEZONE = 'America/New_York';
export const DEFAULT_CAMPAIGN_SEND_HOUR = 9;

/** Local Mon–Fri send window in the campaign timezone (9am–5pm). */
export const CAMPAIGN_SEND_START_HOUR = 9;
export const CAMPAIGN_SEND_END_HOUR = 17; // exclusive → through 4:59 PM; preferred hour max 16

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

/** Preferred schedule hours inside the business window (9 AM – 4 PM). */
export const CAMPAIGN_SEND_HOURS = [9, 10, 11, 12, 13, 14, 15, 16];

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
  if (hour < CAMPAIGN_SEND_START_HOUR) return CAMPAIGN_SEND_START_HOUR;
  if (hour >= CAMPAIGN_SEND_END_HOUR) return CAMPAIGN_SEND_END_HOUR - 1;
  return hour;
}

export function campaignTimezoneMeta(raw) {
  const value = normalizeCampaignTimezone(raw);
  return CAMPAIGN_TIMEZONES.find((t) => t.value === value) || CAMPAIGN_TIMEZONES[0];
}

/** True if Instant is inside Mon–Fri 9am–5pm for this IANA zone. */
export function isCampaignSendWindowNow(date = new Date(), timeZone = DEFAULT_CAMPAIGN_TIMEZONE) {
  const tz = normalizeCampaignTimezone(timeZone);
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
