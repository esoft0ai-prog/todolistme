import {
  addDays,
  addMonths,
  endOfMonth,
  endOfWeek,
  endOfYear,
  fromParts,
  isValidISODate,
  MONTH_NAMES,
  startOfMonth,
  startOfWeek,
  startOfYear,
  type DateRange,
} from '../dates';
import { getCurrency } from '../currency';
import type { ISODate } from '../types';

/**
 * Deterministic natural-language parsing for the local assistant: intent
 * classification by weighted patterns, plus entity extraction (amounts,
 * periods, categories, goal names, target dates).
 */

export type Intent =
  | 'affordability'
  | 'category_spend'
  | 'spend_total'
  | 'income_total'
  | 'debt_total'
  | 'next_debt_payment'
  | 'debt_cleared'
  | 'goal_saving'
  | 'top_category'
  | 'biggest_expenses'
  | 'balance'
  | 'budget_status'
  | 'health'
  | 'cash_flow'
  | 'greeting'
  | 'help'
  | 'unknown';

export interface ParsedQuery {
  raw: string;
  normalized: string;
  intent: Intent;
  confidence: number;
  amountMinor: number | null;
  period: (DateRange & { label: string; explicit: boolean }) | null;
  categoryIds: string[];
  goalId: string | null;
  targetDate: ISODate | null;
  count: number | null;
}

interface Rule {
  intent: Intent;
  patterns: RegExp[];
  weight: number;
}

const RULES: Rule[] = [
  { intent: 'affordability', weight: 10, patterns: [/\bcan i (afford|buy|get)\b/, /\bafford\b/, /\bshould i (buy|get|spend)\b/, /\bis it ok(ay)? to (buy|spend)\b/] },
  { intent: 'next_debt_payment', weight: 9, patterns: [/\bnext (debt|loan)? ?(payment|repayment|instal+ment)\b/, /\bwhen (is|do) (my|i)? ?(next )?(debt|loan)? ?(payment|repayment|due)\b/, /\bwhen .*\b(pay|repay)\b.*\b(loan|debt)\b/, /\bupcoming (debt|loan) payment/, /\bdue (soon|next)\b/] },
  { intent: 'debt_cleared', weight: 9, patterns: [/\b(debt|loan)s?\b.*\b(clear|cleared|paid off|repaid|reduce|reduced)\b/, /\b(clear|cleared|repaid|paid off)\b.*\b(debt|loan)s?\b/, /\bhow much (debt|loan) (have|did) i (pay|repay|clear)/] },
  { intent: 'debt_total', weight: 8, patterns: [/\bhow much (do )?i owe\b/, /\btotal debts?\b/, /\bmy debts?\b/, /\bwhat do i owe\b/, /\boutstanding\b/, /\bhow much debt\b/, /\bdebt to income\b|\bdti\b/] },
  { intent: 'goal_saving', weight: 8, patterns: [/\bhow much should i save\b/, /\bsave (each|every|per|a) (month|week)\b/, /\b(goal|target)\b.*\bsave\b/, /\bsave\b.*\b(goal|target|by)\b/, /\bsaving(s)? (goal|plan)\b/] },
  { intent: 'biggest_expenses', weight: 8, patterns: [/\b(biggest|largest|highest|top|major) (expenses|spending|purchases|transactions)\b/, /\bshow (me )?(my )?(biggest|largest|top) /] },
  { intent: 'top_category', weight: 8, patterns: [/\b(which|what) category\b/, /\bconsumes? (the )?most\b/, /\bwhere (does|is) (all )?my money go/, /\bspend (the )?most on\b/, /\b(biggest|top|largest) (spending )?categor/] },
  { intent: 'category_spend', weight: 6, patterns: [/\b(spend|spent|spending|pay|paid) on\b/, /\bhow much (did|have) i (spend|spent) on\b/, /\bhow much .* on\b/] },
  { intent: 'income_total', weight: 6, patterns: [/\bhow much (did|have) i (earn|earned|make|made|receive|received|get paid)\b/, /\b(my )?(income|earnings|salary)\b/, /\bearn(ed)?\b/] },
  { intent: 'spend_total', weight: 5, patterns: [/\bhow much (did|have) i (spend|spent)\b/, /\b(total|my) (spending|expenses)\b/, /\bspent\b/, /\bexpenses?\b/] },
  { intent: 'cash_flow', weight: 6, patterns: [/\bcash ?flow\b/, /\bnet (income|savings|flow)\b/, /\bdid i save\b/, /\bsurplus\b|\bdeficit\b/] },
  { intent: 'balance', weight: 6, patterns: [/\b(my )?balance\b/, /\bhow much (money )?do i have\b/, /\bnet worth\b/, /\bhow much is in my\b/] },
  { intent: 'budget_status', weight: 6, patterns: [/\bbudgets?\b/, /\bover ?spend(ing)?\b/, /\bam i on track\b/] },
  { intent: 'health', weight: 7, patterns: [/\bhealth\b/, /\bfinancial (score|health)\b/, /\bhow am i doing\b/, /\bscore\b/] },
  { intent: 'greeting', weight: 2, patterns: [/^(hi|hello|hey|good (morning|afternoon|evening))\b/] },
  { intent: 'help', weight: 3, patterns: [/\bhelp\b/, /\bwhat can you (do|answer)\b/, /\bexamples?\b/] },
];

