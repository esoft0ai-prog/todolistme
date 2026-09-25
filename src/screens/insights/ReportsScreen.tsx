import React, { useState } from 'react';
import { View } from 'react-native';
import { formatDate, periodRange, PERIOD_PRESETS, type DateRange, type PeriodPreset } from '../../domain/dates';
import { buildHtmlReport } from '../../domain/exporters';
import { formatMoney, formatPercent } from '../../domain/money';
import type { RootScreenProps } from '../../navigation/types';
import { listAccounts } from '../../services/accounts';
import { categoryTotals, debtOverview, debtReductionSeries, series, totals } from '../../services/analytics';
import { budgetViews } from '../../services/budgets';
import { listCategories } from '../../services/categories';
import { listGoals } from '../../services/goals';
import { buildReportData, exportTransactionsCSV, monthlyComparison, yearlyComparison } from '../../services/reports';
import { saveToUserFolder, shareFile, timestampedName, writeTempFile } from '../../platform/files';
import { useCtx, useAppStore, usePrefs } from '../../state/appStore';
import { useQuery } from '../../state/useQuery';
import { BarChart, DonutChart, Legend, LineChart, ProgressRing } from '../../ui/components/charts';
import { chooseDialog, alertDialog } from '../../ui/components/feedback';
import { DateField, OptionSheet, Sheet } from '../../ui/components/forms';
import { Button, Card, Chip, ChipScroller, EmptyState, IconButton, ListRow, LoadingBlock, ProgressBar, Row, Screen, SectionHeader, Spacer, StatPill, Txt } from '../../ui/components/primitives';
import { useTheme } from '../../ui/theme';

type ReportKind = 'overview' | 'income' | 'expense' | 'cashflow' | 'debt' | 'budget' | 'savings' | 'category' | 'monthly' | 'yearly';
const KINDS: { key: ReportKind; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'income', label: 'Income' },
  { key: 'expense', label: 'Expenses' },
  { key: 'cashflow', label: 'Cash flow' },
  { key: 'category', label: 'Categories' },
  { key: 'debt', label: 'Debt' },
  { key: 'budget', label: 'Budgets' },
  { key: 'savings', label: 'Savings' },
  { key: 'monthly', label: 'Monthly comparison' },
  { key: 'yearly', label: 'Yearly comparison' },
];

