/**
 * Level 0 intelligence — pure, rule-based, zero LLM cost (AI Capability Map Part 2).
 * No I/O here: every function takes plain values so it can be unit-tested and
 * reused by services, the SSE hub and the AI context builder.
 */

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

// ---------------------------------------------------------------- SLA timers
export type Path = 'A' | 'B' | 'C' | null;
export interface TimerLead {
  receivedAt: Date; respondedAt: Date | null; assignmentPath: Path;
  claimedAt: Date | null; assignedAt: Date | null; reassignedAt: Date | null;
  status: 'not_responded' | 'responded'; vip?: boolean;
}

/** Timer 1 — Customer Waiting. Anchor received_at, never resets; freezes at responded_at. */
export function customerWaitingMs(l: TimerLead, now = new Date()): number {
  return ((l.respondedAt ?? now).getTime() - l.receivedAt.getTime());
}

/** Timer 2 anchor by ownership path. Null until the first ownership event. */
export function responseAnchor(l: TimerLead): Date | null {
  switch (l.assignmentPath) {
    case 'A': return l.claimedAt;
    case 'B': return l.assignedAt;
    case 'C': return l.reassignedAt;
    default: return null;
  }
}

/** Timer 2 — Response Time. Null when nobody owns the lead yet. */
export function responseTimeMs(l: TimerLead, now = new Date()): number | null {
  const a = responseAnchor(l);
  if (!a) return null;
  return (l.respondedAt ?? now).getTime() - a.getTime();
}

export function thresholdMinutesFor(l: { vip?: boolean }, t: { slaThresholdMinutes: number; vipSlaThresholdMinutes: number; vipLeadEnabled: boolean }): number {
  return l.vip && t.vipLeadEnabled ? t.vipSlaThresholdMinutes : t.slaThresholdMinutes;
}

export function isOverdue(l: TimerLead, thresholdMinutes: number, now = new Date()): boolean {
  return l.status === 'not_responded' && now.getTime() - l.receivedAt.getTime() > thresholdMinutes * MIN;
}

/** Timer colour: <75% green, 75–100% amber, ≥100% red (Build Spec Screen 11). */
export function timerColor(elapsedMs: number, thresholdMinutes: number): 'green' | 'amber' | 'red' {
  const t = thresholdMinutes * MIN;
  if (elapsedMs < t * 0.75) return 'green';
  if (elapsedMs < t) return 'amber';
  return 'red';
}

/** Speed-to-Lead colour: <5 min green, <30 min amber, else red. */
export function speedColor(ms: number | null): 'green' | 'amber' | 'red' | 'none' {
  if (ms == null) return 'none';
  if (ms < 5 * MIN) return 'green';
  if (ms < 30 * MIN) return 'amber';
  return 'red';
}

