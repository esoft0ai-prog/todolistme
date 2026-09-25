import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { formatDate, today } from '../../domain/dates';
import { formatMoney } from '../../domain/money';
import { describeRule, nextOccurrence } from '../../domain/recurrence';
import { RECURRENCE_FREQUENCIES, type CustomUnit, type RecurrenceFrequency, type RecurringTransaction } from '../../domain/types';
import { firstError, type FieldError } from '../../domain/validation';
import type { RootScreenProps } from '../../navigation/types';
import { listAccounts } from '../../services/accounts';
import { listCategories } from '../../services/categories';
import { listDebts } from '../../services/debts';
import { listGoals } from '../../services/goals';
import { deleteRecurring, listRecurring, materializeDue, saveRecurring, validateRecurring, type RecurringInput } from '../../services/recurring';
import { mutate } from '../../state/actions';
import { useQuery } from '../../state/useQuery';
import { confirmDialog } from '../../ui/components/feedback';
import { AmountField, DateField, SelectField, SwitchRow, TextField } from '../../ui/components/forms';
import { Badge, Button, Card, Chip, ChipScroller, EmptyState, Fab, Row, LoadingBlock, ListRow, Screen, Segmented, Spacer, Txt } from '../../ui/components/primitives';
import { RECURRENCE_LABEL, TX_TYPE_ICON, TX_TYPE_LABEL, txColor } from '../../ui/labels';
import { useTheme } from '../../ui/theme';

type RecType = RecurringTransaction['type'];
const REC_TYPES: RecType[] = ['expense', 'income', 'transfer', 'debt_repayment', 'savings_deposit'];

export function RecurringScreen({ navigation }: RootScreenProps<'Recurring'>) {
  const { c } = useTheme();
  const q = useQuery(async (ctx) => ({ list: await listRecurring(ctx.db), accounts: await listAccounts(ctx.db, { includeArchived: true }) }));
  return (
    <View style={{ flex: 1 }}>
      <Screen title="Recurring" subtitle="Salary, rent, subscriptions, loan payments" onBack={() => navigation.goBack()}>
        {!q.data ? (
          <LoadingBlock />
        ) : q.data.list.length === 0 ? (
          <EmptyState icon="repeat" title="No recurring transactions" message="Add your salary, rent, data subscription or monthly loan payment. Finora creates them automatically when due — even after days offline." action="Add recurring" onAction={() => navigation.navigate('RecurringForm')} />
        ) : (
          <Card padded={false} style={{ paddingHorizontal: 14 }}>
            {q.data.list.map((r) => {
              const next = r.active ? nextOccurrence(r, today(), true) : null;
              const cur = q.data!.accounts.find((a) => a.id === r.accountId)?.currency ?? 'NGN';
              return (
                <ListRow
                  key={r.id}
                  icon={TX_TYPE_ICON[r.type]}
                  iconColor={txColor(c, r.type)}
                  title={r.description || TX_TYPE_LABEL[r.type]}
                  subtitle={`${describeRule(r)}${next ? ` · next ${formatDate(next)}` : r.active ? ' · ended' : ' · paused'}`}
                  right={formatMoney(r.amountMinor, cur)}
                  rightSub={r.autoCreate ? 'auto' : 'reminder only'}
                  badge={r.isBill ? 'Bill' : r.isDemo ? 'Sample' : undefined}
                  onPress={() => navigation.navigate('RecurringForm', { id: r.id })}
                />
              );
            })}
          </Card>
        )}
      </Screen>
      <Fab label="Add recurring transaction" onPress={() => navigation.navigate('RecurringForm')} />
    </View>
  );
}