export function ReportsScreen({ navigation }: RootScreenProps<'Reports'>) {
  const { c } = useTheme();
  const prefs = usePrefs();
  const ctx = useCtx();
  const [kind, setKind] = useState<ReportKind>('overview');
  const [preset, setPreset] = useState<PeriodPreset>('this_month');
  const [custom, setCustom] = useState<DateRange>(periodRange('this_month'));
  const [customOpen, setCustomOpen] = useState(false);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [sheet, setSheet] = useState<'account' | 'category' | null>(null);
  const [exporting, setExporting] = useState(false);
  const range = periodRange(preset, undefined, prefs.weekStartsOn, custom);
  const filter = { accountId: accountId ?? undefined, categoryIds: categoryId ? [categoryId] : undefined };
  const cur = prefs.baseCurrency;
  const m = (x: number) => formatMoney(x, cur);

  const lookups = useQuery(async (cx) => ({ accounts: await listAccounts(cx.db, { includeArchived: true }), categories: await listCategories(cx.db) }));
  const q = useQuery(
    async (cx) => {
      const base = { range, ...filter };
      const [t, s, exp, inc] = await Promise.all([
        totals(cx.db, base),
        series(cx.db, range, filter, prefs.weekStartsOn),
        categoryTotals(cx.db, range, 'expense', filter),
        categoryTotals(cx.db, range, 'income', filter),
      ]);
      const extra: Record<string, unknown> = {};
      if (kind === 'debt') {
        extra.debt = await debtOverview(cx);
        extra.debtSeries = await debtReductionSeries(cx, 12);
      }
      if (kind === 'budget') extra.budgets = await budgetViews(cx);
      if (kind === 'savings') extra.goals = await listGoals(cx);
      if (kind === 'monthly') extra.monthly = await monthlyComparison(cx, 12);
      if (kind === 'yearly') extra.yearly = await yearlyComparison(cx, 3);
      return { t, s, exp, inc, extra };
    },
    [range.start, range.end, accountId, categoryId, kind],
  );

  const exportReport = async () => {
    const choice = await chooseDialog('Export', 'Reports are generated on your phone. Choose a format:', [
      { text: 'Financial report (HTML — opens in any browser, printable)', value: 'html', variant: 'secondary' },
      { text: 'Transactions (CSV — Excel / Google Sheets)', value: 'csv', variant: 'secondary' },
      { text: 'Cancel', value: 'cancel', variant: 'ghost' },
    ]);
    if (choice !== 'html' && choice !== 'csv') return;
    const how = await chooseDialog('Save or share?', undefined, [
      { text: 'Share (WhatsApp, email, Drive…)', value: 'share', variant: 'primary' },
      { text: 'Save to a folder on this phone', value: 'save', variant: 'secondary' },
      { text: 'Cancel', value: 'cancel', variant: 'ghost' },
    ]);
    if (how !== 'share' && how !== 'save') return;
    setExporting(true);
    try {
      let content: string;
      let name: string;
      let mime: string;
      if (choice === 'html') {
        content = buildHtmlReport(await buildReportData(ctx, range, filter));
        name = timestampedName('finora-report', 'html');
        mime = 'text/html';
      } else {
        const r = await exportTransactionsCSV(ctx, { range, ...filter });
        content = r.csv;
        name = timestampedName('finora-transactions', 'csv');
        mime = 'text/csv';
      }
      if (how === 'share') await shareFile(writeTempFile(name, content), mime, 'Share Finora export');
      else {
        const saved = await saveToUserFolder(name, content, mime);
        if (saved) useAppStore.getState().showToast(`Saved ${name}`);
      }
    } catch (e) {
      await alertDialog('Export failed', e instanceof Error ? e.message : String(e), 'danger');
    } finally {
      setExporting(false);
    }
  };

  const d = q.data;
  const net = d ? d.t.incomeMinor + d.t.loanReceivedMinor - d.t.expenseMinor - d.t.debtRepaymentMinor : 0;
  const palette = (i: number, col?: string) => col || c.chart[i % c.chart.length];

  return (
    <Screen title="Reports & analytics" subtitle={`${formatDate(range.start)} – ${formatDate(range.end)}`} onBack={() => navigation.goBack()} right={<IconButton icon="share-outline" label="Export report" onPress={exportReport} />}>
      <ChipScroller>
        {KINDS.map((k) => (
          <Chip key={k.key} label={k.label} active={kind === k.key} onPress={() => setKind(k.key)} />
        ))}
      </ChipScroller>
      <Spacer h={8} />
      {kind !== 'monthly' && kind !== 'yearly' ? (
        <>
          <ChipScroller>
            {PERIOD_PRESETS.map((p) => (
              <Chip key={p.key} label={p.label} active={preset === p.key} onPress={() => (p.key === 'custom' ? setCustomOpen(true) : setPreset(p.key))} />
            ))}
          </ChipScroller>
          <Spacer h={8} />
          <ChipScroller>
            <Chip label={accountId ? (lookups.data?.accounts.find((a) => a.id === accountId)?.name ?? 'Account') : 'All accounts'} icon="wallet" active={!!accountId} onPress={() => setSheet('account')} />
            <Chip label={categoryId ? (lookups.data?.categories.find((x) => x.id === categoryId)?.name ?? 'Category') : 'All categories'} icon="pricetag" active={!!categoryId} onPress={() => setSheet('category')} />
          </ChipScroller>
        </>
      ) : null}
      <Spacer h={12} />
      {!d ? (
        <LoadingBlock />
      ) : (
        <>
          {kind === 'overview' || kind === 'cashflow' ? (
            <>
              <Row gap={10}>
                <StatPill label="Income" value={m(d.t.incomeMinor)} color={c.success} />
                <StatPill label="Expenses" value={m(d.t.expenseMinor)} color={c.danger} />
              </Row>
              <Spacer h={10} />
              <Row gap={10}>
                <StatPill label="Debt repaid" value={m(d.t.debtRepaymentMinor)} color={c.warning} />
                <StatPill label="Net cash flow" value={formatMoney(net, cur, { signed: true })} color={net >= 0 ? c.success : c.danger} />
              </Row>
              <Spacer h={10} />
              <Row gap={10}>
                <StatPill label="Loans received" value={m(d.t.loanReceivedMinor)} />
                <StatPill label="Savings rate" value={d.t.incomeMinor ? formatPercent(Math.max(0, d.t.incomeMinor - d.t.expenseMinor - d.t.debtRepaymentMinor) / d.t.incomeMinor) : '—'} color={c.accent} />
              </Row>
              <SectionHeader title="Income vs spending" />
              <Card>
                <BarChart data={d.s.map((p) => ({ label: p.label, values: [p.incomeMinor, p.expenseMinor + p.debtRepaymentMinor] }))} colors={[c.success, c.danger]} seriesLabels={['Income', 'Spending']} currency={cur} />
              </Card>
              <SectionHeader title="Net cash flow trend" />
              <Card>
                <LineChart points={d.s.map((p) => ({ label: p.label, value: p.netMinor }))} color={c.accent} currency={cur} allowNegative />
              </Card>
            </>
          ) : null}

          {kind === 'income' || kind === 'expense' || kind === 'category' || kind === 'overview' ? (
            <>
              {(kind === 'income' ? [['Income by category', d.inc] as const] : kind === 'expense' ? [['Spending by category', d.exp] as const] : [['Spending by category', d.exp] as const, ['Income by category', d.inc] as const]).map(([title, list]) => {
                const total = list.reduce((s, x) => s + x.totalMinor, 0);
                return (
                  <View key={title}>
                    <SectionHeader title={title} />
                    <Card>
                      {list.length ? (
                        <>
                          <Row gap={16}>
                            <DonutChart data={list.slice(0, 8).map((x, i) => ({ label: x.name, value: x.totalMinor, color: palette(i, x.color) }))} currency={cur} size={140} />
                            <Legend data={list.slice(0, 8).map((x, i) => ({ label: x.name, value: x.totalMinor, color: palette(i, x.color) }))} currency={cur} />
                          </Row>
                          <Spacer h={10} />
                          {list.map((x, i) => (
                            <View key={x.categoryId} style={{ marginBottom: 8 }}>
                              <Row justify="space-between">
                                <Txt v="small">{x.name}</Txt>
                                <Txt v="small" style={{ fontWeight: '700' }}>
                                  {m(x.totalMinor)} · {x.count}×
                                </Txt>
                              </Row>
                              <ProgressBar value={total ? x.totalMinor / total : 0} color={palette(i, x.color)} height={5} />
                            </View>
                          ))}
                        </>
                      ) : (
                        <Txt v="small" dim>
                          No records in this period.
                        </Txt>
                      )}
                    </Card>
                  </View>
                );
              })}
            </>
          ) : null}

          {kind === 'income' || kind === 'expense' ? (
            <>
              <SectionHeader title={kind === 'income' ? 'Income over time' : 'Spending over time'} />
              <Card>
                <LineChart points={d.s.map((p) => ({ label: p.label, value: kind === 'income' ? p.incomeMinor : p.expenseMinor }))} color={kind === 'income' ? c.success : c.danger} currency={cur} />
              </Card>
            </>
          ) : null}

          {kind === 'debt' && d.extra.debt ? <DebtReport data={d.extra as never} cur={cur} /> : null}
          {kind === 'budget' ? (
            (d.extra.budgets as Awaited<ReturnType<typeof budgetViews>>).length ? (
              (d.extra.budgets as Awaited<ReturnType<typeof budgetViews>>).map((b) => (
                <Card key={b.budget.id} style={{ marginBottom: 10 }} onPress={() => navigation.navigate('BudgetDetail', { id: b.budget.id })}>
                  <Row justify="space-between">
                    <Txt v="bodyStrong">{b.budget.name}</Txt>
                    <Txt v="small">
                      {m(b.status.spentMinor)} / {m(b.status.limitMinor)}
                    </Txt>
                  </Row>
                  <Spacer h={6} />
                  <ProgressBar value={b.status.percentUsed} color={b.status.state === 'exceeded' ? c.danger : b.status.state === 'ok' ? c.accent : c.warning} />
                  <Txt v="caption" dim style={{ marginTop: 6 }}>
                    {b.status.message}
                  </Txt>
                </Card>
              ))
            ) : (
              <EmptyState icon="pie-chart" title="No budgets" message="Create budgets to see adherence reports." />
            )
          ) : null}
          {kind === 'savings' ? (
            (d.extra.goals as Awaited<ReturnType<typeof listGoals>>).length ? (
              (d.extra.goals as Awaited<ReturnType<typeof listGoals>>).map((g) => (
                <Card key={g.goal.id} style={{ marginBottom: 10 }} onPress={() => navigation.navigate('GoalDetail', { id: g.goal.id })}>
                  <Row gap={12}>
                    <ProgressRing value={g.progress.percent} size={56} color={g.goal.color}>
                      <Txt v="caption">{Math.round(g.progress.percent * 100)}%</Txt>
                    </ProgressRing>
                    <View style={{ flex: 1 }}>
                      <Txt v="bodyStrong">{g.goal.name}</Txt>
                      <Txt v="caption" dim>
                        {formatMoney(g.progress.savedMinor, g.goal.currency)} of {formatMoney(g.goal.targetMinor, g.goal.currency)} · pace {formatMoney(g.progress.currentMonthlyRateMinor, g.goal.currency)}/mo
                      </Txt>
                    </View>
                  </Row>
                </Card>
              ))
            ) : (
              <EmptyState icon="flag" title="No savings goals" message="Create a goal to see savings reports." />
            )
          ) : null}
          {kind === 'monthly' ? <Comparison rows={(d.extra.monthly as Awaited<ReturnType<typeof monthlyComparison>>).map((x) => ({ label: x.label, income: x.incomeMinor, spend: x.expenseMinor + x.debtRepaymentMinor, net: x.netMinor }))} cur={cur} /> : null}
          {kind === 'yearly' ? <Comparison rows={(d.extra.yearly as Awaited<ReturnType<typeof yearlyComparison>>).map((x) => ({ label: String(x.year), income: x.incomeMinor, spend: x.expenseMinor + x.debtRepaymentMinor, net: x.netMinor }))} cur={cur} /> : null}

          <Spacer h={16} />
          <Button title="Export report" icon="download" variant="secondary" onPress={exportReport} loading={exporting} />
        </>
      )}

      <Sheet visible={customOpen} onClose={() => setCustomOpen(false)} title="Custom period">
        <DateField label="From" value={custom.start} onChange={(v) => v && setCustom((r) => ({ ...r, start: v }))} />
        <DateField label="To" value={custom.end} onChange={(v) => v && setCustom((r) => ({ ...r, end: v }))} error={custom.end < custom.start ? 'End date must be after the start date' : undefined} />
        <Button title="Apply" onPress={() => custom.end >= custom.start && (setPreset('custom'), setCustomOpen(false))} />
      </Sheet>
      <OptionSheet
        visible={sheet === 'account'}
        title="Account"
        value={accountId}
        options={(lookups.data?.accounts ?? []).map((a) => ({ value: a.id, label: a.name }))}
        onPick={(v) => (setAccountId(v), setSheet(null))}
        onClear={() => (setAccountId(null), setSheet(null))}
        onClose={() => setSheet(null)}
      />
      <OptionSheet
        visible={sheet === 'category'}
        title="Category"
        value={categoryId}
        searchable
        options={(lookups.data?.categories ?? []).map((x) => ({ value: x.id, label: x.name, subtitle: x.kind, icon: x.icon, color: x.color }))}
        onPick={(v) => (setCategoryId(v), setSheet(null))}
        onClear={() => (setCategoryId(null), setSheet(null))}
        onClose={() => setSheet(null)}
      />
    </Screen>
  );
}

