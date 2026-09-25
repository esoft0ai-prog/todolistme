import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import React, { useState } from 'react';
import { View } from 'react-native';
import { formatDate, relativeDays } from '../../domain/dates';
import { describeDTI } from '../../domain/debt';
import { formatMoney, formatPercent } from '../../domain/money';
import type { RootStackParamList } from '../../navigation/types';
import { debtOverview } from '../../services/analytics';
import { listDebts } from '../../services/debts';
import { usePrefs } from '../../state/appStore';
import { useQuery } from '../../state/useQuery';
import { Badge, Card, EmptyState, Fab, GradientCard, Icon, LoadingBlock, ProgressBar, Row, Screen, Segmented, Spacer, Txt } from '../../ui/components/primitives';
import { DEBT_TYPE_ICON, DEBT_TYPE_LABEL } from '../../ui/labels';
import { toneColor, useTheme } from '../../ui/theme';

type Nav = NativeStackNavigationProp<RootStackParamList>;

export function DebtsScreen() {
  const nav = useNavigation<Nav>();
  const { c } = useTheme();
  const prefs = usePrefs();
  const [filter, setFilter] = useState<'active' | 'paid' | 'all'>('active');
  const q = useQuery(async (ctx) => {
    const all = await listDebts(ctx.db, ctx.today(), { includeArchived: true });
    return { all, overview: await debtOverview(ctx, all.filter((d) => d.debt.status !== 'archived')) };
  });
  const cur = prefs.baseCurrency;
  const d = q.data;
  const items = (d?.all ?? []).filter((x) =>
    filter === 'all' ? true : filter === 'paid' ? x.debt.status === 'paid_off' || x.debt.status === 'archived' : x.debt.status === 'active',
  );
  const dti = d ? describeDTI(d.overview.dti) : null;

  return (
    <View style={{ flex: 1 }}>
      <Screen title="Debts & Loans" subtitle="Track what you owe and never miss a payment" onRefresh={q.reload} refreshing={q.loading && !!d}>
        {!d ? (
          <LoadingBlock />
        ) : (
          <>
            <GradientCard colors={[c.mode === 'dark' ? '#5B2A86' : '#7C3AED', c.danger]}>
              <Txt v="label" color="rgba(255,255,255,0.8)">
                Total outstanding
              </Txt>
              <Txt v="display" color="#fff" numberOfLines={1} adjustsFontSizeToFit>
                {formatMoney(d.overview.totalOutstandingMinor, cur)}
              </Txt>
              <Row gap={18} style={{ marginTop: 10, flexWrap: 'wrap' }}>
                <View>
                  <Txt v="caption" color="rgba(255,255,255,0.75)">
                    Monthly obligation
                  </Txt>
                  <Txt v="bodyStrong" color="#fff">
                    {formatMoney(d.overview.monthlyObligationMinor, cur)}
                  </Txt>
                </View>
                <View>
                  <Txt v="caption" color="rgba(255,255,255,0.75)">
                    Debt-to-income
                  </Txt>
                  <Txt v="bodyStrong" color="#fff">
                    {d.overview.dti == null ? '—' : formatPercent(d.overview.dti)} · {dti?.label}
                  </Txt>
                </View>
              </Row>
              {d.overview.averageMonthlyIncomeMinor > 0 ? (
                <Txt v="caption" color="rgba(255,255,255,0.7)" style={{ marginTop: 8 }}>
                  Based on average monthly income of {formatMoney(d.overview.averageMonthlyIncomeMinor, cur)}
                </Txt>
              ) : null}
            </GradientCard>
            <Spacer h={14} />
            <Segmented
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'active', label: `Active (${d.all.filter((x) => x.debt.status === 'active').length})` },
                { value: 'paid', label: 'Paid & archived' },
                { value: 'all', label: 'All' },
              ]}
            />
            <Spacer h={12} />
            {items.length === 0 ? (
              <EmptyState
                icon="card"
                title={filter === 'active' ? 'No active debts' : 'Nothing here'}
                message="Add loans from banks, loan apps, family or friends. Finora calculates interest, schedules and reminders — offline."
                action="Add debt"
                onAction={() => nav.navigate('DebtForm')}
              />
            ) : (
              items.map((x) => {
                const s = x.summary;
                const overdue = s.overdueInstallments.length > 0;
                return (
                  <Card
                    key={x.debt.id}
                    style={{ marginBottom: 12 }}
                    tone={overdue ? 'danger' : undefined}
                    onPress={() => nav.navigate('DebtDetail', { id: x.debt.id })}
                    accessibilityLabel={`${x.debt.lenderName}, outstanding ${formatMoney(s.outstandingMinor, x.debt.currency)}`}
                  >
                    <Row gap={12}>
                      <View style={{ width: 42, height: 42, borderRadius: 13, backgroundColor: c.dangerSoft, alignItems: 'center', justifyContent: 'center' }}>
                        <Icon name={DEBT_TYPE_ICON[x.debt.debtType]} size={20} color={c.danger} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Row gap={6}>
                          <Txt v="bodyStrong" numberOfLines={1} style={{ flexShrink: 1 }}>
                            {x.debt.lenderName}
                          </Txt>
                          {x.debt.status === 'paid_off' ? <Badge label="Paid off" color={c.success} /> : null}
                          {x.debt.status === 'archived' ? <Badge label="Archived" color={c.textFaint} /> : null}
                          {overdue ? <Badge label="Overdue" color={c.danger} /> : null}
                          {x.debt.isDemo ? <Badge label="Sample" color={c.warning} /> : null}
                        </Row>
                        <Txt v="caption" dim>
                          {DEBT_TYPE_LABEL[x.debt.debtType]} · {s.paymentsRemaining} payment{s.paymentsRemaining === 1 ? '' : 's'} left
                        </Txt>
                      </View>
                      <View style={{ alignItems: 'flex-end' }}>
                        <Txt v="bodyStrong">{formatMoney(s.outstandingMinor, x.debt.currency)}</Txt>
                        <Txt v="caption" faint>
                          of {formatMoney(s.totalPayableMinor + s.penaltiesMinor + s.adjustmentsMinor, x.debt.currency, { compact: true })}
                        </Txt>
                      </View>
                    </Row>
                    <Spacer h={10} />
                    <ProgressBar value={s.progress} color={x.debt.status === 'paid_off' ? c.success : c.accent} />
                    {s.nextInstallment && x.debt.status === 'active' ? (
                      <Row justify="space-between" style={{ marginTop: 10 }}>
                        <Txt v="caption" color={overdue ? c.danger : c.textDim}>
                          {overdue ? `Overdue by ${s.daysOverdue} day${s.daysOverdue === 1 ? '' : 's'}` : `Next: ${formatDate(s.nextInstallment.dueDate)} (${relativeDays(s.nextInstallment.dueDate)})`}
                        </Txt>
                        <Txt v="caption" style={{ fontWeight: '700' }} color={overdue ? c.danger : undefined}>
                          {formatMoney(overdue ? s.overdueAmountMinor : s.nextInstallment.amountMinor - s.nextInstallment.paidMinor, x.debt.currency)}
                        </Txt>
                      </Row>
                    ) : null}
                  </Card>
                );
              })
            )}
            {dti && d.overview.dti != null && d.overview.dti > 0.36 ? (
              <Card tone="warning">
                <Row gap={10}>
                  <Icon name="bulb" size={18} color={toneColor(c, dti.tone)} />
                  <Txt v="small" style={{ flex: 1 }}>
                    Your debt payments take a large share of income. Avoid new loans and pay off the most expensive debt first.
                  </Txt>
                </Row>
              </Card>
            ) : null}
          </>
        )}
      </Screen>
      <Fab label="Add debt" onPress={() => nav.navigate('DebtForm')} />
    </View>
  );
}
