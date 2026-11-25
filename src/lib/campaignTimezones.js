/**
 * Audience & prospect timezones for cold-email campaigns.
 * Send window: Mon–Fri business hours (default 09:00–17:00) in the prospect's local timezone
 * (or the campaign's audience timezone when prospect location is unknown).
 */

export const DEFAULT_CAMPAIGN_TIMEZONE = 'America/New_York';
export const DEFAULT_CAMPAIGN_SEND_HOUR = 9;
export const DEFAULT_CAMPAIGN_SEND_MINUTE = 0;

/** Default business-hours window (Mon–Fri, 09:00–17:00 local). */
export const CAMPAIGN_SEND_START_HOUR = 9;
export const CAMPAIGN_SEND_END_HOUR = 17;

export const CAMPAIGN_TIMEZONES = [
  { value: 'America/New_York', label: 'US Eastern (New York)', short: 'ET' },
  { value: 'America/Chicago', label: 'US Central (Chicago)', short: 'CT' },
  { value: 'America/Denver', label: 'US Mountain (Denver)', short: 'MT' },
  { value: 'America/Los_Angeles', label: 'US Pacific (Los Angeles)', short: 'PT' },
  { value: 'America/Phoenix', label: 'US Arizona (no DST)', short: 'MST' },
  { value: 'America/Anchorage', label: 'US Alaska (Anchorage)', short: 'AKT' },
  { value: 'Pacific/Honolulu', label: 'US Hawaii (Honolulu)', short: 'HST' },
  { value: 'Europe/London', label: 'UK (London)', short: 'UK' },
  { value: 'Europe/Dublin', label: 'Ireland (Dublin)', short: 'IST' },
  { value: 'Europe/Berlin', label: 'Central Europe (Berlin/Paris)', short: 'CET' },
  { value: 'Asia/Dubai', label: 'UAE (Dubai)', short: 'GST' },
  { value: 'Asia/Karachi', label: 'Pakistan (Karachi)', short: 'PKT' },
  { value: 'Australia/Sydney', label: 'Australia (Sydney)', short: 'AEST' },
  { value: 'UTC', label: 'UTC', short: 'UTC' },
];

/** Business hours (0–23 supported for display, clamped to window on send). */
export const CAMPAIGN_SEND_HOURS = Array.from({ length: 24 }, (_, i) => i);

const ALLOWED = new Set(CAMPAIGN_TIMEZONES.map((t) => t.value));

export function normalizeCampaignTimezone(raw) {
  const tz = String(raw || '').trim();
  if (ALLOWED.has(tz)) return tz;
  // Validate any other IANA timezone safely
  if (tz) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
      return tz;
    } catch {
      /* fallback */
    }
  }
  return DEFAULT_CAMPAIGN_TIMEZONE;
}

export function normalizeCampaignSendHour(raw, minHour = 0, maxHour = 23) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return Math.min(maxHour, Math.max(minHour, DEFAULT_CAMPAIGN_SEND_HOUR));
  const hour = Math.floor(n);
  if (hour < minHour) return minHour;
  if (hour > maxHour) return maxHour;
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

export function normalizeSendWindow(startRaw, endRaw) {
  let start = Number(startRaw);
  let end = Number(endRaw);
  if (!Number.isFinite(start)) start = CAMPAIGN_SEND_START_HOUR;
  if (!Number.isFinite(end)) end = CAMPAIGN_SEND_END_HOUR;
  start = Math.max(0, Math.min(22, Math.floor(start)));
  end = Math.max(start + 1, Math.min(24, Math.floor(end)));
  return { startHour: start, endHour: end };
}

export function campaignTimezoneMeta(raw) {
  const value = normalizeCampaignTimezone(raw);
  return (
    CAMPAIGN_TIMEZONES.find((t) => t.value === value) || {
      value,
      label: value,
      short: value.split('/').pop() || value,
    }
  );
}

/** Check if `date` falls within Mon–Fri business hours [startHour, endHour) in `timeZone`. */
export function isCampaignSendWindowNow(
  date = new Date(),
  timeZone = DEFAULT_CAMPAIGN_TIMEZONE,
  startHour = CAMPAIGN_SEND_START_HOUR,
  endHour = CAMPAIGN_SEND_END_HOUR,
) {
  const tz = normalizeCampaignTimezone(timeZone);
  const { startHour: sH, endHour: eH } = normalizeSendWindow(startHour, endHour);
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
  if (parts.weekday === 'Sat' || parts.weekday === 'Sun') return false;
  const hour = Number(parts.hour === '24' ? '0' : parts.hour);
  return hour >= sH && hour < eH;
}

