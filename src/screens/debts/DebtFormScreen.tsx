import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { CURRENCIES } from '../../domain/currency';
import { addMonths, formatDate, isValidTime, today } from '../../domain/dates';
import { computeTotalPayable, summarizeDebt, validateDebt } from '../../domain/debt';
import { formatMoney } from '../../domain/money';
import { DEBT_TYPES, INTEREST_TYPES, PAYMENT_FREQUENCIES, type Debt, type DebtType, type InterestType, type PaymentFrequency, type PenaltyType } from '../../domain/types';
import { firstError, type FieldError } from '../../domain/validation';
import type { RootScreenProps } from '../../navigation/types';
import { listAccounts } from '../../services/accounts';
import { createDebt, getDebtView, updateDebt, type DebtInput } from '../../services/debts';
import { mutate } from '../../state/actions';
import { usePrefs } from '../../state/appStore';
import { useQuery } from '../../state/useQuery';
import { AmountField, DateField, SelectField, SwitchRow, TextField, TimeField } from '../../ui/components/forms';
import { Button, Card, Chip, ChipScroller, Icon, LoadingBlock, Row, Screen, SectionHeader, Spacer, Txt } from '../../ui/components/primitives';
import { ACCOUNT_TYPE_ICON, DEBT_TYPE_ICON, DEBT_TYPE_LABEL, INTEREST_LABEL, PAYMENT_FREQ_LABEL } from '../../ui/labels';
import { useTheme } from '../../ui/theme';

const OFFSET_CHOICES = [30, 14, 7, 3, 1, 0];

