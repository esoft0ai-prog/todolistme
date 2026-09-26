/**
 * Inference routing (AI Capability Map Part 6, Agent Architecture Part 5).
 *
 *  1. Classify the task into a workload level (quick / standard / deep / strategic).
 *  2. BYOK: if the workspace's primary key is connected, route through it
 *     (Camplo pays $0). On failure, try the fallback key when enabled.
 *  3. Otherwise route through Camplo's OpenRouter account.
 *  4. Log every call to ai_workload_logs (never shown to operators).
 *
 * Model names never leave this module — operators only see capability levels.
 * When no provider is available at all, `complete()` returns null and callers
 * fall back to deterministic (Level 0/1) output.
 */
import { platform, platformSync } from '../lib/platform.js';
import Anthropic from '@anthropic-ai/sdk';
import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { aiProviderConfigs, aiWorkloadLogs } from '../db/schema.js';
import { config } from '../lib/config.js';
import { decrypt } from '../lib/crypto.js';
import { DEEP_BUDGET_USD, type Plan } from '../domain/rules.js';

export type Workload = 'quick' | 'standard' | 'deep' | 'strategic';
export type TaskType = 'insight' | 'recommendation' | 'chat' | 'retrospective' | 'morning_brief' | 'cross_tool_check' | 'worker';

export interface Message { role: 'user' | 'assistant'; content: string }
export interface CompletionRequest {
  tenantId: string; plan: Plan; workload: Workload; taskType: TaskType;
  system: string; messages: Message[]; maxTokens?: number; json?: boolean;
  /** Overrides the per-workload timeout (e.g. 5 minutes for retrospectives). */
  timeoutMs?: number;
}

/** ADL D-31 / §6: panel-level work gives up after AI_PANEL_TIMEOUT_SECONDS (10s); deep/strategic after 30s. */
function timeoutFor(r: CompletionRequest): number {
  if (r.timeoutMs) return r.timeoutMs;
  return r.workload === 'quick' || r.workload === 'standard' ? config.aiPanelTimeoutSeconds * 1000 : 30_000;
}
export interface Completion { text: string; model: string; byok: boolean; inputTokens: number; outputTokens: number; costUsd: number }

/** Default Anthropic model per tier when an operator's BYOK config leaves the model blank. */
const ANTHROPIC_TIER_MODEL: Record<Workload, string> = {
  quick: 'claude-haiku-4-5', standard: 'claude-sonnet-5', deep: 'claude-sonnet-5', strategic: 'claude-opus-5',
};
const EFFORT: Record<Workload, 'low' | 'medium' | 'high'> = { quick: 'low', standard: 'medium', deep: 'high', strategic: 'high' };

/** Approximate $/1M tokens [in, out] for internal cost tracking only. */
const PRICE: Array<[RegExp, number, number]> = [
  [/opus-5-5/, 4, 20], [/opus/, 5, 25], [/sonnet/, 2, 10], [/haiku/, 1, 5], [/gpt-4\.1|gpt-4o(?!-mini)/, 2.5, 10],
  [/mini|flash|llama|deepseek|qwen/, 0.3, 1.2],
];
function cost(model: string, inTok: number, outTok: number): number {
  const p = PRICE.find(([re]) => re.test(model)) ?? [/./, 2, 10];
  return (inTok * p[1] + outTok * p[2]) / 1_000_000;
}

/** OpenAI-compatible base URLs for non-Anthropic BYOK providers. */
const OPENAI_COMPAT: Record<string, string> = {
  openai: 'https://api.openai.com/v1', groq: 'https://api.groq.com/openai/v1', deepseek: 'https://api.deepseek.com/v1',
  mistral: 'https://api.mistral.ai/v1', xai: 'https://api.x.ai/v1', gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  qwen: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', kimi: 'https://api.moonshot.ai/v1', glm: 'https://open.bigmodel.cn/api/paas/v4',
  minimax: 'https://api.minimax.io/v1', openrouter: 'https://openrouter.ai/api/v1',
};

interface Target { provider: string; model: string; apiKey: string; byok: boolean }

async function callAnthropic(t: Target, r: CompletionRequest): Promise<Omit<Completion, 'byok' | 'costUsd'>> {
  const client = new Anthropic({ apiKey: t.apiKey, maxRetries: 0, timeout: timeoutFor(r) });
  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model: t.model,
    max_tokens: r.maxTokens ?? 16000,
    system: r.system,
    messages: r.messages,
  };
  // Effort is not accepted by Haiku 4.5.
  if (!/haiku/.test(t.model)) params.output_config = { effort: EFFORT[r.workload] };
  if (t.model === 'claude-opus-5') {
    // Server-side refusal fallback: a declined request is re-run on a fallback model in the same call.
    const res = await client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
    if (res.stop_reason === 'refusal') throw new Error('model_refusal');
    const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim();
    return { text, model: res.model, inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens };
  }
  const res = await client.messages.create(params);
  if (res.stop_reason === 'refusal') throw new Error('model_refusal');
  const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim();
  return { text, model: t.model, inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens };
}

