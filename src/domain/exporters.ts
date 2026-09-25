import { formatDate } from './dates';
import { formatMoney, formatPercent, toMajor } from './money';
import type { ISODate } from './types';

/** Escapes a CSV cell and neutralises spreadsheet formula injection (=, +, -, @, tab, CR). */
export function csvCell(value: unknown): string {
  let s = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCSV(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(csvCell).join(',')];
  for (const r of rows) lines.push(r.map(csvCell).join(','));
  // BOM so Excel opens UTF-8 (₦) correctly.
  return `﻿${lines.join('\r\n')}\r\n`;
}

export interface CsvTransaction {
  date: ISODate;
  time: string | null;
  type: string;
  amountMinor: number;
  currency: string;
  baseAmountMinor: number;
  baseCurrency: string;
  account: string;
  toAccount: string | null;
  category: string | null;
  description: string;
  paymentMethod: string | null;
  tags: string[];
  notes: string | null;
  reference: string | null;
  debt: string | null;
  goal: string | null;
}

export function transactionsToCSV(rows: CsvTransaction[]): string {
  const headers = [
    'Date',
    'Time',
    'Type',
    'Amount',
    'Currency',
    'Amount (base)',
    'Base currency',
    'Account',
    'To account',
    'Category',
    'Description',
    'Payment method',
    'Tags',
    'Notes',
    'Reference',
    'Debt',
    'Savings goal',
  ];
  return toCSV(
    headers,
    rows.map((r) => [
      r.date,
      r.time ?? '',
      r.type,
      toMajor(r.amountMinor, r.currency),
      r.currency,
      toMajor(r.baseAmountMinor, r.baseCurrency),
      r.baseCurrency,
      r.account,
      r.toAccount ?? '',
      r.category ?? '',
      r.description,
      r.paymentMethod ?? '',
      r.tags.join('; '),
      r.notes ?? '',
      r.reference ?? '',
      r.debt ?? '',
      r.goal ?? '',
    ]),
  );
}

