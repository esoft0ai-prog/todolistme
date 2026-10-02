/**
 * Per-teammate permissions. The workspace owner can do everything. Admins and members start from their role's
 * defaults; the owner can switch any permission on or off for an individual teammate.
 *
 * Owner-only and never delegable: billing & plan changes, changing roles, removing teammates, deleting campaigns,
 * and assigning leads to teammates.
 */
export const PERMISSIONS = {
  'campaigns.manage': { label: 'Create and edit campaigns', hint: 'New campaigns, brief, budget and CPL threshold, pause, mark complete', admin: true, member: false },
  'campaigns.share': { label: 'Share campaigns with clients', hint: 'Create and revoke read-only client links', admin: true, member: false },
  'pages.manage': { label: 'Manage pages', hint: 'Upload, redeploy, roll back, pause, rename, VIP rule, custom domains', admin: true, member: false },
  'pages.delete': { label: 'Delete pages', hint: 'Permanently remove a hosted page (its leads are kept)', admin: false, member: false },
  'team.invite': { label: 'Invite teammates', hint: 'Send, resend and cancel invitations', admin: true, member: false },
  'team_notes.post': { label: 'Post team notes', hint: 'Address notes and deadlines to teammates', admin: true, member: false },
  'integrations.manage': { label: 'Manage integrations and webhooks', hint: 'Connect tools, API keys, inbound and outbound webhooks', admin: true, member: false },
  'sla.manage': { label: 'Change SLA settings', hint: 'Response thresholds, VIP rules, cross-tool SLA rules, alert routing', admin: true, member: false },
  'ai.manage': { label: 'Manage AI provider', hint: 'AI keys, models and refresh schedule', admin: false, member: false },
  'telegram.manage': { label: 'Manage Telegram', hint: 'Connect or disconnect the Telegram bot', admin: false, member: false },
  'notifications.manage': { label: 'Change workspace notifications', hint: 'Digest time and alert channels for the workspace', admin: false, member: false },
  'workspace.manage': { label: 'Edit workspace details', hint: 'Workspace name and logo', admin: false, member: false },
  'logs.view': { label: 'View the workspace log', hint: 'Audit history of workspace changes', admin: true, member: false },
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const PERMISSION_KEYS = Object.keys(PERMISSIONS) as Permission[];

export function effectivePermissions(role: string, overrides: Record<string, boolean> | null | undefined): Record<Permission, boolean> {
  const out = {} as Record<Permission, boolean>;
  for (const k of PERMISSION_KEYS) {
    if (role === 'owner') { out[k] = true; continue; }
    const base = role === 'admin' ? PERMISSIONS[k].admin : PERMISSIONS[k].member;
    out[k] = overrides && typeof overrides[k] === 'boolean' ? overrides[k] : base;
  }
  return out;
}

export function hasPermission(role: string, overrides: Record<string, boolean> | null | undefined, p: Permission): boolean {
  return effectivePermissions(role, overrides)[p];
}