const US_STATE_TZ = {
  // Eastern
  ct: 'America/New_York', connecticut: 'America/New_York',
  de: 'America/New_York', delaware: 'America/New_York',
  dc: 'America/New_York', 'district of columbia': 'America/New_York',
  fl: 'America/New_York', florida: 'America/New_York',
  ga: 'America/New_York', georgia: 'America/New_York',
  in: 'America/New_York', indiana: 'America/New_York',
  ky: 'America/New_York', kentucky: 'America/New_York',
  me: 'America/New_York', maine: 'America/New_York',
  md: 'America/New_York', maryland: 'America/New_York',
  ma: 'America/New_York', massachusetts: 'America/New_York',
  mi: 'America/New_York', michigan: 'America/New_York',
  nh: 'America/New_York', 'new hampshire': 'America/New_York',
  nj: 'America/New_York', 'new jersey': 'America/New_York',
  ny: 'America/New_York', 'new york': 'America/New_York',
  nc: 'America/New_York', 'north carolina': 'America/New_York',
  oh: 'America/New_York', ohio: 'America/New_York',
  pa: 'America/New_York', pennsylvania: 'America/New_York',
  ri: 'America/New_York', 'rhode island': 'America/New_York',
  sc: 'America/New_York', 'south carolina': 'America/New_York',
  vt: 'America/New_York', vermont: 'America/New_York',
  va: 'America/New_York', virginia: 'America/New_York',
  wv: 'America/New_York', 'west virginia': 'America/New_York',
  // Central
  al: 'America/Chicago', alabama: 'America/Chicago',
  ar: 'America/Chicago', arkansas: 'America/Chicago',
  il: 'America/Chicago', illinois: 'America/Chicago',
  ia: 'America/Chicago', iowa: 'America/Chicago',
  ks: 'America/Chicago', kansas: 'America/Chicago',
  la: 'America/Chicago', louisiana: 'America/Chicago',
  mn: 'America/Chicago', minnesota: 'America/Chicago',
  ms: 'America/Chicago', mississippi: 'America/Chicago',
  mo: 'America/Chicago', missouri: 'America/Chicago',
  ne: 'America/Chicago', nebraska: 'America/Chicago',
  nd: 'America/Chicago', 'north dakota': 'America/Chicago',
  ok: 'America/Chicago', oklahoma: 'America/Chicago',
  sd: 'America/Chicago', 'south dakota': 'America/Chicago',
  tn: 'America/Chicago', tennessee: 'America/Chicago',
  tx: 'America/Chicago', texas: 'America/Chicago',
  wi: 'America/Chicago', wisconsin: 'America/Chicago',
  // Mountain
  co: 'America/Denver', colorado: 'America/Denver',
  id: 'America/Denver', idaho: 'America/Denver',
  mt: 'America/Denver', montana: 'America/Denver',
  nm: 'America/Denver', 'new mexico': 'America/Denver',
  ut: 'America/Denver', utah: 'America/Denver',
  wy: 'America/Denver', wyoming: 'America/Denver',
  // Arizona
  az: 'America/Phoenix', arizona: 'America/Phoenix',
  // Pacific
  ca: 'America/Los_Angeles', california: 'America/Los_Angeles',
  nv: 'America/Los_Angeles', nevada: 'America/Los_Angeles',
  or: 'America/Los_Angeles', oregon: 'America/Los_Angeles',
  wa: 'America/Los_Angeles', washington: 'America/Los_Angeles',
  // Alaska & Hawaii
  ak: 'America/Anchorage', alaska: 'America/Anchorage',
  hi: 'Pacific/Honolulu', hawaii: 'Pacific/Honolulu',
};

const COUNTRY_TZ = {
  uk: 'Europe/London',
  gb: 'Europe/London',
  'united kingdom': 'Europe/London',
  england: 'Europe/London',
  scotland: 'Europe/London',
  wales: 'Europe/London',
  ireland: 'Europe/Dublin',
  ie: 'Europe/Dublin',
  germany: 'Europe/Berlin',
  de: 'Europe/Berlin',
  france: 'Europe/Berlin',
  fr: 'Europe/Berlin',
  spain: 'Europe/Berlin',
  es: 'Europe/Berlin',
  italy: 'Europe/Berlin',
  it: 'Europe/Berlin',
  netherlands: 'Europe/Berlin',
  nl: 'Europe/Berlin',
  uae: 'Asia/Dubai',
  'united arab emirates': 'Asia/Dubai',
  dubai: 'Asia/Dubai',
  pakistan: 'Asia/Karachi',
  pk: 'Asia/Karachi',
  australia: 'Australia/Sydney',
  au: 'Australia/Sydney',
  canada: 'America/New_York',
  ca: 'America/New_York',
};

/**
 * Infer a prospect's local IANA timezone from lead.state / lead.country.
 * Falls back to `fallbackTimezone` (the campaign's audience timezone).
 */
export function resolveProspectTimezone(lead, fallbackTimezone = DEFAULT_CAMPAIGN_TIMEZONE) {
  const fallback = normalizeCampaignTimezone(fallbackTimezone);
  if (!lead) return fallback;

  const state = String(lead.state || '').trim().toLowerCase();
  if (state && US_STATE_TZ[state]) {
    return US_STATE_TZ[state];
  }

  const country = String(lead.country || '').trim().toLowerCase();
  if (country && COUNTRY_TZ[country]) {
    return COUNTRY_TZ[country];
  }

  return fallback;
}