/** "Xm Xs" below one hour, "Xh Xm" otherwise. */
export function formatDuration(ms: number | null): string {
  if (ms == null) return '—';
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}h ${m}m` : `${m}m ${sec}s`;
}

// ---------------------------------------------------------------- ownership
export type Role = 'owner' | 'admin' | 'member';

export interface RespondCheck { status: 'not_responded' | 'responded'; assigneeId: string | null }
/** Respond visibility (Screen 11): unassigned, assigned to me, or owner. */
export function canRespond(l: RespondCheck, userId: string, role: Role): boolean {
  if (l.status === 'responded') return false;
  return l.assigneeId === null || l.assigneeId === userId || role === 'owner';
}

/**
 * Which path an assignment is. Owner/admin assigning an unowned lead = B.
 * Reassigning an already-owned lead = C (owner override, §17.10).
 */
export function assignmentPathFor(currentAssignee: string | null): 'B' | 'C' {
  return currentAssignee ? 'C' : 'B';
}

// ---------------------------------------------------------------- health
export type Signal = 'green' | 'amber' | 'red';
export type Health = 'healthy' | 'watch' | 'critical';

export function leadVolumeSignal(leadsLast7d: number, avgWeekly: number): Signal {
  if (avgWeekly <= 0) return 'green'; // no baseline yet — nothing to compare against
  if (leadsLast7d === 0) return 'red';
  if (leadsLast7d >= avgWeekly * 0.8) return 'green';
  if (leadsLast7d >= avgWeekly * 0.5) return 'amber';
  return 'red';
}

export function ackRateSignal(responded: number, total: number): Signal {
  if (total === 0) return 'green';
  const r = responded / total;
  if (r >= 0.9) return 'green';
  if (r >= 0.7) return 'amber';
  return 'red';
}

export function webhookSignal(statuses: Array<'operational' | 'stale' | 'offline'>): Signal {
  if (statuses.includes('offline')) return 'red';
  if (statuses.includes('stale')) return 'amber';
  return 'green';
}

/**
 * Health Pulse (Data Model §3): all green → healthy; two+ non-green or any red → critical;
 * otherwise watch.
 */
export function healthPulse(signals: Signal[]): Health {
  const notGreen = signals.filter((s) => s !== 'green').length;
  if (notGreen === 0) return 'healthy';
  if (notGreen >= 2 || signals.includes('red')) return 'critical';
  return 'watch';
}

// ---------------------------------------------------------------- webhook health
export type HookState = 'operational' | 'stale' | 'offline' | 'never_connected';

/**
 * Data Model §11. Offline at ≥120 min silence. Stale when silence passes the
 * per-source threshold but has not yet reached offline — the model's literal
 * rule makes "stale" unreachable with the default 480-min threshold, so the
 * stale window is clamped to [threshold, 120) when threshold < 120 and to a
 * fixed 60–120 min band otherwise. Documented in README "Spec clarifications".
 */
export function webhookState(lastReceivedAt: Date | null, staleThresholdMinutes: number, now = new Date()): HookState {
  if (!lastReceivedAt) return 'never_connected';
  const silenceMin = (now.getTime() - lastReceivedAt.getTime()) / MIN;
  if (silenceMin >= 120) return 'offline';
  const staleAt = Math.min(staleThresholdMinutes, 60);
  return silenceMin >= staleAt ? 'stale' : 'operational';
}

// ---------------------------------------------------------------- notes
export const NOTE_EDIT_WINDOW_MS = 2 * HOUR;
export function noteEditable(createdAt: Date, authorId: string, userId: string, now = new Date(), windowMs = NOTE_EDIT_WINDOW_MS): boolean {
  return authorId === userId && now.getTime() - createdAt.getTime() < windowMs;
}

// ---------------------------------------------------------------- money
/** CPL = daily_spend / lead_count; null if either is missing or zero leads (Data Model §3). */
export function cpl(dailySpend: number | null, leadCount: number): number | null {
  if (dailySpend == null || leadCount <= 0) return null;
  return Math.round((dailySpend / leadCount) * 100) / 100;
}

// ---------------------------------------------------------------- deployments
export function hasRollbackAvailable(prevPath: string | null, prevDeployedAt: Date | null, now = new Date(), retentionDays = 30): boolean {
  return !!prevPath && !!prevDeployedAt && now.getTime() - prevDeployedAt.getTime() < retentionDays * DAY;
}

export function earlyWarningActive(deployedAt: Date | null, now = new Date(), windowHours = 72): boolean {
  return !!deployedAt && now.getTime() - deployedAt.getTime() < windowHours * HOUR;
}

// ---------------------------------------------------------------- insights
const SEV: Record<string, number> = { red: 1, amber: 2, blue: 3, green: 4 };
export interface Orderable { type: string; severity: string; generatedAt: Date }
/** Priority Flag first, then red → amber → blue → green, newest first within a group. */
export function orderInsights<T extends Orderable>(list: T[]): T[] {
  return [...list].sort((a, b) =>
    Number(b.type === 'priority_flag') - Number(a.type === 'priority_flag')
    || Number(a.type === 'insufficient_evidence') - Number(b.type === 'insufficient_evidence')
    || (SEV[a.severity] ?? 9) - (SEV[b.severity] ?? 9)
    || b.generatedAt.getTime() - a.generatedAt.getTime());
}

/** Minimum sample for Level 2+ (Capability Map Part 10): 100 leads OR 14 days. */
export function hasSufficientEvidence(leadCount: number, daysOfData: number): boolean {
  return leadCount >= 100 || daysOfData >= 14;
}

// ---------------------------------------------------------------- plans
export type Plan = 'starter' | 'growth' | 'watchtower' | 'agency';
const RANK: Record<Plan, number> = { starter: 0, growth: 1, watchtower: 2, agency: 3 };
export const planAtLeast = (plan: Plan, min: Plan) => RANK[plan] >= RANK[min];

export type Feature =
  | 'ai_chat' | 'utm' | 'health_pulse' | 'early_warning' | 'benchmarking' | 'budget' | 'team_notes'
  | 'my_performance' | 'client_view' | 'morning_brief' | 'depth_selector' | 'campaign_logs' | 'win_signals'
  | 'cross_tool_sla' | 'retrospective' | 'team_patterns' | 'level3' | 'level4' | 'unlimited_tools';

export const FEATURE_PLAN: Record<Feature, Plan> = {
  ai_chat: 'growth', utm: 'growth', health_pulse: 'growth', early_warning: 'growth', benchmarking: 'growth',
  budget: 'growth', team_notes: 'growth', my_performance: 'growth', client_view: 'growth', morning_brief: 'growth',
  depth_selector: 'growth', campaign_logs: 'growth', win_signals: 'growth',
  cross_tool_sla: 'watchtower', retrospective: 'watchtower', team_patterns: 'watchtower', level3: 'watchtower',
  level4: 'watchtower', unlimited_tools: 'watchtower',
};
export const hasFeature = (plan: Plan, f: Feature) => planAtLeast(plan, FEATURE_PLAN[f]);

export const PLAN_LIMITS: Record<Plan, { campaigns: number; deployments: number; members: number; connectedTools: number }> = {
  starter: { campaigns: 3, deployments: 5, members: 3, connectedTools: 0 },
  growth: { campaigns: 10, deployments: Infinity, members: Infinity, connectedTools: 1 },
  watchtower: { campaigns: Infinity, deployments: Infinity, members: Infinity, connectedTools: Infinity },
  agency: { campaigns: Infinity, deployments: Infinity, members: Infinity, connectedTools: Infinity },
};
export const PLAN_PRICE: Record<Plan, number> = { starter: 97, growth: 197, watchtower: 347, agency: 597 };

/** Monthly advanced-intelligence budget (USD of Deep+Strategic inference) per plan. */
export const DEEP_BUDGET_USD: Record<Plan, number> = { starter: 0.5, growth: 6, watchtower: 20, agency: 40 };

export function recommendationLevelAllowed(plan: Plan, level: number): boolean {
  if (level <= 1) return true;
  if (level === 2) return planAtLeast(plan, 'growth');
  return planAtLeast(plan, 'watchtower');
}
