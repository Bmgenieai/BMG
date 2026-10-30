/**
 * Shared list/count filters for CRM lead queues.
 * BD should not work internal/test accounts or Pakistan prospects.
 */

function col(alias, name) {
  return alias ? `${alias}.${name}` : name;
}

/** SQLite predicate: internal / QA / obvious test leads (by email or name). */
export function testLeadSql(alias = 'l') {
  const e = `LOWER(TRIM(COALESCE(${col(alias, 'email')}, '')))`;
  const n = `LOWER(TRIM(COALESCE(${col(alias, 'name')}, '')))`;
  return `(
    ${e} LIKE '%@bmgenie.ai'
    OR ${e} LIKE '%@benchmarkstudio.biz'
    OR ${e} LIKE '%test%'
    OR ${e} LIKE '%demo%'
    OR ${e} LIKE '%+qa%'
    OR ${e} LIKE '%e2e%'
    OR ${e} LIKE '%smoke%'
    OR ${n} LIKE '%test%'
    OR ${n} LIKE '%internal%'
    OR ${n} = 'qa'
    OR ${n} LIKE 'qa %'
    OR ${n} LIKE '% qa'
  )`;
}

/** SQLite predicate: country is Pakistan (ISO or full name). */
export function pakistanLeadSql(alias = 'l') {
  const c = `LOWER(TRIM(COALESCE(${col(alias, 'country')}, '')))`;
  return `(
    ${c} IN ('pk', 'pak', 'pakistan')
    OR ${c} LIKE 'pakistan%'
    OR ${c} LIKE '% pakistan'
  )`;
}

/**
 * Exclude test accounts and Pakistan from active BD/CEO queues.
 * Unknown / empty country is kept (same rule as product funnel).
 * Pass alias '' when querying bare `leads` (no table alias).
 */
export function excludeTestAndPakistanSql(alias = 'l') {
  return `NOT ${testLeadSql(alias)} AND NOT ${pakistanLeadSql(alias)}`;
}
