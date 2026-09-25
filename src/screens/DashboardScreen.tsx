import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import React, { useState } from 'react';
import { View } from 'react-native';
import { formatDate, periodRange, PERIOD_PRESETS, relativeDays, today, type DateRange, type PeriodPreset } from '../domain/dates';
import { describeDTI } from '../domain/debt';
import { formatMoney, formatPercent } from '../domain/money';
import type { RootStackParamList } from '../navigation/types';
import { dashboard } from '../services/analytics';
import { useAppStore, usePrefs } from '../state/appStore';
import { useQuery } from '../state/useQuery';
import { BarChart, DonutChart, healthColor, Legend, LineChart, ProgressRing } from '../ui/components/charts';
import { DateField, Sheet } from '../ui/components/forms';
import {
  AnimatedMoney,
  Badge,
  Button as Btn,
  Card,
  Chip,
  ChipScroller,
  EmptyState,
  ErrorBlock,
  Fab,
  GradientCard,
  Icon,
  IconButton,
  ListRow,
  LoadingBlock,
  ProgressBar,
  Row,
  Screen,
  SectionHeader,
  Spacer,
  StatPill,
  Txt,
} from '../ui/components/primitives';
import { toneColor, useTheme } from '../ui/theme';

type Nav = NativeStackNavigationProp<RootStackParamList>;

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

