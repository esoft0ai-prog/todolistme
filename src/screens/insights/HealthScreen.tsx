import React from 'react';
import { View } from 'react-native';
import { formatMonthKey } from '../../domain/dates';
import type { RootScreenProps } from '../../navigation/types';
import { healthHistory, healthScore } from '../../services/analytics';
import { useQuery } from '../../state/useQuery';
import { healthColor, LineChart, ProgressRing } from '../../ui/components/charts';
import { Badge, Card, Icon, LoadingBlock, ProgressBar, Row, Screen, SectionHeader, Spacer, Txt } from '../../ui/components/primitives';
import { useTheme } from '../../ui/theme';

const ICONS: Record<string, string> = { savings: 'shield-checkmark', debt: 'card', budget: 'pie-chart', cashflow: 'pulse', payments: 'time' };

export function HealthScreen({ navigation }: RootScreenProps<'Health'>) {
  const { c } = useTheme();
  const q = useQuery(async (ctx) => ({ score: await healthScore(ctx), history: await healthHistory(ctx.db) }));
  const d = q.data;
  return (
    <Screen title="Financial health" subtitle="A transparent score — not a black box" onBack={() => navigation.goBack()}>
      {!d ? (
        <LoadingBlock />
      ) : (
        <>
          <Card>
            <View style={{ alignItems: 'center' }}>
              <ProgressRing value={d.score.total / 100} size={160} stroke={14} color={healthColor(c, d.score.total)} label="Financial health score">
                <Txt v="display">{d.score.total}</Txt>
                <Txt v="small" dim>
                  out of 100
                </Txt>
              </ProgressRing>
              <Spacer h={10} />
              <Txt v="h2">{d.score.grade}</Txt>
              {d.score.previousMonth ? (
                <Badge
                  label={`${d.score.change.delta >= 0 ? '+' : ''}${d.score.change.delta} since ${formatMonthKey(d.score.previousMonth)}`}
                  color={d.score.change.delta > 0 ? c.success : d.score.change.delta < 0 ? c.danger : c.textDim}
                />
              ) : null}
            </View>
          </Card>

          {d.score.change.changes.length ? (
            <>
              <SectionHeader title="Why your score changed" />
              <Card>
                {d.score.change.changes.map((ch) => (
                  <Row key={ch.key} gap={8} style={{ marginBottom: 6 }}>
                    <Icon name={ch.delta > 0 ? 'trending-up' : 'trending-down'} size={18} color={ch.delta > 0 ? c.success : c.danger} />
                    <Txt v="small" style={{ flex: 1 }}>
                      {ch.text}
                    </Txt>
                  </Row>
                ))}
              </Card>
            </>
          ) : null}

          <SectionHeader title="Score breakdown" />
          {d.score.components.map((comp) => {
            const ratio = comp.score / comp.max;
            const col = healthColor(c, ratio * 100);
            return (
              <Card key={comp.key} style={{ marginBottom: 10 }}>
                <Row gap={12}>
                  <View style={{ width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: col + '22' }}>
                    <Icon name={ICONS[comp.key]} size={20} color={col} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Row justify="space-between">
                      <Txt v="bodyStrong">{comp.label}</Txt>
                      <Txt v="bodyStrong" color={col}>
                        {Math.round(comp.score * 10) / 10}/{comp.max}
                      </Txt>
                    </Row>
                    <Spacer h={6} />
                    <ProgressBar value={ratio} color={col} height={6} />
                  </View>
                </Row>
                <Txt v="small" dim style={{ marginTop: 10 }}>
                  {comp.explanation}
                </Txt>
                {comp.tip ? (
                  <Row gap={6} style={{ marginTop: 8 }} align="flex-start">
                    <Icon name="bulb" size={16} color={c.warning} />
                    <Txt v="small" color={c.warning} style={{ flex: 1 }}>
                      {comp.tip}
                    </Txt>
                  </Row>
                ) : null}
              </Card>
            );
          })}

          {d.history.length > 1 ? (
            <>
              <SectionHeader title="History" />
              <Card>
                <LineChart points={d.history.map((h) => ({ label: formatMonthKey(h.month, true), value: h.total }))} color={c.accent} formatValue={(v) => `${Math.round(v)}`} />
              </Card>
            </>
          ) : null}

          <SectionHeader title="How it works" />
          <Card>
            <Txt v="small" dim>
              Your score is the sum of five parts worth 20 points each. It uses only your own records from the last six months: savings rate and emergency fund, debt-to-income
              ratio and repayment progress, how often budgets stay within limits, how often money in exceeds money out, and whether debt instalments were paid on time. When
              there is not enough data for a part, a neutral score is used and clearly marked. A snapshot is saved each month so you can see what changed.
            </Txt>
          </Card>
        </>
      )}
    </Screen>
  );
}
