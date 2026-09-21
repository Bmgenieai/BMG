/**
 * User cohort relative to a calendar day (YYYY-MM-DD).
 * New = first signup falls on that day only.
 * Old = signed up on any earlier day.
 * All = no filter.
 */

export const COHORTS = ['all', 'new', 'old'];

export function normalizeCohort(raw) {
  const v = String(raw || 'all').trim().toLowerCase();
  return COHORTS.includes(v) ? v : 'all';
}

/** Calendar day in UTC/SQLite date() terms; default today. */
export function cohortRefDate(raw) {
  if (raw && /^\d{4}-\d{2}-\d{2}$/.test(String(raw))) return String(raw);
  return new Date().toISOString().slice(0, 10);
}

/**
 * SQLite predicate on a timestamp expression (e.g. COALESCE(l.signed_up_at, l.created_at)).
 * Returns { sql, params } to AND into a WHERE clause.
 */
export function cohortSql(expr, cohort, refDate) {
  const c = normalizeCohort(cohort);
  const day = cohortRefDate(refDate);
  if (c === 'new') {
    return { sql: `date(${expr}) = date(?)`, params: [day] };
  }
  if (c === 'old') {
    return { sql: `date(${expr}) < date(?)`, params: [day] };
  }
  return { sql: '1=1', params: [] };
}

export const COHORT_DEFINITIONS = {
  all: 'All users (no signup-day filter)',
  new: 'Signed up for the first time on the selected day only',
  old: 'Signed up on any day before the selected day',
};