export function DashboardScreen() {
  const nav = useNavigation<Nav>();
  const { c } = useTheme();
  const prefs = usePrefs();
  const unread = useAppStore((s) => s.unread);
  const [preset, setPreset] = useState<PeriodPreset>('this_month');
  const [custom, setCustom] = useState<DateRange>(periodRange('this_month'));
  const [customOpen, setCustomOpen] = useState(false);
  const range = periodRange(preset, undefined, prefs.weekStartsOn, custom);
  const q = useQuery((ctx) => dashboard(ctx, range), [range.start, range.end]);
  const d = q.data;
  const cur = prefs.baseCurrency;
  const fmt = (m: number) => formatMoney(m, cur);

  return (
    <View style={{ flex: 1 }}>
      <Screen
        title={greeting()}
        subtitle={formatDate(today(), 'long')}
        right={
          <Row gap={8}>
            <IconButton icon="search" label="Search" onPress={() => nav.navigate('Search')} />
            <IconButton icon="notifications-outline" label={`Notifications, ${unread} unread`} badge={unread} onPress={() => nav.navigate('Notifications')} />
          </Row>
        }
        refreshing={q.loading && !!d}
        onRefresh={q.reload}
      >
        <ChipScroller>
          {PERIOD_PRESETS.map((p) => (
            <Chip
              key={p.key}
              label={p.key === 'custom' && preset === 'custom' ? `${formatDate(custom.start, 'short')} – ${formatDate(custom.end, 'short')}` : p.label}
              active={preset === p.key}
              onPress={() => (p.key === 'custom' ? setCustomOpen(true) : setPreset(p.key))}
            />
          ))}
        </ChipScroller>
        <Spacer h={14} />

        {!d && q.loading ? <LoadingBlock lines={4} /> : null}
        {q.error && !d ? <ErrorBlock message={q.error} onRetry={q.reload} /> : null}

        {d ? (
          <>
            {prefs.demoDataLoaded ? (
              <Card tone="warning" style={{ marginBottom: 12 }} onPress={() => nav.navigate('Settings')} accessibilityLabel="Sample data is loaded. Open settings to remove it.">
                <Row gap={10}>
                  <Icon name="flask" size={18} color={c.warning} />
                  <Txt v="small" style={{ flex: 1 }}>
                    Sample data is loaded (marked “sample”). Remove it any time in Settings.
                  </Txt>
                </Row>
              </Card>
            ) : null}

            <GradientCard>
              <Txt v="label" color="rgba(255,255,255,0.8)">
                Total balance
              </Txt>
              <AnimatedMoney minor={d.balances.totalMinor} currency={cur} color="#fff" />
              <Row gap={16} style={{ marginTop: 10, flexWrap: 'wrap' }}>
                <View>
                  <Txt v="caption" color="rgba(255,255,255,0.75)">
                    Spendable
                  </Txt>
                  <Txt v="bodyStrong" color="#fff">
                    {fmt(d.balances.spendableMinor)}
                  </Txt>
                </View>
                <View>
                  <Txt v="caption" color="rgba(255,255,255,0.75)">
                    Savings
                  </Txt>
                  <Txt v="bodyStrong" color="#fff">
                    {fmt(d.balances.savingsMinor)}
                  </Txt>
                </View>
                <View>
                  <Txt v="caption" color="rgba(255,255,255,0.75)">
                    Net worth
                  </Txt>
                  <Txt v="bodyStrong" color="#fff">
                    {fmt(d.balances.netWorthMinor)}
                  </Txt>
                </View>
              </Row>
              <Row gap={8} style={{ marginTop: 14 }}>
                <Btn title="Add" icon="add" small variant="glass" onPress={() => nav.navigate('TransactionForm')} style={{ flex: 1 }} />
                <Btn title="Transfer" icon="swap-horizontal" small variant="glass" onPress={() => nav.navigate('TransactionForm', { type: 'transfer' })} style={{ flex: 1 }} />
                <Btn title="Accounts" icon="wallet" small variant="glass" onPress={() => nav.navigate('Accounts')} style={{ flex: 1 }} />
              </Row>
            </GradientCard>

            <Spacer h={12} />
            <Row gap={10}>
              <Card style={{ flex: 1 }} padded={false} onPress={() => nav.navigate('Tabs', { screen: 'Activity', params: { type: 'income' } })} accessibilityLabel={`Income ${fmt(d.totals.incomeMinor)}`}>
                <StatPill label="Income" value={fmt(d.totals.incomeMinor)} color={c.success} icon="arrow-down" />
              </Card>
              <Card style={{ flex: 1 }} padded={false} onPress={() => nav.navigate('Tabs', { screen: 'Activity', params: { type: 'expense' } })} accessibilityLabel={`Expenses ${fmt(d.totals.expenseMinor)}`}>
                <StatPill label="Expenses" value={fmt(d.totals.expenseMinor)} color={c.danger} icon="arrow-up" />
              </Card>
            </Row>
            <Spacer h={10} />
            <Row gap={10}>
              <Card style={{ flex: 1 }} padded={false} onPress={() => nav.navigate('Reports')} accessibilityLabel={`Net cash flow ${fmt(d.netCashFlowMinor)}`}>
                <StatPill
                  label="Net cash flow"
                  value={formatMoney(d.netCashFlowMinor, cur, { signed: true })}
                  color={d.netCashFlowMinor >= 0 ? c.success : c.danger}
                  icon="pulse"
                />
              </Card>
              <Card style={{ flex: 1 }} padded={false} onPress={() => nav.navigate('Tabs', { screen: 'Plan', params: { tab: 'budgets' } })} accessibilityLabel={`Budget remaining ${fmt(d.budgetRemainingMinor)}`}>
                <StatPill label="Budget left" value={d.budgetLimitMinor ? fmt(d.budgetRemainingMinor) : 'No budgets'} color={c.primary} icon="pie-chart" />
              </Card>
            </Row>
            {d.previousTotals.expenseMinor > 0 ? (
              <Txt v="caption" faint style={{ marginTop: 8 }}>
                Spending is {d.totals.expenseMinor >= d.previousTotals.expenseMinor ? 'up' : 'down'}{' '}
                {formatPercent(Math.abs(d.totals.expenseMinor - d.previousTotals.expenseMinor) / d.previousTotals.expenseMinor)} vs the previous period.
              </Txt>
            ) : null}

            {/* Health score */}
            <SectionHeader title="Financial health" action="Details" onAction={() => nav.navigate('Health')} />
            <Card onPress={() => nav.navigate('Health')} accessibilityLabel={`Financial health score ${d.health.total} out of 100, ${d.health.grade}`}>
              <Row gap={16}>
                <ProgressRing value={d.health.total / 100} size={84} stroke={9} color={healthColor(c, d.health.total)} label="Financial health score">
                  <Txt v="h2">{d.health.total}</Txt>
                  <Txt v="caption" faint>
                    /100
                  </Txt>
                </ProgressRing>
                <View style={{ flex: 1, gap: 6 }}>
                  <Row gap={8}>
                    <Txt v="h3">{d.health.grade}</Txt>
                    {d.health.change.delta !== 0 && d.health.previousMonth ? (
                      <Badge label={`${d.health.change.delta > 0 ? '+' : ''}${d.health.change.delta} vs last month`} color={d.health.change.delta > 0 ? c.success : c.danger} />
                    ) : null}
                  </Row>
                  {d.health.components.map((comp) => (
                    <Row key={comp.key} gap={8}>
                      <Txt v="caption" dim style={{ width: 118 }} numberOfLines={1}>
                        {comp.label}
                      </Txt>
                      <View style={{ flex: 1 }}>
                        <ProgressBar value={comp.score / comp.max} height={6} color={healthColor(c, (comp.score / comp.max) * 100)} />
                      </View>
                      <Txt v="caption" style={{ width: 38, textAlign: 'right' }}>
                        {Math.round(comp.score)}/{comp.max}
                      </Txt>
                    </Row>
                  ))}
                </View>
              </Row>
            </Card>

            {/* Debt */}
            <SectionHeader title="Debt" action="Manage" onAction={() => nav.navigate('Tabs', { screen: 'Debts' })} />
            {d.debt.debts.length === 0 ? (
              <Card>
                <Row gap={10}>
                  <Icon name="checkmark-done-circle" size={22} color={c.success} />
                  <Txt v="small" dim style={{ flex: 1 }}>
                    No active debts. Add a loan to track repayments and get reminders.
                  </Txt>
                </Row>
              </Card>
            ) : (
              <Card onPress={() => nav.navigate('Tabs', { screen: 'Debts' })} tone={d.debt.overdueCount ? 'danger' : undefined} accessibilityLabel={`Total debt ${fmt(d.debt.totalOutstandingMinor)}`}>
                <Row justify="space-between" align="flex-start">
                  <View>
                    <Txt v="caption" dim>
                      Total debt
                    </Txt>
                    <Txt v="h2" color={c.danger}>
                      {fmt(d.debt.totalOutstandingMinor)}
                    </Txt>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Txt v="caption" dim>
                      Monthly obligation
                    </Txt>
                    <Txt v="bodyStrong">{fmt(d.debt.monthlyObligationMinor)}</Txt>
                  </View>
                </Row>
                <Row gap={8} style={{ marginTop: 10 }}>
                  <Txt v="caption" dim>
                    Debt-to-income:
                  </Txt>
                  <Txt v="caption" color={toneColor(c, describeDTI(d.debt.dti).tone)} style={{ fontWeight: '700' }}>
                    {d.debt.dti == null ? '—' : formatPercent(d.debt.dti)} · {describeDTI(d.debt.dti).label}
                  </Txt>
                </Row>
                {d.debt.overdueCount ? (
                  <Row gap={6} style={{ marginTop: 8 }}>
                    <Icon name="alert-circle" size={16} color={c.danger} />
                    <Txt v="caption" color={c.danger}>
                      {d.debt.overdueCount} debt{d.debt.overdueCount > 1 ? 's have' : ' has'} overdue payments
                    </Txt>
                  </Row>
                ) : null}
                {d.debtSeries.some((p) => p.outstandingMinor > 0) ? (
                  <View style={{ marginTop: 12 }}>
                    <Txt v="caption" faint style={{ marginBottom: 4 }}>
                      Debt reduction (last 6 months)
                    </Txt>
                    <LineChart points={d.debtSeries.map((p) => ({ label: p.label, value: p.outstandingMinor }))} color={c.danger} height={110} currency={cur} />
                  </View>
                ) : null}
              </Card>
            )}

            {/* Upcoming */}
            <SectionHeader title="Upcoming payments" action="Calendar" onAction={() => nav.navigate('Calendar')} />
            <Card padded={false} style={{ paddingHorizontal: 16 }}>
              {d.upcoming.filter((u) => u.amountMinor).length === 0 ? (
                <Txt v="small" dim style={{ paddingVertical: 16 }}>
                  Nothing due in the next 30 days.
                </Txt>
              ) : (
                d.upcoming
                  .filter((u) => u.amountMinor)
                  .slice(0, 5)
                  .map((u) => (
                    <ListRow
                      key={u.id}
                      icon={u.kind === 'debt' ? 'card' : u.kind === 'income' ? 'arrow-down-circle' : u.kind === 'goal' ? 'flag' : 'receipt'}
                      iconColor={u.overdue ? c.danger : u.kind === 'income' ? c.success : c.warning}
                      title={u.title}
                      subtitle={`${formatDate(u.date)} · ${u.overdue ? 'overdue' : relativeDays(u.date)}`}
                      right={formatMoney(u.amountMinor!, u.currency)}
                      rightColor={u.overdue ? c.danger : undefined}
                      badge={u.overdue ? 'Overdue' : undefined}
                      onPress={() => (u.kind === 'debt' && u.entityId ? nav.navigate('DebtDetail', { id: u.entityId }) : nav.navigate('Calendar'))}
                    />
                  ))
              )}
            </Card>

            {/* Charts */}
            <SectionHeader title="Income vs expenses" action="Reports" onAction={() => nav.navigate('Reports')} />
            <Card>
              {d.series.some((p) => p.incomeMinor || p.expenseMinor) ? (
                <BarChart
                  data={d.series.map((p) => ({ label: p.label, values: [p.incomeMinor, p.expenseMinor + p.debtRepaymentMinor] }))}
                  colors={[c.success, c.danger]}
                  seriesLabels={['Income', 'Spending']}
                  currency={cur}
                />
              ) : (
                <EmptyState icon="bar-chart" title="No activity yet" message="Add income and expenses to see your trends." action="Add transaction" onAction={() => nav.navigate('TransactionForm')} />
              )}
            </Card>

            {d.series.length > 1 && d.series.some((p) => p.netMinor) ? (
              <>
                <SectionHeader title="Cash flow" />
                <Card>
                  <LineChart points={d.series.map((p) => ({ label: p.label, value: p.netMinor }))} color={c.accent} currency={cur} allowNegative />
                </Card>
              </>
            ) : null}

            <SectionHeader title="Spending by category" />
            <Card>
              {d.categories.length ? (
                <Row gap={16} align="center">
                  <DonutChart data={d.categories.slice(0, 8).map((x, i) => ({ label: x.name, value: x.totalMinor, color: x.color || c.chart[i % c.chart.length] }))} currency={cur} size={140} centerLabel="Spent" />
                  <Legend data={d.categories.slice(0, 8).map((x, i) => ({ label: x.name, value: x.totalMinor, color: x.color || c.chart[i % c.chart.length] }))} currency={cur} max={5} />
                </Row>
              ) : (
                <Txt v="small" dim>
                  No spending in this period.
                </Txt>
              )}
            </Card>

            <SectionHeader title="Savings progress" action="Goals" onAction={() => nav.navigate('Tabs', { screen: 'Plan', params: { tab: 'goals' } })} />
            <Card>
              {d.goals.length === 0 ? (
                <EmptyState icon="flag" title="No savings goals" message="Set a goal like a new laptop or an emergency fund." action="Create goal" onAction={() => nav.navigate('GoalForm')} />
              ) : (
                d.goals.slice(0, 4).map((g) => (
                  <View key={g.goal.id} style={{ marginBottom: 12 }}>
                    <Row justify="space-between">
                      <Txt v="bodyStrong" numberOfLines={1} style={{ flex: 1 }}>
                        {g.goal.name}
                      </Txt>
                      <Txt v="caption" dim>
                        {formatMoney(g.progress.savedMinor, g.goal.currency, { compact: true })} / {formatMoney(g.goal.targetMinor, g.goal.currency, { compact: true })}
                      </Txt>
                    </Row>
                    <Spacer h={6} />
                    <ProgressBar value={g.progress.percent} color={g.goal.color} />
                  </View>
                ))
              )}
            </Card>

            {d.reminders.length ? (
              <>
                <SectionHeader title="Upcoming reminders" action="All" onAction={() => nav.navigate('Notifications')} />
                <Card padded={false} style={{ paddingHorizontal: 16 }}>
                  {d.reminders.map((r) => (
                    <ListRow key={r.key} icon="alarm" iconColor={c.primary} title={r.title} subtitle={`${new Date(r.fireAt).toLocaleString()}`} />
                  ))}
                </Card>
              </>
            ) : null}

            <Spacer h={16} />
            <Card onPress={() => nav.navigate('Assistant')} accessibilityLabel="Open financial assistant">
              <Row gap={12}>
                <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: c.primarySoft, alignItems: 'center', justifyContent: 'center' }}>
                  <Icon name="sparkles" size={22} color={c.primary} />
                </View>
                <View style={{ flex: 1 }}>
                  <Txt v="bodyStrong">Ask Finora</Txt>
                  <Txt v="caption" dim>
                    “Can I afford a {formatMoney(10_000_000, cur)} phone?” — answered privately on your phone.
                  </Txt>
                </View>
                <Icon name="chevron-forward" size={18} color={c.textFaint} />
              </Row>
            </Card>
          </>
        ) : null}
      </Screen>
      <Fab label="Add transaction" onPress={() => nav.navigate('TransactionForm')} />
      <Sheet visible={customOpen} onClose={() => setCustomOpen(false)} title="Custom period">
        <DateField label="From" value={custom.start} onChange={(v) => v && setCustom((r) => ({ ...r, start: v }))} />
        <DateField label="To" value={custom.end} onChange={(v) => v && setCustom((r) => ({ ...r, end: v }))} error={custom.end < custom.start ? 'End date must be after the start date' : undefined} />
        <Btn
          title="Apply"
          onPress={() => {
            if (custom.end < custom.start) return;
            setPreset('custom');
            setCustomOpen(false);
          }}
        />
      </Sheet>
    </View>
  );
}
