import React, { useEffect, useState } from 'react';
import { today } from '../../domain/dates';
import { formatMoney } from '../../domain/money';
import { PAYMENT_METHODS, type PaymentMethod } from '../../domain/types';
import type { RootScreenProps } from '../../navigation/types';
import { listAccounts } from '../../services/accounts';
import { getDebtView, recordRepayment } from '../../services/debts';
import { mutate } from '../../state/actions';
import { useQuery } from '../../state/useQuery';
import { AmountField, DateField, SelectField, TextField } from '../../ui/components/forms';
import { Button, Card, Chip, ChipScroller, LoadingBlock, Row, Screen, Spacer, Txt } from '../../ui/components/primitives';
import { ACCOUNT_TYPE_ICON, PAYMENT_METHOD_LABEL } from '../../ui/labels';
import { useTheme } from '../../ui/theme';

export function RepaymentFormScreen({ navigation, route }: RootScreenProps<'RepaymentForm'>) {
  const { c } = useTheme();
  const debtId = route.params.debtId;
  const q = useQuery(async (ctx) => ({ view: await getDebtView(ctx.db, debtId, ctx.today()), accounts: await listAccounts(ctx.db) }), [debtId]);
  const [amount, setAmount] = useState<number | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [date, setDate] = useState(today());
  const [method, setMethod] = useState<PaymentMethod | null>('bank_transfer');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);

  const v = q.data?.view;
  useEffect(() => {
    if (!v || amount != null) return;
    const s = v.summary;
    const due = s.overdueInstallments.length ? s.overdueAmountMinor : s.nextInstallment ? s.nextInstallment.amountMinor - s.nextInstallment.paidMinor : s.outstandingMinor;
    setAmount(Math.min(due, s.outstandingMinor) || null);
    const acc = q.data?.accounts.find((a) => a.currency === v.debt.currency && a.type !== 'savings');
    if (acc) setAccountId(acc.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v]);

  if (!q.data || !v) {
    return (
      <Screen title="Record repayment" onBack={() => navigation.goBack()}>
        <LoadingBlock />
      </Screen>
    );
  }
  const cur = v.debt.currency;
  const s = v.summary;
  const accounts = q.data.accounts.filter((a) => a.currency === cur);

  const save = async () => {
    if (!amount) {
      setError('Enter the amount you paid');
      return;
    }
    if (amount > s.outstandingMinor) {
      setError(`You only owe ${formatMoney(s.outstandingMinor, cur)}`);
      return;
    }
    setSaving(true);
    const res = await mutate((ctx) => recordRepayment(ctx, debtId, { amountMinor: amount, date, accountId, notes: notes || null, paymentMethod: method }), {
      success: amount === s.outstandingMinor ? 'Debt fully repaid! 🎉' : 'Repayment recorded',
      silent: true,
    });
    setSaving(false);
    if (res.ok) navigation.goBack();
    else setError(res.error);
  };

  return (
    <Screen title="Record repayment" subtitle={v.debt.lenderName} onBack={() => navigation.goBack()} footer={<Button title="Save repayment" icon="checkmark" onPress={save} loading={saving} />}>
      <Card>
        <Row justify="space-between">
          <Txt v="small" dim>
            Outstanding
          </Txt>
          <Txt v="bodyStrong">{formatMoney(s.outstandingMinor, cur)}</Txt>
        </Row>
        {s.nextInstallment ? (
          <Row justify="space-between" style={{ marginTop: 4 }}>
            <Txt v="small" dim>
              {s.overdueInstallments.length ? 'Overdue now' : 'Next instalment'}
            </Txt>
            <Txt v="bodyStrong" color={s.overdueInstallments.length ? c.danger : undefined}>
              {formatMoney(s.overdueInstallments.length ? s.overdueAmountMinor : s.nextInstallment.amountMinor - s.nextInstallment.paidMinor, cur)}
            </Txt>
          </Row>
        ) : null}
      </Card>
      <Spacer h={14} />
      <AmountField label="Amount paid" currency={cur} valueMinor={amount} onChangeMinor={(x) => (setAmount(x), setError(undefined))} error={error} big />
      <ChipScroller>
        {s.nextInstallment ? <Chip label="Next instalment" onPress={() => setAmount(s.nextInstallment!.amountMinor - s.nextInstallment!.paidMinor)} /> : null}
        <Chip label="Pay in full" onPress={() => setAmount(s.outstandingMinor)} />
      </ChipScroller>
      <Spacer h={12} />
      <SelectField
        label="Paid from"
        value={accountId}
        onChange={setAccountId}
        allowClear
        placeholder="Outside my tracked accounts"
        options={accounts.map((a) => ({ value: a.id, label: a.name, subtitle: formatMoney(a.balanceMinor, a.currency), icon: ACCOUNT_TYPE_ICON[a.type] }))}
        hint={accountId ? 'The amount will be deducted from this account.' : 'Only the debt balance changes (e.g. someone else paid for you).'}
      />
      <DateField label="Payment date" value={date} onChange={(x) => x && setDate(x)} />
      <Txt v="caption" dim style={{ fontWeight: '700', marginBottom: 6 }}>
        Payment method
      </Txt>
      <ChipScroller>
        {PAYMENT_METHODS.map((pm) => (
          <Chip key={pm} label={PAYMENT_METHOD_LABEL[pm]} active={method === pm} onPress={() => setMethod(pm)} />
        ))}
      </ChipScroller>
      <Spacer h={12} />
      <TextField label="Notes" value={notes} onChangeText={setNotes} placeholder="Optional" />
    </Screen>
  );
}