/** Common Nigerian & general synonyms → canonical category names. */
export const CATEGORY_SYNONYMS: Record<string, string[]> = {
  food: ['food', 'foodstuff', 'groceries', 'grocery', 'eating', 'eat', 'restaurant', 'lunch', 'dinner', 'breakfast', 'chop', 'market'],
  transport: ['transport', 'transportation', 'fuel', 'petrol', 'uber', 'bolt', 'bus', 'taxi', 'okada', 'keke', 'danfo', 'fare', 'car'],
  rent: ['rent', 'house rent', 'accommodation', 'housing'],
  electricity: ['electricity', 'light', 'nepa', 'phcn', 'power', 'prepaid meter', 'electric'],
  internet: ['internet', 'data', 'wifi', 'airtime', 'subscription', 'recharge'],
  education: ['education', 'school', 'school fees', 'fees', 'books', 'tuition', 'course'],
  health: ['health', 'hospital', 'medical', 'drugs', 'medicine', 'pharmacy', 'doctor'],
  family: ['family', 'parents', 'siblings', 'kids', 'children', 'wife', 'husband'],
  entertainment: ['entertainment', 'fun', 'movies', 'cinema', 'netflix', 'outing', 'party', 'games'],
  shopping: ['shopping', 'clothes', 'clothing', 'shoes', 'gadgets'],
  business: ['business', 'shop', 'stock', 'inventory'],
  salary: ['salary', 'wages', 'pay'],
  freelance: ['freelance', 'gig', 'contract', 'side hustle', 'hustle'],
  investment: ['investment', 'investments', 'dividends', 'interest', 'returns'],
  gift: ['gift', 'gifts', 'present'],
};

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[?!.,;:]+(\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function classifyIntent(normalized: string): { intent: Intent; confidence: number } {
  let best: Intent = 'unknown';
  let bestScore = 0;
  for (const rule of RULES) {
    let hits = 0;
    for (const p of rule.patterns) if (p.test(normalized)) hits++;
    if (!hits) continue;
    const score = rule.weight + hits;
    if (score > bestScore) {
      bestScore = score;
      best = rule.intent;
    }
  }
  return { intent: best, confidence: Math.min(1, bestScore / 12) };
}

/** Extracts an amount like ₦100,000 / N100k / 1.5m naira / 250000. Returns minor units. */
export function extractAmount(text: string, currency: string): number | null {
  const info = getCurrency(currency);
  const t = text.toLowerCase().replace(/,(?=\d{3})/g, '');
  const re = /(?:₦|\bn(?=\d)|\bngn\s?|\$|€|£)?\s?(\d+(?:\.\d+)?)\s?(k|m|bn|b|thousand|million|billion)?\b(?!\s?(?:days?|weeks?|months?|years?|%))/g;
  let m: RegExpExecArray | null;
  let best: number | null = null;
  while ((m = re.exec(t))) {
    const numStr = m[1];
    // Skip years like 2026 when used with month names or "in 2026".
    const before = t.slice(Math.max(0, m.index - 12), m.index);
    if (/^(19|20)\d{2}$/.test(numStr) && !m[2] && /(by|in|of|january|february|march|april|may|june|july|august|september|october|november|december)\s?$/.test(before)) continue;
    let v = parseFloat(numStr);
    const suf = m[2];
    if (suf === 'k' || suf === 'thousand') v *= 1e3;
    else if (suf === 'm' || suf === 'million') v *= 1e6;
    else if (suf === 'b' || suf === 'bn' || suf === 'billion') v *= 1e9;
    if (!Number.isFinite(v) || v <= 0) continue;
    const minor = Math.round(v * Math.pow(10, info.decimals));
    if (best == null || minor > best) best = minor;
  }
  return best;
}

export function extractCount(text: string): number | null {
  const m = /\b(top|biggest|largest|last)\s+(\d{1,2})\b/.exec(text);
  return m ? Math.min(50, parseInt(m[2], 10)) : null;
}

export function extractPeriod(
  text: string,
  ref: ISODate,
  weekStartsOn: 0 | 1 = 1,
): (DateRange & { label: string; explicit: boolean }) | null {
  const t = text;
  if (/\btoday\b/.test(t)) return { start: ref, end: ref, label: 'today', explicit: true };
  if (/\byesterday\b/.test(t)) {
    const y = addDays(ref, -1);
    return { start: y, end: y, label: 'yesterday', explicit: true };
  }
  if (/\blast week\b/.test(t)) {
    const s = addDays(startOfWeek(ref, weekStartsOn), -7);
    return { start: s, end: addDays(s, 6), label: 'last week', explicit: true };
  }
  if (/\bthis week\b/.test(t)) return { start: startOfWeek(ref, weekStartsOn), end: endOfWeek(ref, weekStartsOn), label: 'this week', explicit: true };
  const lastN = /\b(last|past)\s+(\d{1,2})\s+months?\b/.exec(t);
  if (lastN) {
    const n = Math.max(1, Math.min(24, parseInt(lastN[2], 10)));
    return { start: addMonths(startOfMonth(ref), -(n - 1)), end: endOfMonth(ref), label: `the last ${n} months`, explicit: true };
  }
  const lastNDays = /\b(last|past)\s+(\d{1,3})\s+days?\b/.exec(t);
  if (lastNDays) {
    const n = Math.max(1, Math.min(366, parseInt(lastNDays[2], 10)));
    return { start: addDays(ref, -(n - 1)), end: ref, label: `the last ${n} days`, explicit: true };
  }
  if (/\blast month\b|\bprevious month\b/.test(t)) {
    const s = addMonths(startOfMonth(ref), -1);
    return { start: s, end: endOfMonth(s), label: 'last month', explicit: true };
  }
  if (/\bthis month\b|\bso far this month\b|\bmonth to date\b/.test(t)) return { start: startOfMonth(ref), end: endOfMonth(ref), label: 'this month', explicit: true };
  if (/\blast year\b/.test(t)) {
    const y = Number(ref.slice(0, 4)) - 1;
    return { start: `${y}-01-01`, end: `${y}-12-31`, label: `${y}`, explicit: true };
  }
  if (/\bthis year\b|\byear to date\b|\bso far this year\b/.test(t)) return { start: startOfYear(ref), end: endOfYear(ref), label: 'this year', explicit: true };
  // Month names ("in march", "march 2025").
  for (let i = 0; i < 12; i++) {
    const name = MONTH_NAMES[i].toLowerCase();
    const re = new RegExp(`\\b(${name}|${name.slice(0, 3)})\\b(?:\\s+(\\d{4}))?`);
    const m = re.exec(t);
    if (m && !(name === 'may' && /\bmay i\b/.test(t))) {
      let y = m[2] ? parseInt(m[2], 10) : Number(ref.slice(0, 4));
      const candidate = fromParts(y, i + 1, 1);
      if (!m[2] && candidate > ref) y -= 1; // "in december" asked in March means last December
      const s = fromParts(y, i + 1, 1);
      return { start: s, end: endOfMonth(s), label: `${MONTH_NAMES[i]} ${y}`, explicit: true };
    }
  }
  return null;
}

/** Future target date for savings questions: "by december", "by 2026-12-20", "in 6 months". */
export function extractTargetDate(text: string, ref: ISODate): ISODate | null {
  const iso = /\b(\d{4}-\d{2}-\d{2})\b/.exec(text);
  if (iso && isValidISODate(iso[1])) return iso[1];
  const inN = /\bin\s+(\d{1,3})\s+(months?|weeks?|years?)\b/.exec(text);
  if (inN) {
    const n = parseInt(inN[1], 10);
    if (inN[2].startsWith('month')) return addMonths(ref, n);
    if (inN[2].startsWith('week')) return addDays(ref, n * 7);
    return addMonths(ref, n * 12);
  }
  const by = /\b(?:by|before|until|end of)\s+([a-z]+)(?:\s+(\d{1,2}))?(?:,?\s+(\d{4}))?/.exec(text);
  if (by) {
    const idx = MONTH_NAMES.findIndex((n) => n.toLowerCase() === by[1] || n.toLowerCase().slice(0, 3) === by[1]);
    if (idx >= 0) {
      let y = by[3] ? parseInt(by[3], 10) : Number(ref.slice(0, 4));
      let d = fromParts(y, idx + 1, 1);
      if (!by[3] && endOfMonth(d) < ref) y += 1;
      d = fromParts(y, idx + 1, 1);
      if (by[2]) {
        const day = Math.min(parseInt(by[2], 10), Number(endOfMonth(d).slice(8)));
        return fromParts(y, idx + 1, day);
      }
      return endOfMonth(d);
    }
    if (by[1] === 'year' || by[1] === 'the') return endOfYear(ref);
  }
  return null;
}

export function matchCategories(text: string, categories: { id: string; name: string; kind: string }[]): string[] {
  const found = new Set<string>();
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const c of categories) {
    const name = c.name.toLowerCase();
    const syn = CATEGORY_SYNONYMS[name] ?? [];
    for (const word of [name, ...syn]) {
      if (new RegExp(`\\b${escape(word)}\\b`).test(text)) {
        found.add(c.id);
        break;
      }
    }
  }
  return [...found];
}

