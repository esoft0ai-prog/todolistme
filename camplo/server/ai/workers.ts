/**
 * Workers — bounded intelligence tasks, created dynamically and terminated when
 * done (Agent Architecture Part 4). Every Worker runs under a WorkerContract;
 * isolation is enforced here in code, outside the LLM prompt:
 *   tenant + campaign boundary · tool allowlist · read-only permissions ·
 *   max depth (2) · timeout · max tool calls · AI budget tier.
 * Every run is logged immutably to agent_worker_logs.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { DB } from '../db/client.js';
import { agentWorkerLogs } from '../db/schema.js';
import { config } from '../lib/config.js';
import type { Plan } from '../domain/rules.js';
import { complete, parseJson, type Workload } from './router.js';
import { TOOL_NAMES, TOOLS, type ToolScope } from './tools.js';

export type Capability = 'investigation' | 'research' | 'campaign_analysis' | 'conversation_analysis' | 'strategic_analysis' | 'evaluation' | 'execution';
export type Permission = 'read';
export type WorkloadBudget = 'low' | 'medium' | 'high';

export interface CampaignContext { campaignId: string | null; campaignName?: string | null; windowDays: number }

export interface WorkerContract {
  workerId: string;
  capability: Capability;
  objective: string;
  context: CampaignContext;
  tools: string[];
  permissions: Permission[];
  budget: WorkloadBudget;
  timeout: number;       // seconds
  maxToolCalls: number;
  outputSchema: z.ZodType<WorkerOutput>;
  tenantId: string;
  campaignId: string | null;
}

export const workerOutputSchema = z.object({
  summary: z.string(),
  findings: z.array(z.string()).default([]),
  evidence: z.array(z.string()).default([]),
  confidence: z.enum(['low', 'medium', 'high']).default('low'),
  unresolved: z.array(z.string()).default([]),
});
export type WorkerOutput = z.infer<typeof workerOutputSchema>;

/** Default tools per capability — the Main Agent may narrow but never widen these. */
export const CAPABILITY_TOOLS: Record<Capability, string[]> = {
  investigation: ['get_campaign_metrics', 'get_lead_data', 'get_webhook_health', 'get_campaign_history', 'get_data_sources'],
  research: ['get_campaign_metrics', 'get_funnel_data', 'get_data_sources'],
  campaign_analysis: ['get_campaign_metrics', 'get_funnel_data', 'get_campaign_history', 'get_data_sources'],
  conversation_analysis: ['get_conversation_signals', 'get_lead_data'],
  strategic_analysis: ['get_campaign_metrics', 'get_funnel_data', 'get_campaign_history', 'get_team_patterns', 'get_data_sources'],
  evaluation: ['get_campaign_history', 'get_campaign_metrics'],
  execution: [], // v2 — no execution tools exist in v1
};

const TIER: Record<WorkloadBudget, { workload: Workload; logTier: 'utility' | 'workhorse' | 'deep' }> = {
  low: { workload: 'quick', logTier: 'utility' },
  medium: { workload: 'standard', logTier: 'workhorse' },
  high: { workload: 'deep', logTier: 'deep' },
};

export class WorkerPolicyError extends Error {}

export function makeContract(p: {
  tenantId: string; capability: Capability; objective: string; campaignId?: string | null; campaignName?: string | null;
  tools?: string[]; budget?: WorkloadBudget; timeout?: number; maxToolCalls?: number;
}): WorkerContract {
  const allowed = CAPABILITY_TOOLS[p.capability];
  return {
    workerId: `wrk_${randomUUID().slice(0, 12)}`, capability: p.capability, objective: p.objective,
    context: { campaignId: p.campaignId ?? null, campaignName: p.campaignName ?? null, windowDays: 14 },
    tools: (p.tools ?? allowed).filter((t) => allowed.includes(t)),
    permissions: ['read'], budget: p.budget ?? 'medium',
    timeout: Math.min(p.timeout ?? config.workerDefaultTimeoutSeconds, config.workerDefaultTimeoutSeconds),
    maxToolCalls: Math.min(p.maxToolCalls ?? config.workerMaxToolCalls, config.workerMaxToolCalls),
    outputSchema: workerOutputSchema, tenantId: p.tenantId, campaignId: p.campaignId ?? null,
  };
}

/** Validate a contract before anything runs. Throws WorkerPolicyError on any violation. */
export function enforceContract(c: WorkerContract, depth: number) {
  if (!c.tenantId) throw new WorkerPolicyError('Worker contract has no tenant');
  if (depth > config.workerMaxDepth) throw new WorkerPolicyError(`Worker depth ${depth} exceeds maximum ${config.workerMaxDepth}`);
  if (c.capability === 'execution') throw new WorkerPolicyError('Execution workers are not enabled in v1');
  if (c.permissions.some((p) => p !== 'read')) throw new WorkerPolicyError('Only read permissions are allowed in v1');
  for (const t of c.tools) {
    if (!TOOL_NAMES.includes(t)) throw new WorkerPolicyError(`Unknown tool ${t}`);
    if (!CAPABILITY_TOOLS[c.capability].includes(t)) throw new WorkerPolicyError(`Tool ${t} not permitted for ${c.capability}`);
  }
  if (c.tools.length > c.maxToolCalls) throw new WorkerPolicyError('Contract tools exceed maxToolCalls');
}

