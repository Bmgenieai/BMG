/**
 * Central RBAC — add roles/permissions here; routes use requirePermission().
 * Do not scatter role string checks across handlers.
 */

export const ROLES = ['ceo', 'manager', 'telesales'];

export const PERMISSIONS = {
  // Analytics
  'analytics:view_all': ['ceo'],
  'analytics:view_team': ['ceo', 'manager'],
  'analytics:view_own': ['ceo', 'manager', 'telesales'],

  // Leads
  'leads:view_all': ['ceo', 'manager'],
  'leads:view_own': ['ceo', 'manager', 'telesales'],
  'leads:create': ['ceo', 'manager'],
  'leads:update_any': ['ceo', 'manager'],
  'leads:update_own': ['ceo', 'manager', 'telesales'],
  'leads:import': ['ceo', 'manager'],
  'leads:assign': ['ceo', 'manager'],

  // Follow-ups
  'followups:view_all': ['ceo', 'manager'],
  'followups:view_own': ['ceo', 'manager', 'telesales'],
  'followups:manage_own': ['ceo', 'manager', 'telesales'],
  'followups:manage_team': ['ceo', 'manager'],

  // Working tree
  'working_tree:view_all': ['ceo'],
  'working_tree:view_team': ['ceo', 'manager'],
  'working_tree:view_own': ['ceo', 'manager', 'telesales'],

  // Admin / employees
  'admin:employees': ['ceo'],
  'admin:settings': ['ceo'],

  // Revenue logging
  'revenue:record': ['ceo', 'manager'],
  'revenue:view': ['ceo', 'manager'],
};

export function roleHasPermission(role, permission) {
  const allowed = PERMISSIONS[permission];
  if (!allowed) return false;
  return allowed.includes(role);
}

export function canAccessLead(user, lead) {
  if (!lead) return false;
  if (roleHasPermission(user.role, 'leads:view_all')) return true;
  return lead.assigned_to === user.id;
}

export const LEAD_SOURCES = {
  signup_no_listing: {
    key: 'signup_no_listing',
    label: 'Signed up · no purchase',
    description: 'Registered on BMGenie — has not bought a package yet',
  },
  free_credit_no_purchase: {
    key: 'free_credit_no_purchase',
    label: 'Free credit · no purchase',
    description: 'Used free trial credit but never bought a package',
  },
  purchased_no_repurchase: {
    key: 'purchased_no_repurchase',
    label: 'Credits used · no repurchase',
    description: 'Bought a package, used all credits, has not repurchased',
  },
  csv_import: {
    key: 'csv_import',
    label: 'CSV / Meta ads',
    description: 'Imported from CSV (Meta ads, campaigns, etc.)',
  },
  manual: {
    key: 'manual',
    label: 'Manual',
    description: 'Created manually by staff',
  },
};

/** Marketing pipeline statuses (matches staff portal tabs). */
export const LEAD_STATUSES = [
  'new',
  'contacted',
  'interested',
  'neutral',
  'follow_up_scheduled',
  'not_interested',
  'converted',
  'lost', // legacy — treated as not_interested in UI
];

export const STATUS_LABELS = {
  new: 'New Leads',
  contacted: 'Contacted',
  interested: 'Interested',
  neutral: 'Neutral',
  follow_up_scheduled: 'Follow Up',
  not_interested: 'Not Interested',
  converted: 'Converted',
  lost: 'Not Interested',
};

/** Sidebar status tabs → URL slug under /leads/:filter */
export const LEAD_STATUS_TABS = [
  { slug: 'new', status: 'new', label: 'New Leads' },
  { slug: 'contacted', status: 'contacted', label: 'Contacted' },
  { slug: 'interested', status: 'interested', label: 'Interested' },
  { slug: 'neutral', status: 'neutral', label: 'Neutral' },
  { slug: 'follow-up', status: 'follow_up_scheduled', label: 'Follow Up' },
  { slug: 'not-interested', statuses: ['not_interested', 'lost'], label: 'Not Interested' },
  { slug: 'converted', status: 'converted', label: 'Converted' },
];

/** Product segment tabs (auto-created from bmgenie.ai). */
export const PRODUCT_LEAD_TABS = [
  { slug: 'signup', source: 'signup_no_listing', label: 'Signup · no purchase' },
  { slug: 'free-credit', source: 'free_credit_no_purchase', label: 'Free credit · no purchase' },
  { slug: 'winback', source: 'purchased_no_repurchase', label: 'Win-back · no repurchase' },
];

export const OPEN_STATUSES = [
  'new',
  'contacted',
  'interested',
  'neutral',
  'follow_up_scheduled',
];
export const END_STATUSES = ['converted', 'not_interested', 'lost'];

export function statusLabel(status) {
  return STATUS_LABELS[status] || String(status || '').replace(/_/g, ' ');
}

export function resolveLeadFilter(slug) {
  if (!slug) return {};
  const statusTab = LEAD_STATUS_TABS.find((t) => t.slug === slug);
  if (statusTab) {
    if (statusTab.statuses) return { statuses: statusTab.statuses };
    return { status: statusTab.status };
  }
  const productTab = PRODUCT_LEAD_TABS.find((t) => t.slug === slug);
  if (productTab) return { source: productTab.source };
  return {};
}