export function RecurringFormScreen({ navigation, route }: RootScreenProps<'RecurringForm'>) {
  const { c } = useTheme();
  const editId = route.params?.id;
  const q = useQuery(async (ctx) => ({
    accounts: await listAccounts(ctx.db),
    categories: await listCategories(ctx.db),
    debts: await listDebts(ctx.db, ctx.today()),
    goals: await listGoals(ctx),
    existing: editId ? (await listRecurring(ctx.db)).find((r) => r.id === editId) ?? null : null,
  }));
  const [type, setType] = useState<RecType>('expense');
  const [amount, setAmount] = useState<number | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [toAccountId, setToAccountId] = useState<string | null>(null);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [debtId, setDebtId] = useState<string | null>(null);
  const [goalId, setGoalId] = useState<string | null>(null);
  const [description, setDescription] = useState('');
  const [frequency, setFrequency] = useState<RecurrenceFrequency>('monthly');
  const [interval, setInterval] = useState('1');
  const [unit, setUnit] = useState<CustomUnit>('month');
  const [startDate, setStartDate] = useState(today());
  const [endDate, setEndDate] = useState<string | null>(null);
  const [isBill, setIsBill] = useState(true);
  const [autoCreate, setAutoCreate] = useState(true);
  const [remind, setRemind] = useState(1);
  const [active, setActive] = useState(true);
  const [backfill, setBackfill] = useState(false);
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!q.data || loaded) return;
    const e = q.data.existing;
    if (e) {
      setType(e.type);
      setAmount(e.amountMinor);
      setAccountId(e.accountId);
      setToAccountId(e.toAccountId);
      setCategoryId(e.categoryId);
      setDebtId(e.debtId);
      setGoalId(e.goalId);
      setDescription(e.description);
      setFrequency(e.frequency);
      setInterval(String(e.interval));
      setUnit(e.unit);
      setStartDate(e.startDate);
      setEndDate(e.endDate);
      setIsBill(e.isBill);
      setAutoCreate(e.autoCreate);
      setRemind(e.remindDaysBefore);
      setActive(e.active);
    } else if (q.data.accounts.length) setAccountId(q.data.accounts[0].id);
    setLoaded(true);
  }, [q.data, loaded]);

  if (!q.data) {
    return (
      <Screen title="Recurring" onBack={() => navigation.goBack()}>
        <LoadingBlock />
      </Screen>
    );
  }
  const L = q.data;
  const cur = L.accounts.find((a) => a.id === accountId)?.currency ?? 'NGN';
  const input: RecurringInput = {
    type,
    amountMinor: amount ?? 0,
    accountId: accountId ?? '',
    toAccountId: type === 'transfer' ? toAccountId : null,
    categoryId: type === 'income' || type === 'expense' ? categoryId : type === 'debt_repayment' ? 'sys-exp-debt' : null,
    debtId: type === 'debt_repayment' ? debtId : null,
    goalId: type === 'savings_deposit' ? goalId : null,
    description,
    paymentMethod: null,
    frequency,
    interval: Math.max(1, parseInt(interval, 10) || 1),
    unit,
    startDate,
    endDate,
    isBill: type === 'expense' && isBill,
    autoCreate,
    remindDaysBefore: remind,
    active,
  };
  const save = async () => {
    const errs = validateRecurring(input);
    setErrors(errs);
    if (errs.length) return;
    const res = await mutate(
      async (ctx) => {
        const id = await saveRecurring(ctx, input, editId, undefined, { backfill });
        if (autoCreate) await materializeDue(ctx);
        return id;
      },
      { success: 'Recurring transaction saved', silent: true },
    );
    if (res.ok) navigation.goBack();
    else setErrors([{ field: res.field ?? 'form', message: res.error }]);
  };
  const remove = async () => {
    if (!editId || !(await confirmDialog({ title: 'Delete recurring transaction?', message: 'Transactions already created are kept.', confirmText: 'Delete', destructive: true }))) return;
    const res = await mutate((ctx) => deleteRecurring(ctx, editId), { success: 'Deleted' });
    if (res.ok) navigation.goBack();
  };
  const err = (f: string) => firstError(errors, f);
  const cats = L.categories.filter((x) => x.kind === (type === 'income' ? 'income' : 'expense'));
  return (
    <Screen
      title={editId ? 'Edit recurring' : 'New recurring'}
      onBack={() => navigation.goBack()}
      footer={
        <Row gap={10}>
          {editId ? <Button title="Delete" variant="ghost" icon="trash" onPress={remove} style={{ flex: 0.6 }} /> : null}
          <Button title="Save" icon="checkmark" onPress={save} style={{ flex: 1 }} />
        </Row>
      }
    >
      <ChipScroller>
        {REC_TYPES.map((t) => (
          <Chip key={t} label={TX_TYPE_LABEL[t]} icon={TX_TYPE_ICON[t]} color={txColor(c, t)} active={type === t} onPress={() => setType(t)} />
        ))}
      </ChipScroller>
      <Spacer h={12} />
      <TextField label="Description" value={description} onChangeText={setDescription} placeholder="e.g. Salary, Rent, DSTV, Data plan" maxLength={200} />
      <AmountField label="Amount" currency={cur} valueMinor={amount} onChangeMinor={setAmount} error={err('amountMinor')} />
      <SelectField label="Account" value={accountId} onChange={setAccountId} options={L.accounts.map((a) => ({ value: a.id, label: a.name, subtitle: a.currency }))} error={err('accountId')} />
      {type === 'transfer' ? <SelectField label="To account" value={toAccountId} onChange={setToAccountId} options={L.accounts.filter((a) => a.id !== accountId).map((a) => ({ value: a.id, label: a.name }))} error={err('toAccountId')} /> : null}
      {type === 'income' || type === 'expense' ? <SelectField label="Category" value={categoryId} onChange={setCategoryId} options={cats.map((x) => ({ value: x.id, label: x.name, icon: x.icon, color: x.color }))} error={err('categoryId')} /> : null}
      {type === 'debt_repayment' ? <SelectField label="Debt" value={debtId} onChange={setDebtId} options={L.debts.map((d) => ({ value: d.debt.id, label: d.debt.lenderName }))} error={err('debtId')} /> : null}
      {type === 'savings_deposit' ? <SelectField label="Goal" value={goalId} onChange={setGoalId} options={L.goals.map((g) => ({ value: g.goal.id, label: g.goal.name }))} error={err('goalId')} /> : null}
      <Txt v="caption" dim style={{ fontWeight: '700', marginBottom: 6 }}>
        Repeats
      </Txt>
      <ChipScroller>
        {RECURRENCE_FREQUENCIES.map((f) => (
          <Chip key={f} label={RECURRENCE_LABEL[f]} active={frequency === f} onPress={() => setFrequency(f)} />
        ))}
      </ChipScroller>
      <Spacer h={10} />
      {frequency === 'custom' ? (
        <Row gap={10} align="flex-start">
          <View style={{ flex: 1 }}>
            <TextField label="Every" value={interval} onChangeText={(v) => setInterval(v.replace(/\D/g, '').slice(0, 3))} keyboardType="number-pad" error={err('interval')} />
          </View>
          <View style={{ flex: 2, paddingTop: 22 }}>
            <Segmented value={unit} onChange={setUnit} options={[{ value: 'day', label: 'Days' }, { value: 'week', label: 'Weeks' }, { value: 'month', label: 'Months' }, { value: 'year', label: 'Years' }]} />
          </View>
        </Row>
      ) : null}
      <DateField label="First date" value={startDate} onChange={(v) => v && setStartDate(v)} error={err('startDate')} />
      <DateField label="End date (optional)" value={endDate} onChange={setEndDate} optional error={err('endDate')} />
      <Card padded={false} style={{ paddingHorizontal: 14, marginBottom: 12 }}>
        <SwitchRow label="Create automatically" description="Record the transaction on each due date. Off = reminders only." value={autoCreate} onChange={setAutoCreate} icon="flash" />
        {type === 'expense' ? <SwitchRow label="This is a bill" description="Shown as a bill in the calendar" value={isBill} onChange={setIsBill} icon="receipt" /> : null}
        <SwitchRow label="Active" value={active} onChange={setActive} icon="play" />
        {!editId && startDate < today() && autoCreate ? <SwitchRow label="Also create past occurrences" description={`Since ${formatDate(startDate)}`} value={backfill} onChange={setBackfill} icon="time" /> : null}
      </Card>
      <Txt v="caption" dim style={{ fontWeight: '700', marginBottom: 6 }}>
        Remind me
      </Txt>
      <ChipScroller>
        {[-1, 0, 1, 2, 3, 7].map((d) => (
          <Chip key={d} label={d < 0 ? 'No reminder' : d === 0 ? 'On the day' : `${d} day${d > 1 ? 's' : ''} before`} active={remind === d} onPress={() => setRemind(d)} />
        ))}
      </ChipScroller>
      {editId && L.existing?.lastGeneratedDate ? (
        <Row gap={6} style={{ marginTop: 14 }}>
          <Badge label="Info" color={c.info} />
          <Txt v="caption" dim>
            Last created: {formatDate(L.existing.lastGeneratedDate)}
          </Txt>
        </Row>
      ) : null}
      {err('form') ? (
        <Txt v="small" color={c.danger} style={{ marginTop: 10 }}>
          {err('form')}
        </Txt>
      ) : null}
    </Screen>
  );
}
