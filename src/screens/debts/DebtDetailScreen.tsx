import React, { useState } from 'react';
import { View } from 'react-native';
import { formatDate, relativeDays, today } from '../../domain/dates';
import { penaltyFor } from '../../domain/debt';
import { formatMoney, formatPercent } from '../../domain/money';
import type { RootScreenProps } from '../../navigation/types';
import { addDebtCharge, deleteDebt, deleteDebtPayment, getDebtView, setDebtArchived } from '../../services/debts';
import { mutate } from '../../state/actions';
import { useQuery } from '../../state/useQuery';
import { ProgressRing } from '../../ui/components/charts';
import { chooseDialog, confirmDialog } from '../../ui/components/feedback';
import { AmountField, DateField, Sheet, TextField } from '../../ui/components/forms';
import { Badge, Button, Card, IconButton, ListRow, LoadingBlock, Row, Screen, SectionHeader, Segmented, Spacer, StatPill, Txt, EmptyState } from '../../ui/components/primitives';
import { DEBT_TYPE_LABEL, INTEREST_LABEL, PAYMENT_FREQ_LABEL } from '../../ui/labels';
import { useTheme } from '../../ui/theme';

export function DebtDetailScreen({ navigation, route }: RootScreenProps<'DebtDetail'>) {
  const { c } = useTheme();
  const id = route.params.id;
  const q = useQuery((ctx) => getDebtView(ctx.db, id, ctx.today()), [id]);
  const [tab, setTab] = useState<'schedule' | 'history'>('schedule');
  const [chargeOpen, setChargeOpen] = useState<null | 'penalty' | 'adjustment'>(null);
  const [chargeAmount, setChargeAmount] = useState<number | null>(null);
  const [chargeDate, setChargeDate] = useState(today());
  const [chargeNote, setChargeNote] = useState('');
  const [reduce, setReduce] = useState<'increase' | 'decrease'>('decrease');

  const v = q.data;
  if (!v) {
    return (
      <Screen title="Debt" onBack={() => navigation.goBack()}>
        {q.loading ? <LoadingBlock /> : <EmptyState icon="card" title="Debt not found" message="It may have been deleted." />}
      </Screen>
    );
  }
  const { debt, summary: s } = v;
  const cur = debt.currency;
  const m = (x: number) => formatMoney(x, cur);
  const suggestedPenalty = s.overdueAmountMinor > 0 ? penaltyFor(debt, s.overdueAmountMinor) : 0;

  const more = async () => {
    const choice = await chooseDialog(debt.lenderName, undefined, [
      { text: 'Edit debt', value: 'edit', variant: 'secondary' },
      { text: 'Add penalty / late fee', value: 'penalty', variant: 'secondary' },
      { text: 'Adjust balance', value: 'adjustment', variant: 'secondary' },
      { text: debt.status === 'archived' ? 'Unarchive' : 'Archive', value: 'archive', variant: 'secondary' },
      { text: 'Delete debt', value: 'delete', variant: 'danger' },
      { text: 'Cancel', value: 'cancel', variant: 'ghost' },
    ]);
    if (choice === 'edit') navigation.navigate('DebtForm', { id });
    if (choice === 'penalty' || choice === 'adjustment') {
      setChargeAmount(choice === 'penalty' && suggestedPenalty ? suggestedPenalty : null);
      setChargeOpen(choice);
    }
    if (choice === 'archive') await mutate((ctx) => setDebtArchived(ctx, id, debt.status !== 'archived'), { success: debt.status === 'archived' ? 'Debt restored' : 'Debt archived' });
    if (choice === 'delete') {
      const which = await chooseDialog('Delete this debt?', 'Its payment history and reminders will be removed. What should happen to the linked transactions (loan received and repayments)?', [
        { text: 'Keep transactions (balances unchanged)', value: 'keep', variant: 'secondary' },
        { text: 'Delete transactions too', value: 'all', variant: 'danger' },
        { text: 'Cancel', value: 'cancel', variant: 'ghost' },
      ]);
      if (which === 'keep' || which === 'all') {
        const res = await mutate((ctx) => deleteDebt(ctx, id, which === 'all'), { success: 'Debt deleted' });
        if (res.ok) navigation.goBack();
      }
    }
  };

  const saveCharge = async () => {
    if (!chargeOpen || !chargeAmount) return;
    const amt = chargeOpen === 'adjustment' && reduce === 'decrease' ? -chargeAmount : chargeAmount;
    const res = await mutate((ctx) => addDebtCharge(ctx, id, chargeOpen, amt, chargeDate, chargeNote || null), { success: chargeOpen === 'penalty' ? 'Penalty added' : 'Balance adjusted' });
    if (res.ok) {
      setChargeOpen(null);
      setChargeNote('');
    }
  };

  const removePayment = async (pid: string, linked: boolean) => {
    const ok = await confirmDialog({
      title: 'Delete this record?',
      message: linked ? 'The linked transaction will also be deleted and your account balance restored.' : 'The debt balance will be recalculated.',
      confirmText: 'Delete',
      destructive: true,
    });
    if (ok) await mutate((ctx) => deleteDebtPayment(ctx, pid), { success: 'Record deleted' });
  };

  const interestText =
    debt.interestType === 'none'
      ? 'No interest'
      : debt.interestType === 'fixed_amount'
        ? `${m(debt.interestValue)} fixed`
        : debt.interestType === 'custom_schedule'
          ? 'Custom schedule'
          : `${debt.interestValue}% ${debt.interestType === 'flat_percentage' ? 'flat' : 'per year'}`;

  return (
    <Screen
      title={debt.lenderName}
      subtitle={`${DEBT_TYPE_LABEL[debt.debtType]} · ${PAYMENT_FREQ_LABEL[debt.paymentFrequency]}`}
      onBack={() => navigation.goBack()}
      right={<IconButton icon="ellipsis-horizontal" label="More actions" onPress={more} />}
      footer={
        debt.status === 'active' ? (
          <Row gap={10}>
            <Button title="Record repayment" icon="checkmark-circle" onPress={() => navigation.navigate('RepaymentForm', { debtId: id })} style={{ flex: 1 }} />
          </Row>
        ) : undefined
      }
    >
      <Card tone={s.overdueInstallments.length ? 'danger' : undefined}>
        <Row gap={16}>
          <ProgressRing value={s.progress} size={96} stroke={10} color={s.isPaidOff ? c.success : c.accent} label="Repayment progress">
            <Txt v="h3">{formatPercent(s.progress)}</Txt>
            <Txt v="caption" faint>
              repaid
            </Txt>
          </ProgressRing>
          <View style={{ flex: 1 }}>
            <Txt v="caption" dim>
              Outstanding balance
            </Txt>
            <Txt v="h1" color={s.isPaidOff ? c.success : c.text} numberOfLines={1} adjustsFontSizeToFit>
              {m(s.outstandingMinor)}
            </Txt>
            <Row gap={6} style={{ flexWrap: 'wrap', marginTop: 4 }}>
              {s.isPaidOff ? <Badge label="Paid off" color={c.success} /> : null}
              {s.overdueInstallments.length ? <Badge label={`Overdue ${s.daysOverdue}d`} color={c.danger} /> : null}
              {debt.isDemo ? <Badge label="Sample" /> : null}
            </Row>
          </View>
        </Row>
        {s.nextInstallment && !s.isPaidOff ? (
          <Card style={{ marginTop: 14 }} tone={s.nextInstallment.status === 'overdue' ? 'danger' : 'primary'}>
            <Row justify="space-between">
              <View>
                <Txt v="caption" dim>
                  {s.nextInstallment.status === 'overdue' ? 'Overdue payment' : 'Next payment'}
                </Txt>
                <Txt v="h3">{m(s.overdueInstallments.length ? s.overdueAmountMinor : s.nextInstallment.amountMinor - s.nextInstallment.paidMinor)}</Txt>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Txt v="bodyStrong">{formatDate(s.nextInstallment.dueDate)}</Txt>
                <Txt v="caption" color={s.nextInstallment.status === 'overdue' ? c.danger : c.textDim}>
                  {s.daysUntilNext != null && s.daysUntilNext < 0 ? `${-s.daysUntilNext} days overdue` : s.daysUntilNext === 0 ? 'Due today' : `In ${s.daysUntilNext} day${s.daysUntilNext === 1 ? '' : 's'}`}
                </Txt>
              </View>
            </Row>
            {suggestedPenalty > 0 ? (
              <Txt v="caption" color={c.warning} style={{ marginTop: 8 }}>
                Late-payment penalty per your terms: {m(suggestedPenalty)}. Record it from ··· → Add penalty if the lender charged it.
              </Txt>
            ) : null}
          </Card>
        ) : null}
      </Card>

      <Spacer h={12} />
      <Row gap={10}>
        <StatPill label="Principal" value={m(debt.principalMinor)} />
        <StatPill label="Est. interest" value={m(s.totalInterestMinor)} color={c.warning} />
      </Row>
      <Spacer h={10} />
      <Row gap={10}>
        <StatPill label="Total payable" value={m(s.totalPayableMinor + s.penaltiesMinor + s.adjustmentsMinor)} />
        <StatPill label="Repaid" value={m(s.paidMinor)} color={c.success} />
      </Row>
      <Spacer h={10} />
      <Row gap={10}>
        <StatPill label="Payments left" value={String(s.paymentsRemaining)} />
        <StatPill label="Monthly obligation" value={m(s.monthlyObligationMinor)} />
      </Row>
      <Spacer h={10} />
      <Row gap={10}>
        <StatPill label="Scheduled payoff" value={s.scheduledPayoffDate ? formatDate(s.scheduledPayoffDate) : '—'} />
        <StatPill label="At current pace" value={s.projectedPayoffDate ? formatDate(s.projectedPayoffDate) : '—'} color={s.projectedPayoffDate && s.scheduledPayoffDate && s.projectedPayoffDate > s.scheduledPayoffDate ? c.warning : undefined} />
      </Row>

      <SectionHeader title="Terms" />
      <Card>
        <ListRow title="Interest" subtitle={INTEREST_LABEL[debt.interestType].label} right={interestText} />
        <ListRow title="Instalment" subtitle={`${s.installmentCount} × ${PAYMENT_FREQ_LABEL[debt.paymentFrequency].toLowerCase()}`} right={m(s.installmentAmountMinor)} />
        <ListRow title="Started" right={formatDate(debt.startDate)} />
        {debt.endDate ? <ListRow title="End date" right={formatDate(debt.endDate)} /> : null}
        <ListRow title="Penalty terms" right={debt.penaltyType === 'none' ? 'None' : debt.penaltyType === 'fixed' ? `${m(debt.penaltyValue)} per missed payment` : `${debt.penaltyValue}% of overdue amount`} />
        {s.penaltiesMinor ? <ListRow title="Penalties charged" right={m(s.penaltiesMinor)} rightColor={c.danger} /> : null}
        {debt.paidBeforeMinor ? <ListRow title="Paid before tracking" right={m(debt.paidBeforeMinor)} /> : null}
        <ListRow
          title="Reminders"
          subtitle={v.reminders.length ? v.reminders.map((r) => (r.offsetDays === 0 ? 'on due date' : `${r.offsetDays}d before`)).join(', ') : 'Using your default reminder settings'}
          chevron
          onPress={() => navigation.navigate('DebtForm', { id })}
        />
        {debt.notes ? (
          <Txt v="small" dim style={{ marginTop: 8 }}>
            {debt.notes}
          </Txt>
        ) : null}
      </Card>

      <Spacer h={16} />
      <Segmented value={tab} onChange={setTab} options={[{ value: 'schedule', label: `Schedule (${s.installments.length})` }, { value: 'history', label: `History (${v.payments.length})` }]} />
      <Spacer h={8} />
      <Card padded={false} style={{ paddingHorizontal: 16 }}>
        {tab === 'schedule'
          ? s.installments.map((i) => (
              <ListRow
                key={i.index}
                icon={i.status === 'paid' ? 'checkmark-circle' : i.status === 'overdue' ? 'alert-circle' : i.status === 'partial' ? 'ellipse-outline' : 'time-outline'}
                iconColor={i.status === 'paid' ? c.success : i.status === 'overdue' ? c.danger : i.status === 'partial' ? c.warning : c.textFaint}
                title={`Payment ${i.index + 1}${i.index === s.installments.length - 1 ? ' (final)' : ''}`}
                subtitle={`${formatDate(i.dueDate)} · ${i.status === 'paid' ? 'paid' : i.status === 'overdue' ? 'overdue' : relativeDays(i.dueDate)}`}
                right={m(i.amountMinor)}
                rightSub={i.paidMinor > 0 && i.paidMinor < i.amountMinor ? `${m(i.paidMinor)} paid` : undefined}
              />
            ))
          : v.payments.length === 0
            ? (
                <Txt v="small" dim style={{ paddingVertical: 16 }}>
                  No repayments recorded yet.
                </Txt>
              )
            : [...v.payments].reverse().map((p) => (
                <ListRow
                  key={p.id}
                  icon={p.kind === 'payment' ? 'arrow-up-circle' : p.kind === 'penalty' ? 'warning' : 'create'}
                  iconColor={p.kind === 'payment' ? c.success : p.kind === 'penalty' ? c.danger : c.info}
                  title={p.kind === 'payment' ? 'Repayment' : p.kind === 'penalty' ? 'Penalty' : 'Balance adjustment'}
                  subtitle={`${formatDate(p.date)}${p.transactionId ? ' · from account' : ''}${p.notes ? ` · ${p.notes}` : ''}`}
                  right={`${p.kind === 'payment' ? '−' : p.amountMinor < 0 ? '−' : '+'}${m(Math.abs(p.amountMinor))}`}
                  rightColor={p.kind === 'payment' ? c.success : p.kind === 'penalty' ? c.danger : undefined}
                  onPress={() => removePayment(p.id, !!p.transactionId)}
                  accessibilityLabel={`${p.kind} ${m(p.amountMinor)} on ${formatDate(p.date)}. Double tap to delete`}
                />
              ))}
      </Card>
      {tab === 'history' && v.payments.length ? (
        <Txt v="caption" faint style={{ marginTop: 6 }}>
          Tap a record to delete it.
        </Txt>
      ) : null}

      <Sheet visible={!!chargeOpen} onClose={() => setChargeOpen(null)} title={chargeOpen === 'penalty' ? 'Add penalty / late fee' : 'Adjust balance'}>
        {chargeOpen === 'adjustment' ? (
          <>
            <Segmented value={reduce} onChange={setReduce} options={[{ value: 'decrease', label: 'Reduce balance' }, { value: 'increase', label: 'Increase balance' }]} />
            <Spacer h={10} />
          </>
        ) : null}
        <AmountField label="Amount" currency={cur} valueMinor={chargeAmount} onChangeMinor={setChargeAmount} />
        <DateField label="Date" value={chargeDate} onChange={(x) => x && setChargeDate(x)} />
        <TextField label="Note" value={chargeNote} onChangeText={setChargeNote} placeholder={chargeOpen === 'penalty' ? 'e.g. Late fee for March' : 'e.g. Lender waived part of the interest'} />
        <Button title="Save" onPress={saveCharge} disabled={!chargeAmount} />
      </Sheet>
    </Screen>
  );
}
