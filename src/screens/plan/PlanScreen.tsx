import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { formatDate } from '../../domain/dates';
import { formatMoney } from '../../domain/money';
import type { RootStackParamList, TabParamList } from '../../navigation/types';
import { budgetViews } from '../../services/budgets';
import { listGoals } from '../../services/goals';
import { usePrefs } from '../../state/appStore';
import { useQuery } from '../../state/useQuery';
import { ProgressRing } from '../../ui/components/charts';
import { Badge, Card, EmptyState, Fab, Icon, LoadingBlock, ProgressBar, Row, Screen, Segmented, Spacer, Txt } from '../../ui/components/primitives';
import { useTheme } from '../../ui/theme';

type Nav = NativeStackNavigationProp<RootStackParamList>;

export function budgetStateColor(c: ReturnType<typeof useTheme>['c'], state: string): string {
  return state === 'exceeded' ? c.danger : state === 'at_risk' ? c.warning : state === 'warning' ? c.warning : c.accent;
}

export function PlanScreen() {
  const nav = useNavigation<Nav>();
  const route = useRoute<RouteProp<TabParamList, 'Plan'>>();
  const { c } = useTheme();
  const prefs = usePrefs();
  const [tab, setTab] = useState<'budgets' | 'goals'>(route.params?.tab ?? 'budgets');
  useEffect(() => {
    if (route.params?.tab) setTab(route.params.tab);
  }, [route.params?.tab]);
  const budgets = useQuery((ctx) => budgetViews(ctx, { includeArchived: false }));
  const goals = useQuery((ctx) => listGoals(ctx, { includeArchived: false }));
  const cur = prefs.baseCurrency;

  return (
    <View style={{ flex: 1 }}>
      <Screen title="Plan" subtitle="Budgets and savings goals" onRefresh={() => (budgets.reload(), goals.reload())} refreshing={false}>
        <Segmented value={tab} onChange={setTab} options={[{ value: 'budgets', label: 'Budgets' }, { value: 'goals', label: 'Savings goals' }]} />
        <Spacer h={14} />
        {tab === 'budgets' ? (
          !budgets.data ? (
            <LoadingBlock />
          ) : budgets.data.length === 0 ? (
            <EmptyState icon="pie-chart" title="No budgets yet" message="Set spending limits like Food ₦50,000 or Transport ₦30,000. Finora warns you early if you are spending too fast." action="Create budget" onAction={() => nav.navigate('BudgetForm')} />
          ) : (
            <>
              <Card style={{ marginBottom: 12 }}>
                <Row justify="space-between">
                  <View>
                    <Txt v="caption" dim>
                      Total budgeted
                    </Txt>
                    <Txt v="h3">{formatMoney(budgets.data.reduce((s, b) => s + b.status.limitMinor, 0), cur)}</Txt>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Txt v="caption" dim>
                      Spent
                    </Txt>
                    <Txt v="h3">{formatMoney(budgets.data.reduce((s, b) => s + b.status.spentMinor, 0), cur)}</Txt>
                  </View>
                </Row>
              </Card>
              {budgets.data.map((b) => {
                const s = b.status;
                const col = budgetStateColor(c, s.state);
                return (
                  <Card key={b.budget.id} style={{ marginBottom: 12 }} tone={s.state === 'exceeded' ? 'danger' : s.state === 'at_risk' ? 'warning' : undefined} onPress={() => nav.navigate('BudgetDetail', { id: b.budget.id })} accessibilityLabel={`${b.budget.name} budget. ${s.message}`}>
                    <Row justify="space-between">
                      <View style={{ flex: 1 }}>
                        <Row gap={6}>
                          <Txt v="bodyStrong" numberOfLines={1} style={{ flexShrink: 1 }}>
                            {b.budget.name}
                          </Txt>
                          {b.budget.isDemo ? <Badge label="Sample" /> : null}
                        </Row>
                        <Txt v="caption" dim numberOfLines={1}>
                          {b.budget.period === 'custom' ? 'Custom' : b.budget.period === 'weekly' ? 'Weekly' : 'Monthly'} · {b.categoryNames.length ? b.categoryNames.join(', ') : 'All expenses'}
                        </Txt>
                      </View>
                      <View style={{ alignItems: 'flex-end' }}>
                        <Txt v="bodyStrong">{formatMoney(Math.max(0, s.remainingMinor), cur)}</Txt>
                        <Txt v="caption" faint>
                          left of {formatMoney(s.limitMinor, cur, { compact: true })}
                        </Txt>
                      </View>
                    </Row>
                    <Spacer h={10} />
                    <ProgressBar value={s.percentUsed} color={col} />
                    <Row justify="space-between" style={{ marginTop: 8 }}>
                      <Txt v="caption" color={s.state === 'ok' ? c.textDim : col} style={{ flex: 1 }}>
                        {s.message}
                      </Txt>
                      <Txt v="caption" dim>
                        {Math.round(s.percentUsed * 100)}% · {s.daysRemaining}d left
                      </Txt>
                    </Row>
                  </Card>
                );
              })}
            </>
          )
        ) : !goals.data ? (
          <LoadingBlock />
        ) : goals.data.length === 0 ? (
          <EmptyState icon="flag" title="No savings goals yet" message="Create a goal like “New Laptop — ₦800,000 by December”. Finora tells you exactly how much to save each week and month." action="Create goal" onAction={() => nav.navigate('GoalForm')} />
        ) : (
          goals.data.map((g) => {
            const p = g.progress;
            const col = p.state === 'behind' || p.state === 'overdue' ? c.warning : g.goal.color;
            return (
              <Card key={g.goal.id} style={{ marginBottom: 12 }} onPress={() => nav.navigate('GoalDetail', { id: g.goal.id })} accessibilityLabel={`${g.goal.name}, ${Math.round(p.percent * 100)} percent saved`}>
                <Row gap={14}>
                  <ProgressRing value={p.percent} size={64} stroke={7} color={g.goal.color}>
                    <Icon name={g.goal.icon} size={22} color={g.goal.color} />
                  </ProgressRing>
                  <View style={{ flex: 1 }}>
                    <Row gap={6}>
                      <Txt v="bodyStrong" numberOfLines={1} style={{ flexShrink: 1 }}>
                        {g.goal.name}
                      </Txt>
                      {p.state === 'completed' ? <Badge label="Done" color={c.success} /> : null}
                      {p.state === 'behind' ? <Badge label="Behind" color={c.warning} /> : null}
                      {p.state === 'on_track' ? <Badge label="On track" color={c.success} /> : null}
                      {g.goal.isDemo ? <Badge label="Sample" /> : null}
                    </Row>
                    <Txt v="small">
                      {formatMoney(p.savedMinor, g.goal.currency)} <Txt v="small" dim>of {formatMoney(g.goal.targetMinor, g.goal.currency)}</Txt>
                    </Txt>
                    <Txt v="caption" color={col === g.goal.color ? c.textDim : col}>
                      {p.state === 'completed'
                        ? 'Goal reached'
                        : g.goal.deadline
                          ? `${formatMoney(p.requiredMonthlyMinor ?? 0, g.goal.currency)}/month · by ${formatDate(g.goal.deadline)}`
                          : 'No deadline'}
                    </Txt>
                  </View>
                  <Txt v="h3" color={g.goal.color}>
                    {Math.round(p.percent * 100)}%
                  </Txt>
                </Row>
              </Card>
            );
          })
        )}
      </Screen>
      <Fab label={tab === 'budgets' ? 'Create budget' : 'Create goal'} onPress={() => nav.navigate(tab === 'budgets' ? 'BudgetForm' : 'GoalForm')} />
    </View>
  );
}