async function callOpenAICompatible(t: Target, r: CompletionRequest, baseUrl: string): Promise<Omit<Completion, 'byok' | 'costUsd'>> {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${t.apiKey}`, 'Content-Type': 'application/json', 'X-Title': 'Camplo' },
    body: JSON.stringify({
      model: t.model, max_tokens: r.maxTokens ?? 4000,
      messages: [{ role: 'system', content: r.system }, ...r.messages],
      ...(r.json ? { response_format: { type: 'json_object' } } : {}),
    }),
    signal: AbortSignal.timeout(timeoutFor(r)),
  });
  if (!res.ok) throw new Error(`provider_http_${res.status}`);
  const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number }; model?: string };
  return {
    text: (j.choices?.[0]?.message?.content ?? '').trim(), model: j.model ?? t.model,
    inputTokens: j.usage?.prompt_tokens ?? 0, outputTokens: j.usage?.completion_tokens ?? 0,
  };
}

async function callTarget(t: Target, r: CompletionRequest) {
  if (t.provider === 'anthropic') return callAnthropic(t, r);
  const base = OPENAI_COMPAT[t.provider];
  if (!base) throw new Error(`unsupported_provider_${t.provider}`);
  return callOpenAICompatible(t, r, base);
}

function modelFor(provider: string, configured: string | null, w: Workload, models: Record<Workload, string>): string {
  if (configured) return configured;
  if (provider === 'anthropic') return ANTHROPIC_TIER_MODEL[w];
  return models[w];
}

/** Resolve the ordered list of targets for a workspace: primary BYOK → fallback BYOK → Camplo. */
export async function targetsFor(db: DB, tenantId: string, w: Workload): Promise<Target[]> {
  const [cfg] = await db.select().from(aiProviderConfigs).where(eq(aiProviderConfigs.tenantId, tenantId));
  const ai = (await platform(db)).ai;
  const out: Target[] = [];
  if (cfg?.primaryApiKeyEncrypted && cfg.primaryProvider && cfg.primaryStatus !== 'failed') {
    out.push({ provider: cfg.primaryProvider, model: modelFor(cfg.primaryProvider, cfg.primaryModelName, w, ai.models), apiKey: decrypt(cfg.primaryApiKeyEncrypted), byok: true });
  }
  if (cfg?.fallbackEnabled && cfg.fallbackApiKeyEncrypted && cfg.fallbackProvider) {
    out.push({ provider: cfg.fallbackProvider, model: modelFor(cfg.fallbackProvider, cfg.fallbackModelName, w, ai.models), apiKey: decrypt(cfg.fallbackApiKeyEncrypted), byok: true });
  }
  if (ai.openRouterApiKey) out.push({ provider: 'openrouter', model: ai.models[w], apiKey: ai.openRouterApiKey, byok: false });
  return out;
}

/** Share of the plan's monthly Deep+Strategic budget used (Camplo-paid inference only). */
export async function advancedUsage(db: DB, tenantId: string, plan: Plan): Promise<number> {
  const start = new Date(); start.setUTCDate(1); start.setUTCHours(0, 0, 0, 0);
  const [row] = await db.select({ total: sql<string>`coalesce(sum(${aiWorkloadLogs.costUsd}), 0)` }).from(aiWorkloadLogs).where(and(
    eq(aiWorkloadLogs.tenantId, tenantId), eq(aiWorkloadLogs.byok, false),
    inArray(aiWorkloadLogs.workloadLevel, ['deep', 'strategic']), gte(aiWorkloadLogs.createdAt, start)));
  const budget = (await platform(db)).pricing.plans[plan].deepBudgetUsd || 1;
  return Number(row?.total ?? 0) / budget;
}

export interface CompleteResult { completion: Completion | null; usingFallback: boolean; downgraded: boolean; error?: string }

export async function complete(db: DB, r: CompletionRequest): Promise<CompleteResult> {
  let workload = r.workload;
  let downgraded = false;
  const targets = await targetsFor(db, r.tenantId, workload);
  // Camplo-paid Deep/Strategic work stops at 100% of the plan's advanced capacity;
  // Standard intelligence stays available (Capability Map Part 7).
  if ((workload === 'deep' || workload === 'strategic') && !targets.some((t) => t.byok)) {
    if (await advancedUsage(db, r.tenantId, r.plan) >= 1) { workload = 'standard'; downgraded = true; }
  }
  const list = downgraded ? await targetsFor(db, r.tenantId, workload) : targets;
  let lastErr: string | undefined;
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    try {
      const res = await callTarget(t, { ...r, workload });
      const c: Completion = { ...res, byok: t.byok, costUsd: t.byok ? 0 : cost(res.model, res.inputTokens, res.outputTokens) };
      await db.insert(aiWorkloadLogs).values({
        tenantId: r.tenantId, taskType: r.taskType, workloadLevel: workload, modelUsed: c.model,
        inputTokens: c.inputTokens, outputTokens: c.outputTokens, costUsd: c.costUsd.toFixed(6), byok: c.byok,
      });
      const usingFallback = t.byok && i > 0 && list[0].byok;
      await db.update(aiProviderConfigs).set({ usingFallback }).where(eq(aiProviderConfigs.tenantId, r.tenantId));
      return { completion: c, usingFallback, downgraded };
    } catch (e) {
      lastErr = (e as Error).message;
      if (t.byok && i === 0) {
        await db.update(aiProviderConfigs).set({ primaryStatus: 'failed' }).where(eq(aiProviderConfigs.tenantId, r.tenantId));
      }
    }
  }
  return { completion: null, usingFallback: false, downgraded, error: lastErr ?? 'no_provider' };
}

/** Verify a key with a minimal call (Settings → AI Provider → Verify). */
export async function verifyProvider(provider: string, model: string | null, apiKey: string): Promise<boolean> {
  try {
    const res = await callTarget({ provider, model: modelFor(provider, model, 'quick', platformSync().ai.models), apiKey, byok: true }, {
      tenantId: '', plan: 'starter', workload: 'quick', taskType: 'chat', system: 'Reply with OK.', messages: [{ role: 'user', content: 'ping' }], maxTokens: 16,
    });
    return typeof res.text === 'string';
  } catch {
    return false;
  }
}

/** Parse the first JSON object/array out of a model response. */
export function parseJson<T>(text: string): T | null {
  const m = text.match(/[[{][\s\S]*[\]}]/);
  if (!m) return null;
  try { return JSON.parse(m[0]) as T; } catch { return null; }
}
