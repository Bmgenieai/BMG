/**
 * Resolve CRM working-report periods in Asia/Karachi (office timezone).
 * Returns UTC-ish SQLite datetime strings (YYYY-MM-DD HH:MM:SS) for comparisons.
 */

export const WORKING_TZ = 'Asia/Karachi';

const PERIODS = new Set(['today', 'yesterday', 'week', 'month']);

export function normalizePeriod(raw) {
  const p = String(raw || 'today').trim().toLowerCase();
  return PERIODS.has(p) ? p : 'today';
}

function pad(n) {
  return String(n).padStart(2, '0');
}

/** Calendar YMD in the given IANA timezone. */
export function ymdInTz(date = new Date(), timeZone = WORKING_TZ) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/** UTC instant for local midnight of YYYY-MM-DD in timeZone. */
export function zonedStartOfDay(ymd, timeZone = WORKING_TZ) {
  // en-CA gives YYYY-MM-DD; interpret as midnight in zone via offset walk
  const [y, m, d] = ymd.split('-').map(Number);
  let guess = Date.UTC(y, m - 1, d, 0, 0, 0);
  for (let i = 0; i < 4; i++) {
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
      })
        .formatToParts(new Date(guess))
        .filter((p) => p.type !== 'literal')
        .map((p) => [p.type, p.value]),
    );
    const hour = Number(parts.hour === '24' ? '0' : parts.hour);
    const asUtc = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      hour,
      Number(parts.minute),
      Number(parts.second),
    );
    const desired = Date.UTC(y, m - 1, d, 0, 0, 0);
    const delta = desired - asUtc;
    if (delta === 0) break;
    guess += delta;
  }
  return new Date(guess);
}

function addCalendarDays(ymd, days) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

/** Monday (ISO) YMD of the week containing `ymd` (calendar date in zone). */
function mondayOfWeek(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  // Use noon UTC on that calendar date as a stable weekday probe in zone
  const probe = zonedStartOfDay(ymd);
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: WORKING_TZ,
    weekday: 'short',
  }).format(probe);
  const map = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  const offset = map[weekday] ?? 0;
  return addCalendarDays(ymd, -offset);
}

function firstOfMonth(ymd) {
  return `${ymd.slice(0, 7)}-01`;
}

export function toSqliteUtc(date) {
  const iso = date.toISOString();
  return iso.slice(0, 19).replace('T', ' ');
}

const PERIOD_LABELS = {
  today: 'Today',
  yesterday: 'Yesterday',
  week: 'This week',
  month: 'This month',
};

/**
 * @param {string} periodRaw
 * @param {Date} [now]
 * @returns {{ period: string, label: string, timezone: string, fromYmd: string, toYmd: string, from: string, to: string }}
 */
export function resolveWorkingPeriod(periodRaw, now = new Date()) {
  const period = normalizePeriod(periodRaw);
  const todayYmd = ymdInTz(now);
  let fromYmd;
  let toExclusiveYmd;

  if (period === 'today') {
    fromYmd = todayYmd;
    toExclusiveYmd = addCalendarDays(todayYmd, 1);
  } else if (period === 'yesterday') {
    fromYmd = addCalendarDays(todayYmd, -1);
    toExclusiveYmd = todayYmd;
  } else if (period === 'week') {
    fromYmd = mondayOfWeek(todayYmd);
    toExclusiveYmd = addCalendarDays(todayYmd, 1); // through end of today
  } else {
    fromYmd = firstOfMonth(todayYmd);
    toExclusiveYmd = addCalendarDays(todayYmd, 1);
  }

  const from = toSqliteUtc(zonedStartOfDay(fromYmd));
  const to = toSqliteUtc(zonedStartOfDay(toExclusiveYmd));

  return {
    period,
    label: PERIOD_LABELS[period],
    timezone: WORKING_TZ,
    fromYmd,
    toYmd: addCalendarDays(toExclusiveYmd, -1),
    from,
    to,
  };
}
