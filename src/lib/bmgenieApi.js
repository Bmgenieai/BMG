/**
 * Proxy helpers for BMGenie main API crm-analytics endpoints.
 * Main site agent ships GET /api/crm-analytics/* secured by X-CRM-Ingest-Key.
 */

function baseUrl() {
  return (process.env.BMGENIE_API_URL || '').trim().replace(/\/$/, '');
}

function ingestKey() {
  return (process.env.CRM_INGEST_API_KEY || '').trim();
}

/**
 * @param {string} path e.g. /crm-analytics/daily-new-users
 * @param {Record<string, string>} [query]
 */
export async function fetchBmgenieCrmAnalytics(path, query = {}) {
  const base = baseUrl();
  const key = ingestKey();
  if (!base || !key) {
    return {
      ok: false,
      unavailable: true,
      error: 'BMGENIE_API_URL or CRM_INGEST_API_KEY not configured',
      data: null,
    };
  }

  const p = path.startsWith('/') ? path : `/${path}`;
  const url = new URL(`${base}${p.startsWith('/api') ? p : `/api${p}`}`);
  for (const [k, v] of Object.entries(query)) {
    if (v != null && v !== '') url.searchParams.set(k, String(v));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'X-CRM-Ingest-Key': key,
      },
      signal: controller.signal,
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { error: text?.slice(0, 200) };
    }
    if (!res.ok) {
      return {
        ok: false,
        unavailable: res.status >= 500 || res.status === 404,
        error: data?.error || `BMGenie API HTTP ${res.status}`,
        status: res.status,
        data: null,
      };
    }
    return { ok: true, unavailable: false, error: null, data };
  } catch (err) {
    return {
      ok: false,
      unavailable: true,
      error: err?.message || 'BMGenie API unreachable',
      data: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Normalize main-API or CRM-local user rows for Analytics modals. */
export function normalizeUserRows(users = []) {
  return (users || []).map((u) => ({
    id: u.id || u.bmgenieUserId || u.bmgenie_user_id || null,
    email: u.email || null,
    name: u.name || null,
    phone: u.phone || null,
    company: u.company || null,
    createdAt: u.createdAt || u.created_at || null,
    ...u,
  }));
}