export interface WorkerResult { workerId: string; capability: Capability; output: WorkerOutput; status: 'completed' | 'failed' | 'timeout'; data: Record<string, unknown> }

/**
 * Run one Worker. Data gathering is performed by Camplo code calling the
 * permitted tools (bounded by maxToolCalls); the LLM only reasons over the
 * gathered data and returns the structured output. Workers cannot spawn Workers.
 */
export async function runWorker(db: DB, plan: Plan, c: WorkerContract, depth = 1): Promise<WorkerResult> {
  enforceContract(c, depth);
  const started = Date.now();
  const scope: ToolScope = { db, tenantId: c.tenantId, campaignId: c.campaignId };
  let toolCalls = 0;
  const data: Record<string, unknown> = {};
  let model = 'none', inTok = 0, outTok = 0, cost = 0, byok = false;
  let status: WorkerResult['status'] = 'completed';
  let output: WorkerOutput = { summary: '', findings: [], evidence: [], confidence: 'low', unresolved: [] };

  const work = (async () => {
    for (const t of c.tools) {
      if (++toolCalls > c.maxToolCalls) break;
      data[t] = await TOOLS[t].fn(scope, { query: c.objective });
    }
    const res = await complete(db, {
      tenantId: c.tenantId, plan, workload: TIER[c.budget].workload, taskType: 'worker', json: true, maxTokens: 1500,
      system: `You are a Camplo ${c.capability.replace('_', ' ')} worker. Objective: ${c.objective}. ` +
        'Reason only over the DATA provided. Never invent numbers. Return JSON: {"summary": string, "findings": string[], "evidence": string[], "confidence": "low"|"medium"|"high", "unresolved": string[]}.',
      messages: [{ role: 'user', content: `DATA:\n${JSON.stringify(data).slice(0, 24000)}` }],
    });
    if (res.completion) {
      model = res.completion.model; inTok = res.completion.inputTokens; outTok = res.completion.outputTokens; cost = res.completion.costUsd; byok = res.completion.byok;
      const parsed = c.outputSchema.safeParse(parseJson(res.completion.text));
      if (parsed.success) output = parsed.data;
      else output = { ...output, summary: res.completion.text.slice(0, 800) };
    } else {
      output = deterministicSummary(c, data);
    }
  })();

  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([work, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), c.timeout * 1000); })]);
  } catch (e) {
    status = (e as Error).message === 'timeout' ? 'timeout' : 'failed';
    output = { ...deterministicSummary(c, data), unresolved: [`Worker ${status}`] };
  } finally {
    clearTimeout(timer);
  }
  await db.insert(agentWorkerLogs).values({
    tenantId: c.tenantId, workerId: c.workerId, capabilityType: c.capability, objective: c.objective, campaignId: c.campaignId,
    toolsUsed: Object.keys(data), toolCallCount: toolCalls, workloadLevel: TIER[c.budget].logTier, modelUsed: model,
    inputTokens: inTok, outputTokens: outTok, costUsd: cost.toFixed(6), byok, status, durationMs: Date.now() - started, completedAt: new Date(),
  });
  return { workerId: c.workerId, capability: c.capability, output, status, data };
}

/** Rule-based digest of gathered data when no model is available. */
function deterministicSummary(c: WorkerContract, data: Record<string, unknown>): WorkerOutput {
  const findings: string[] = [];
  const camps = (data.get_campaign_metrics as Array<Record<string, any>> | undefined) ?? [];
  for (const k of camps) {
    if (k.health !== 'healthy') findings.push(`${k.name} is ${k.health} (lead volume ${k.health_signals.lead_volume}, acknowledgment ${k.health_signals.acknowledgment}, webhook ${k.health_signals.webhook}).`);
    if (k.cpl != null && k.cpl_threshold != null && k.cpl > k.cpl_threshold) findings.push(`${k.name} CPL ${k.cpl} is above its ${k.cpl_threshold} threshold.`);
  }
  const lead = data.get_lead_data as { unresponded: Array<Record<string, any>> } | undefined;
  const od = lead?.unresponded.filter((l) => l.overdue) ?? [];
  if (od.length) findings.push(`${od.length} leads are overdue; longest waiting is ${od[0].name} (${od[0].waiting}).`);
  const hooks = (data.get_webhook_health as Array<Record<string, any>> | undefined) ?? [];
  for (const h of hooks) if (h.webhook === 'offline') findings.push(`Webhook for ${h.page} is offline.`);
  return { summary: findings[0] ?? `No anomalies found for: ${c.objective}`, findings, evidence: [], confidence: findings.length ? 'medium' : 'low', unresolved: [] };
}
