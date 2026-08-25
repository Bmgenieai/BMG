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
  'leads:generate_segments': ['ceo', 'manager'],

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
    label: 'Signed up · no listings',
    description: 'Registered on BMGenie but never created a listing',
  },
  free_credit_no_purchase: {
    key: 'free_credit_no_purchase',
    label: 'Free credit · no purchase',
    description: 'Used free trial credits but never bought a package',
  },
  purchased_no_repurchase: {
    key: 'purchased_no_repurchase',
    label: 'Purchased · no repurchase',
    description: 'Paid once, has not bought again (win-back)',
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

export const LEAD_STATUSES = [
  'new',
  'contacted',
  'follow_up_scheduled',
  'converted',
  'lost',
];

export const OPEN_STATUSES = ['new', 'contacted', 'follow_up_scheduled'];
export const END_STATUSES = ['converted', 'lost'];