export function escapeHtml(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface ReportData {
  title: string;
  generatedAt: string;
  currency: string;
  range: { start: ISODate; end: ISODate };
  totals: { incomeMinor: number; expenseMinor: number; debtRepaymentMinor: number; loanReceivedMinor: number; savingsNetMinor: number };
  balances: { name: string; type: string; balanceMinor: number; currency: string }[];
  categories: { name: string; totalMinor: number }[];
  incomeCategories: { name: string; totalMinor: number }[];
  months: { key: string; label: string; incomeMinor: number; expenseMinor: number }[];
  debts: { lender: string; outstandingMinor: number; currency: string; next: string; status: string }[];
  goals: { name: string; savedMinor: number; targetMinor: number; currency: string; percent: number; deadline: string }[];
  budgets: { name: string; spentMinor: number; limitMinor: number; state: string }[];
  health: { total: number; grade: string; components: { label: string; score: number; max: number; explanation: string }[] } | null;
  topExpenses: { date: ISODate; description: string; category: string; amountMinor: number }[];
}

/** Human-readable, printable, self-contained HTML financial report (no external resources). */
export function buildHtmlReport(r: ReportData): string {
  const m = (v: number, c = r.currency) => escapeHtml(formatMoney(v, c));
  const net = r.totals.incomeMinor + r.totals.loanReceivedMinor - r.totals.expenseMinor - r.totals.debtRepaymentMinor;
  const totalExp = r.categories.reduce((s, c) => s + c.totalMinor, 0);
  const row = (cells: string[]) => `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
  const table = (head: string[], rows: string[][]) =>
    rows.length
      ? `<table><thead><tr>${head.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(row).join('')}</tbody></table>`
      : '<p class="muted">No records.</p>';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${escapeHtml(r.title)}</title>
<style>
body{font-family:system-ui,-apple-system,Roboto,sans-serif;color:#111827;margin:24px;line-height:1.45}
h1{margin:0 0 4px;font-size:24px}h2{margin-top:28px;font-size:18px;border-bottom:2px solid #6366f1;padding-bottom:4px}
.muted{color:#6b7280}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-top:16px}
.card{border:1px solid #e5e7eb;border-radius:10px;padding:12px}.card b{display:block;font-size:18px;margin-top:4px}
table{width:100%;border-collapse:collapse;margin-top:8px;font-size:14px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #e5e7eb}
th{background:#f3f4f6}td:last-child,th:last-child{text-align:right}.pos{color:#059669}.neg{color:#dc2626}
@media print{body{margin:0}}
</style></head><body>
<h1>${escapeHtml(r.title)}</h1>
<div class="muted">Period: ${escapeHtml(formatDate(r.range.start))} – ${escapeHtml(formatDate(r.range.end))} · Generated ${escapeHtml(new Date(r.generatedAt).toLocaleString())} · Created offline with Finora</div>
<div class="grid">
<div class="card">Income<b class="pos">${m(r.totals.incomeMinor)}</b></div>
<div class="card">Expenses<b class="neg">${m(r.totals.expenseMinor)}</b></div>
<div class="card">Debt repayments<b>${m(r.totals.debtRepaymentMinor)}</b></div>
<div class="card">Loans received<b>${m(r.totals.loanReceivedMinor)}</b></div>
<div class="card">Net cash flow<b class="${net >= 0 ? 'pos' : 'neg'}">${escapeHtml(formatMoney(net, r.currency, { signed: true }))}</b></div>
<div class="card">Saved to goals (net)<b>${m(r.totals.savingsNetMinor)}</b></div>
</div>
${r.health ? `<h2>Financial Health Score: ${r.health.total}/100 (${escapeHtml(r.health.grade)})</h2>${table(['Component', 'Explanation', 'Score'], r.health.components.map((c) => [escapeHtml(c.label), escapeHtml(c.explanation), `${Math.round(c.score)}/${c.max}`]))}` : ''}
<h2>Accounts</h2>
${table(['Account', 'Type', 'Balance'], r.balances.map((b) => [escapeHtml(b.name), escapeHtml(b.type.replace('_', ' ')), m(b.balanceMinor, b.currency)]))}
<h2>Spending by category</h2>
${table(['Category', 'Share', 'Amount'], r.categories.map((c) => [escapeHtml(c.name), totalExp ? formatPercent(c.totalMinor / totalExp, 1) : '—', m(c.totalMinor)]))}
<h2>Income by category</h2>
${table(['Category', 'Amount'], r.incomeCategories.map((c) => [escapeHtml(c.name), m(c.totalMinor)]))}
<h2>Monthly comparison</h2>
${table(['Month', 'Income', 'Expenses', 'Net'], r.months.map((x) => [escapeHtml(x.label), m(x.incomeMinor), m(x.expenseMinor), escapeHtml(formatMoney(x.incomeMinor - x.expenseMinor, r.currency, { signed: true }))]))}
<h2>Largest expenses</h2>
${table(['Date', 'Description', 'Category', 'Amount'], r.topExpenses.map((t) => [escapeHtml(formatDate(t.date)), escapeHtml(t.description), escapeHtml(t.category), m(t.amountMinor)]))}
<h2>Debts</h2>
${table(['Lender', 'Status', 'Next payment', 'Outstanding'], r.debts.map((d) => [escapeHtml(d.lender), escapeHtml(d.status), escapeHtml(d.next), m(d.outstandingMinor, d.currency)]))}
<h2>Budgets (current period)</h2>
${table(['Budget', 'Status', 'Spent / Limit'], r.budgets.map((b) => [escapeHtml(b.name), escapeHtml(b.state.replace('_', ' ')), `${m(b.spentMinor)} / ${m(b.limitMinor)}`]))}
<h2>Savings goals</h2>
${table(['Goal', 'Deadline', 'Progress', 'Saved / Target'], r.goals.map((g) => [escapeHtml(g.name), escapeHtml(g.deadline), formatPercent(g.percent), `${m(g.savedMinor, g.currency)} / ${m(g.targetMinor, g.currency)}`]))}
<p class="muted" style="margin-top:32px">This report was generated on-device. Finora never sends your financial data anywhere.</p>
</body></html>`;
}