export function DebtFormScreen({ navigation, route }: RootScreenProps<'DebtForm'>) {
  const { c } = useTheme();
  const prefs = usePrefs();
  const editId = route.params?.id;
  const q = useQuery(async (ctx) => ({
    accounts: await listAccounts(ctx.db),
    existing: editId ? await getDebtView(ctx.db, editId, ctx.today()) : null,
  }));

  const [lender, setLender] = useState('');
  const [debtType, setDebtType] = useState<DebtType>('loan_app');
  const [currency, setCurrency] = useState(prefs.baseCurrency);
  const [principal, setPrincipal] = useState<number | null>(null);
  const [interestType, setInterestType] = useState<InterestType>('none');
  const [rate, setRate] = useState('');
  const [fixedInterest, setFixedInterest] = useState<number | null>(null);
  const [frequency, setFrequency] = useState<PaymentFrequency>('monthly');
  const [countText, setCountText] = useState('');
  const [minPayment, setMinPayment] = useState<number | null>(null);
  const [startDate, setStartDate] = useState(today());
  const [firstDue, setFirstDue] = useState(addMonths(today(), 1));
  const [endDate, setEndDate] = useState<string | null>(null);
  const [penaltyType, setPenaltyType] = useState<PenaltyType>('none');
  const [penaltyText, setPenaltyText] = useState('');
  const [penaltyFixed, setPenaltyFixed] = useState<number | null>(null);
  const [currentBalance, setCurrentBalance] = useState<number | null>(null);
  const [notes, setNotes] = useState('');
  const [disburseTo, setDisburseTo] = useState<string | null>(null);
  const [schedule, setSchedule] = useState<{ dueDate: string; amountMinor: number | null }[]>([]);
  const [useDefaultReminders, setUseDefaultReminders] = useState(true);
  const [offsets, setOffsets] = useState<number[]>(prefs.defaultDebtReminderOffsets);
  const [reminderTime, setReminderTime] = useState<string | null>(prefs.reminderTime);
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const e = q.data?.existing;
    if (!q.data || loaded) return;
    if (e) {
      const d = e.debt;
      setLender(d.lenderName);
      setDebtType(d.debtType);
      setCurrency(d.currency);
      setPrincipal(d.principalMinor);
      setInterestType(d.interestType);
      if (d.interestType === 'fixed_amount') setFixedInterest(d.interestValue);
      else setRate(d.interestValue ? String(d.interestValue) : '');
      setFrequency(d.paymentFrequency);
      setCountText(d.installmentCount ? String(d.installmentCount) : '');
      setMinPayment(d.minimumPaymentMinor || null);
      setStartDate(d.startDate);
      setFirstDue(d.firstDueDate);
      setEndDate(d.endDate);
      setPenaltyType(d.penaltyType);
      if (d.penaltyType === 'fixed') setPenaltyFixed(d.penaltyValue);
      else setPenaltyText(d.penaltyValue ? String(d.penaltyValue) : '');
      setNotes(d.notes ?? '');
      setSchedule(e.schedule.map((s) => ({ dueDate: s.dueDate, amountMinor: s.amountMinor })));
      if (d.paidBeforeMinor) setCurrentBalance(computeTotalPayable(d, e.schedule) - d.paidBeforeMinor);
      if (e.reminders.length) {
        setUseDefaultReminders(false);
        setOffsets(e.reminders.map((r) => r.offsetDays ?? 0));
        setReminderTime(e.reminders[0].timeOfDay);
      }
    }
    setLoaded(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data]);

  const interestValue = interestType === 'fixed_amount' ? (fixedInterest ?? 0) : Number(rate.replace(',', '.')) || 0;
  const draft: Debt = useMemo(
    () => ({
      id: editId ?? 'draft',
      lenderName: lender,
      debtType,
      currency,
      principalMinor: principal ?? 0,
      interestType,
      interestValue,
      paymentFrequency: frequency,
      minimumPaymentMinor: minPayment ?? 0,
      installmentCount: frequency === 'one_time' ? 1 : Math.max(0, parseInt(countText, 10) || 0),
      startDate,
      firstDueDate: firstDue,
      endDate,
      penaltyType,
      penaltyValue: penaltyType === 'fixed' ? (penaltyFixed ?? 0) : Number(penaltyText.replace(',', '.')) || 0,
      paidBeforeMinor: 0,
      totalPayableOverrideMinor: null,
      notes: notes || null,
      status: 'active',
      isDemo: false,
      createdAt: '',
      updatedAt: '',
    }),
    [editId, lender, debtType, currency, principal, interestType, interestValue, frequency, minPayment, countText, startDate, firstDue, endDate, penaltyType, penaltyFixed, penaltyText, notes],
  );
  const scheduleItems = schedule.filter((s) => s.amountMinor && s.amountMinor > 0).map((s, i) => ({ id: String(i), debtId: 'draft', dueDate: s.dueDate, amountMinor: s.amountMinor! }));
  const preview = useMemo(() => {
    if (!principal || principal <= 0) return null;
    try {
      const total = computeTotalPayable(draft, scheduleItems);
      const paidBefore = currentBalance != null ? Math.max(0, total - currentBalance) : 0;
      return { total, paidBefore, summary: summarizeDebt({ ...draft, paidBeforeMinor: paidBefore }, [], scheduleItems) };
    } catch {
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, JSON.stringify(scheduleItems), currentBalance]);

  if (!q.data) {
    return (
      <Screen title={editId ? 'Edit debt' : 'Add debt'} onBack={() => navigation.goBack()}>
        <LoadingBlock />
      </Screen>
    );
  }

  const save = async () => {
    const paidBefore = preview?.paidBefore ?? 0;
    const input: DebtInput = { ...draft, paidBeforeMinor: paidBefore };
    const errs = validateDebt(input, interestType === 'custom_schedule' ? scheduleItems : []);
    if (!countText && frequency !== 'one_time' && !endDate && !minPayment && interestType !== 'custom_schedule') {
      errs.push({ field: 'installmentCount', message: 'Enter the number of payments, an end date, or a minimum payment' });
    }
    if (currentBalance != null && preview && currentBalance > preview.total) errs.push({ field: 'currentBalance', message: 'Current balance cannot be more than the total payable' });
    if (interestType === 'custom_schedule' && schedule.some((s) => !s.amountMinor)) errs.push({ field: 'schedule', message: 'Enter an amount for every instalment' });
    setErrors(errs);
    if (errs.length) return;
    setSaving(true);
    const reminderOffsets = useDefaultReminders ? null : offsets.map((d) => ({ days: d, time: reminderTime && isValidTime(reminderTime) ? reminderTime : prefs.reminderTime }));
    const sched = interestType === 'custom_schedule' ? scheduleItems.map((s) => ({ dueDate: s.dueDate, amountMinor: s.amountMinor })) : undefined;
    const res = await mutate(
      async (ctx) => {
        if (editId) {
          await updateDebt(ctx, editId, input, { schedule: sched, reminderOffsets });
          return editId;
        }
        return (await createDebt(ctx, input, { schedule: sched, reminderOffsets, disburseToAccountId: disburseTo })).id;
      },
      { success: editId ? 'Debt updated' : 'Debt added — reminders scheduled', silent: true },
    );
    setSaving(false);
    if (res.ok) {
      if (editId) navigation.goBack();
      else navigation.replace('DebtDetail', { id: res.value });
    } else setErrors([{ field: res.field ?? 'form', message: res.error }]);
  };

  const err = (f: string) => firstError(errors, f);
  const cur = currency;
  const m = (x: number) => formatMoney(x, cur);
  const pct = interestType === 'flat_percentage' || interestType === 'simple_annual' || interestType === 'reducing_balance';

  return (
    <Screen
      title={editId ? 'Edit debt' : 'Add debt or loan'}
      onBack={() => navigation.goBack()}
      footer={<Button title={editId ? 'Save changes' : 'Add debt'} icon="checkmark" onPress={save} loading={saving} />}
    >
      <TextField label="Lender / who you owe" value={lender} onChangeText={setLender} placeholder="e.g. QuickCredit, GTBank, Uncle Tunde" maxLength={80} error={err('lenderName')} autoFocus={!editId} />
      <Txt v="caption" dim style={{ fontWeight: '700', marginBottom: 6 }}>
        Type
      </Txt>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
        {DEBT_TYPES.map((t) => (
          <Chip key={t} label={DEBT_TYPE_LABEL[t]} icon={DEBT_TYPE_ICON[t]} active={debtType === t} onPress={() => setDebtType(t)} />
        ))}
      </View>
      <SelectField label="Currency" value={currency} onChange={(v) => v && setCurrency(v)} options={CURRENCIES.map((x) => ({ value: x.code, label: `${x.code} — ${x.name}`, subtitle: x.symbol }))} />
      <AmountField label="Amount borrowed (principal)" currency={cur} valueMinor={principal} onChangeMinor={setPrincipal} error={err('principalMinor')} />

      <SectionHeader title="Interest" />
      <SelectField
        label="Interest type"
        value={interestType}
        onChange={(v) => v && setInterestType(v)}
        options={INTEREST_TYPES.map((t) => ({ value: t, label: INTEREST_LABEL[t].label, subtitle: INTEREST_LABEL[t].help }))}
        hint={INTEREST_LABEL[interestType].help}
      />
      {pct ? (
        <TextField
          label={interestType === 'flat_percentage' ? 'Interest (% of principal)' : 'Annual interest rate (%)'}
          value={rate}
          onChangeText={(v) => setRate(v.replace(/[^0-9.,]/g, ''))}
          keyboardType="decimal-pad"
          placeholder="e.g. 15"
          error={err('interestValue')}
        />
      ) : null}
      {interestType === 'fixed_amount' ? <AmountField label="Interest amount" currency={cur} valueMinor={fixedInterest} onChangeMinor={setFixedInterest} error={err('interestValue')} /> : null}

      <SectionHeader title="Repayment" />
      {interestType !== 'custom_schedule' ? (
        <>
          <Txt v="caption" dim style={{ fontWeight: '700', marginBottom: 6 }}>
            Payment frequency
          </Txt>
          <ChipScroller>
            {PAYMENT_FREQUENCIES.map((f) => (
              <Chip key={f} label={PAYMENT_FREQ_LABEL[f]} active={frequency === f} onPress={() => setFrequency(f)} />
            ))}
          </ChipScroller>
          <Spacer h={12} />
        </>
      ) : null}
      <DateField label="Date borrowed" value={startDate} onChange={(v) => v && setStartDate(v)} error={err('startDate')} />
      {interestType !== 'custom_schedule' ? (
        <>
          <DateField label={frequency === 'one_time' ? 'Due date' : 'First payment due'} value={firstDue} onChange={(v) => v && setFirstDue(v)} error={err('firstDueDate')} minimumDate={startDate} />
          {frequency !== 'one_time' ? (
            <>
              <TextField label="Number of payments" value={countText} onChangeText={(v) => setCountText(v.replace(/\D/g, '').slice(0, 4))} keyboardType="number-pad" placeholder="e.g. 6" error={err('installmentCount')} hint="Or leave empty and set an end date / minimum payment" />
              <DateField label="End date (optional)" value={endDate} onChange={setEndDate} optional error={err('endDate')} />
              <AmountField label="Payment per instalment (optional)" currency={cur} valueMinor={minPayment} onChangeMinor={setMinPayment} hint="Leave empty to split the total equally" error={err('minimumPaymentMinor')} />
            </>
          ) : null}
        </>
      ) : (
        <View style={{ marginBottom: 12 }}>
          <Txt v="caption" dim style={{ fontWeight: '700', marginBottom: 6 }}>
            Instalments
          </Txt>
          {schedule.map((s, i) => (
            <Row key={i} gap={8} align="flex-start">
              <View style={{ flex: 1.2 }}>
                <DateField label={`#${i + 1} date`} value={s.dueDate} onChange={(v) => v && setSchedule((x) => x.map((y, j) => (j === i ? { ...y, dueDate: v } : y)))} />
              </View>
              <View style={{ flex: 1 }}>
                <AmountField label="Amount" currency={cur} valueMinor={s.amountMinor} onChangeMinor={(v) => setSchedule((x) => x.map((y, j) => (j === i ? { ...y, amountMinor: v } : y)))} />
              </View>
              <Pressable onPress={() => setSchedule((x) => x.filter((_, j) => j !== i))} accessibilityRole="button" accessibilityLabel={`Remove instalment ${i + 1}`} style={{ marginTop: 32, padding: 6 }}>
                <Icon name="trash" size={18} color={c.danger} />
              </Pressable>
            </Row>
          ))}
          <Button
            title="Add instalment"
            icon="add"
            variant="secondary"
            small
            onPress={() => setSchedule((x) => [...x, { dueDate: x.length ? addMonths(x[x.length - 1].dueDate, 1) : addMonths(startDate, 1), amountMinor: null }])}
          />
          {err('schedule') ? (
            <Txt v="caption" color={c.danger} style={{ marginTop: 6 }}>
              {err('schedule')}
            </Txt>
          ) : null}
        </View>
      )}

      <AmountField
        label="Current balance (optional)"
        currency={cur}
        valueMinor={currentBalance}
        onChangeMinor={setCurrentBalance}
        allowZero
        hint="If you have already repaid part of this debt, enter what you still owe."
        error={err('currentBalance') ?? err('paidBeforeMinor')}
      />

      {preview ? (
        <Card tone="primary" style={{ marginBottom: 12 }}>
          <Txt v="label" dim>
            Calculated
          </Txt>
          <Spacer h={6} />
          <Row justify="space-between">
            <Txt v="small" dim>
              Estimated interest
            </Txt>
            <Txt v="bodyStrong">{m(preview.summary.totalInterestMinor)}</Txt>
          </Row>
          <Row justify="space-between">
            <Txt v="small" dim>
              Total payable
            </Txt>
            <Txt v="bodyStrong">{m(preview.total)}</Txt>
          </Row>
          <Row justify="space-between">
            <Txt v="small" dim>
              Payments
            </Txt>
            <Txt v="bodyStrong">
              {preview.summary.installmentCount} × {m(preview.summary.installmentAmountMinor)}
            </Txt>
          </Row>
          <Row justify="space-between">
            <Txt v="small" dim>
              Outstanding now
            </Txt>
            <Txt v="bodyStrong">{m(preview.summary.outstandingMinor)}</Txt>
          </Row>
          {preview.summary.scheduledPayoffDate ? (
            <Row justify="space-between">
              <Txt v="small" dim>
                Payoff date
              </Txt>
              <Txt v="bodyStrong">{formatDate(preview.summary.scheduledPayoffDate)}</Txt>
            </Row>
          ) : null}
        </Card>
      ) : null}

      <SectionHeader title="Late payment penalty" />
      <ChipScroller>
        {(['none', 'fixed', 'percentage'] as PenaltyType[]).map((p) => (
          <Chip key={p} label={p === 'none' ? 'None' : p === 'fixed' ? 'Fixed amount' : '% of overdue'} active={penaltyType === p} onPress={() => setPenaltyType(p)} />
        ))}
      </ChipScroller>
      <Spacer h={10} />
      {penaltyType === 'fixed' ? <AmountField label="Penalty per missed payment" currency={cur} valueMinor={penaltyFixed} onChangeMinor={setPenaltyFixed} /> : null}
      {penaltyType === 'percentage' ? (
        <TextField label="Penalty (% of overdue amount)" value={penaltyText} onChangeText={(v) => setPenaltyText(v.replace(/[^0-9.,]/g, ''))} keyboardType="decimal-pad" error={err('penaltyValue')} />
      ) : null}

      <SectionHeader title="Reminders" />
      <Card padded={false} style={{ paddingHorizontal: 14, marginBottom: 12 }}>
        <SwitchRow
          label="Use default reminders"
          description={`${prefs.defaultDebtReminderOffsets.map((d) => (d === 0 ? 'on the day' : `${d}d before`)).join(', ')} at ${prefs.reminderTime}`}
          value={useDefaultReminders}
          onChange={setUseDefaultReminders}
          icon="alarm"
        />
        {!useDefaultReminders ? (
          <View style={{ paddingBottom: 12 }}>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
              {OFFSET_CHOICES.map((d) => (
                <Chip
                  key={d}
                  label={d === 0 ? 'On due date' : `${d} day${d === 1 ? '' : 's'} before`}
                  active={offsets.includes(d)}
                  onPress={() => setOffsets((o) => (o.includes(d) ? o.filter((x) => x !== d) : [...o, d].sort((a, b) => b - a)))}
                />
              ))}
            </View>
            <Txt v="caption" faint style={{ marginBottom: 8 }}>
              Add a custom reminder below. Overdue follow-ups are sent automatically 1, 3, 7, 14 and 30 days after a missed payment.
            </Txt>
            <CustomOffset onAdd={(d) => setOffsets((o) => (o.includes(d) ? o : [...o, d].sort((a, b) => b - a)))} />
            <TimeField label="Reminder time" value={reminderTime} onChange={setReminderTime} />
          </View>
        ) : null}
      </Card>

      {!editId && q.data.accounts.length ? (
        <SelectField
          label="Received the money into (optional)"
          value={disburseTo}
          allowClear
          onChange={setDisburseTo}
          options={q.data.accounts.filter((a) => a.currency === cur).map((a) => ({ value: a.id, label: a.name, icon: ACCOUNT_TYPE_ICON[a.type] }))}
          hint="Records a “Loan received” transaction so your account balance includes the borrowed money. It is not counted as income."
        />
      ) : null}
      <TextField label="Notes" value={notes} onChangeText={setNotes} multiline maxLength={2000} />
      {err('form') ? (
        <Card tone="danger">
          <Txt v="small" color={c.danger}>
            {err('form')}
          </Txt>
        </Card>
      ) : null}
    </Screen>
  );
}

function CustomOffset({ onAdd }: { onAdd: (days: number) => void }) {
  const [text, setText] = useState('');
  const days = parseInt(text, 10);
  return (
    <Row gap={8} style={{ marginTop: -6, marginBottom: 12 }}>
      <View style={{ flex: 1 }}>
        <TextField value={text} onChangeText={(v) => setText(v.replace(/\D/g, '').slice(0, 3))} placeholder="Days before, e.g. 5" keyboardType="number-pad" style={{ marginBottom: 0 }} />
      </View>
      <Button
        title="Add"
        small
        variant="secondary"
        disabled={!(days >= 0 && days <= 365)}
        onPress={() => {
          onAdd(days);
          setText('');
        }}
      />
    </Row>
  );
}