const GOAL_STOPWORDS = new Set(['new', 'my', 'the', 'for', 'goal', 'fund', 'save', 'savings', 'buy', 'and', 'with', 'plan']);

export function matchGoal(text: string, goals: { id: string; name: string }[]): string | null {
  let best: { id: string; score: number } | null = null;
  for (const g of goals) {
    const name = g.name.toLowerCase().trim();
    if (!name) continue;
    let score = text.includes(name) ? 100 : 0;
    const words = name.split(/\s+/).filter((w) => w.length >= 3 && !GOAL_STOPWORDS.has(w));
    for (const w of words) if (new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}s?\\b`).test(text)) score += 10;
    if (score > 0 && (!best || score > best.score)) best = { id: g.id, score };
  }
  return best?.id ?? null;
}

export function parseQuery(
  raw: string,
  ctx: {
    today: ISODate;
    currency: string;
    weekStartsOn?: 0 | 1;
    categories: { id: string; name: string; kind: string }[];
    goals: { id: string; name: string }[];
  },
): ParsedQuery {
  const normalized = normalize(raw);
  let { intent, confidence } = classifyIntent(normalized);
  const categoryIds = matchCategories(normalized, ctx.categories);
  // "How much did I spend on food" → category spend even though generic spend rule also matches.
  if ((intent === 'spend_total' || intent === 'unknown') && categoryIds.length > 0 && /\b(spend|spent|spending|pay|paid|cost)\b/.test(normalized)) {
    intent = 'category_spend';
  }
  if (intent === 'income_total' && categoryIds.length > 0) {
    // keep income intent; category filter applies to income categories.
  }
  return {
    raw,
    normalized,
    intent,
    confidence,
    amountMinor: extractAmount(normalized, ctx.currency),
    period: extractPeriod(normalized, ctx.today, ctx.weekStartsOn ?? 1),
    categoryIds,
    goalId: matchGoal(normalized, ctx.goals),
    targetDate: extractTargetDate(normalized, ctx.today),
    count: extractCount(normalized),
  };
}