function DebtReport({ data, cur }: { data: { debt: Awaited<ReturnType<typeof debtOverview>>; debtSeries: Awaited<ReturnType<typeof debtReductionSeries>> }; cur: string }) {
  const { c } = useTheme();
  const o = data.debt;
  return (
    <>
      <Row gap={10}>
        <StatPill label="Outstanding" value={formatMoney(o.totalOutstandingMinor, cur)} color={c.danger} />
        <StatPill label="Monthly obligation" value={formatMoney(o.monthlyObligationMinor, cur)} />
      </Row>
      <Spacer h={10} />
      <Row gap={10}>
        <StatPill label="Debt-to-income" value={o.dti == null ? '—' : formatPercent(o.dti)} />
        <StatPill label="Overdue debts" value={String(o.overdueCount)} color={o.overdueCount ? c.danger : undefined} />
      </Row>
      <SectionHeader title="Debt balance (12 months)" />
      <Card>
        <LineChart points={data.debtSeries.map((p) => ({ label: p.label, value: p.outstandingMinor }))} color={c.danger} currency={cur} />
      </Card>
      <SectionHeader title="By lender" />
      <Card padded={false} style={{ paddingHorizontal: 14 }}>
        {o.debts.length ? (
          o.debts.map((d) => (
            <ListRow key={d.debt.id} icon="card" iconColor={c.danger} title={d.debt.lenderName} subtitle={`${Math.round(d.summary.progress * 100)}% repaid · ${d.summary.paymentsRemaining} left`} right={formatMoney(d.summary.outstandingMinor, d.debt.currency)} />
          ))
        ) : (
          <Txt v="small" dim style={{ paddingVertical: 14 }}>
            No active debts.
          </Txt>
        )}
      </Card>
    </>
  );
}

function Comparison({ rows, cur }: { rows: { label: string; income: number; spend: number; net: number }[]; cur: string }) {
  const { c } = useTheme();
  return (
    <>
      <Card>
        <BarChart data={rows.map((r) => ({ label: r.label, values: [r.income, r.spend] }))} colors={[c.success, c.danger]} seriesLabels={['Income', 'Spending']} currency={cur} />
      </Card>
      <Spacer h={12} />
      <Card padded={false} style={{ paddingHorizontal: 14 }}>
        {[...rows].reverse().map((r, i, arr) => {
          const prev = arr[i + 1];
          const change = prev && prev.spend ? (r.spend - prev.spend) / prev.spend : null;
          return (
            <ListRow
              key={r.label}
              title={r.label}
              subtitle={`In ${formatMoney(r.income, cur, { compact: true })} · Out ${formatMoney(r.spend, cur, { compact: true })}${change != null ? ` · spending ${change >= 0 ? '▲' : '▼'} ${formatPercent(Math.abs(change))}` : ''}`}
              right={formatMoney(r.net, cur, { signed: true })}
              rightColor={r.net >= 0 ? c.success : c.danger}
            />
          );
        })}
      </Card>
    </>
  );
}
