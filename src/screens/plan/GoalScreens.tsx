import React, { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import { CURRENCIES } from '../../domain/currency';
import { addMonths, formatDate, today } from '../../domain/dates';
import { formatMoney } from '../../domain/money';
import { validateGoal } from '../../domain/savings';
import { firstError, type FieldError } from '../../domain/validation';
import type { RootScreenProps } from '../../navigation/types';
import { listAccounts } from '../../services/accounts';
import { contribute, createGoal, deleteGoal, getGoalView, updateGoal } from '../../services/goals';
import { listTransactions } from '../../services/transactions';
import { mutate } from '../../state/actions';
import { usePrefs } from '../../state/appStore';
import { useQuery } from '../../state/useQuery';
import { LineChart, ProgressRing } from '../../ui/components/charts';
import { chooseDialog, confirmDialog } from '../../ui/components/feedback';
import { AmountField, DateField, SelectField, TextField } from '../../ui/components/forms';
import { Badge, Button, Card, Chip, EmptyState, Icon, IconButton, ListRow, LoadingBlock, ProgressBar, Row, Screen, SectionHeader, Segmented, Spacer, StatPill, Txt } from '../../ui/components/primitives';
import { ACCOUNT_TYPE_ICON, COLOR_SWATCHES } from '../../ui/labels';
import { useTheme } from '../../ui/theme';

const GOAL_ICONS = ['flag', 'laptop', 'phone-portrait', 'car', 'home', 'school', 'airplane', 'medkit', 'shield-checkmark', 'gift', 'heart', 'briefcase', 'bicycle', 'diamond'];

export function GoalFormScreen({ navigation, route }: RootScreenProps<'GoalForm'>) {
  const { c } = useTheme();
  const prefs = usePrefs();
  const editId = route.params?.id;
  const q = useQuery(async (ctx) => ({ accounts: await listAccounts(ctx.db), existing: editId ? await getGoalView(ctx, editId) : null }));
  const [name, setName] = useState('');
  const [target, setTarget] = useState<number | null>(null);
  const [initial, setInitial] = useState<number | null>(null);
  const [currency, setCurrency] = useState(prefs.baseCurrency);
  const [startDate, setStartDate] = useState(today());
  const [deadline, setDeadline] = useState<string | null>(addMonths(today(), 6));
  const [linked, setLinked] = useState<string | null>(null);
  const [icon, setIcon] = useState('flag');
  const [color, setColor] = useState(COLOR_SWATCHES[1]);
  const [reminder, setReminder] = useState<'none' | 'weekly' | 'monthly'>('monthly');
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!q.data || loaded) return;
    const g = q.data.existing?.goal;
    if (g) {
      setName(g.name);
      setTarget(g.targetMinor);
      setInitial(g.initialMinor || null);
      setCurrency(g.currency);
      setStartDate(g.startDate);
      setDeadline(g.deadline);
      setLinked(g.linkedAccountId);
      setIcon(g.icon);
      setColor(g.color);
      setReminder(g.reminderFrequency);
      setNotes(g.notes ?? '');
    }
    setLoaded(true);
  }, [q.data, loaded]);
  if (!q.data) {
    return (
      <Screen title="Goal" onBack={() => navigation.goBack()}>
        <LoadingBlock />
      </Screen>
    );
  }
  const save = async () => {
    const input = { name, targetMinor: target ?? 0, initialMinor: initial ?? 0, currency, startDate, deadline, linkedAccountId: linked, icon, color, reminderFrequency: reminder, notes: notes || null };
    const errs = validateGoal(editId ? { ...input, id: editId } : input, today());
    setErrors(errs);
    if (errs.length) return;
    const res = await mutate<unknown>((ctx) => (editId ? updateGoal(ctx, editId, input) : createGoal(ctx, input)), { success: editId ? 'Goal updated' : 'Goal created', silent: true });
    if (res.ok) navigation.goBack();
    else setErrors([{ field: res.field ?? 'form', message: res.error }]);
  };
  const err = (f: string) => firstError(errors, f);
  return (
    <Screen title={editId ? 'Edit goal' : 'New savings goal'} onBack={() => navigation.goBack()} footer={<Button title="Save goal" icon="checkmark" onPress={save} />}>
      <TextField label="Goal name" value={name} onChangeText={setName} placeholder="e.g. New Laptop" error={err('name')} maxLength={80} autoFocus={!editId} />
      <AmountField label="Target amount" currency={currency} valueMinor={target} onChangeMinor={setTarget} error={err('targetMinor')} big />
      <AmountField label="Already saved (optional)" currency={currency} valueMinor={initial} onChangeMinor={setInitial} allowZero error={err('initialMinor')} />
      <SelectField label="Currency" value={currency} onChange={(v) => v && setCurrency(v)} options={CURRENCIES.map((x) => ({ value: x.code, label: `${x.code} — ${x.name}` }))} />
      <Row gap={10} align="flex-start">
        <View style={{ flex: 1 }}>
          <DateField label="Start" value={startDate} onChange={(v) => v && setStartDate(v)} />
        </View>
        <View style={{ flex: 1 }}>
          <DateField label="Deadline" value={deadline} onChange={setDeadline} optional error={err('deadline')} />
        </View>
      </Row>
      <SelectField
        label="Keep the money in (optional)"
        value={linked}
        allowClear
        onChange={setLinked}
        options={q.data.accounts.map((a) => ({ value: a.id, label: a.name, subtitle: a.type === 'savings' ? 'Savings account' : a.currency, icon: ACCOUNT_TYPE_ICON[a.type] }))}
        hint={linked ? 'Deposits move money into this account.' : 'Without a linked account, deposits are set aside from your spendable balance.'}
      />
      <Txt v="caption" dim style={{ fontWeight: '700', marginBottom: 6 }}>
        Saving reminders
      </Txt>
      <Segmented value={reminder} onChange={setReminder} options={[{ value: 'none', label: 'Off' }, { value: 'weekly', label: 'Weekly' }, { value: 'monthly', label: 'Monthly' }]} />
      <Spacer h={14} />
      <Txt v="caption" dim style={{ fontWeight: '700', marginBottom: 6 }}>
        Icon & colour
      </Txt>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
        {GOAL_ICONS.map((i) => (
          <Pressable key={i} onPress={() => setIcon(i)} accessibilityRole="button" accessibilityLabel={`Icon ${i}`} accessibilityState={{ selected: icon === i }} style={{ width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: icon === i ? color + '33' : c.inputBg, borderWidth: 1, borderColor: icon === i ? color : c.border }}>
            <Icon name={i} size={20} color={icon === i ? color : c.textDim} />
          </Pressable>
        ))}
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 14 }}>
        {COLOR_SWATCHES.map((col) => (
          <Pressable key={col} onPress={() => setColor(col)} accessibilityRole="button" accessibilityLabel={`Colour ${col}`} accessibilityState={{ selected: color === col }} style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: col, borderWidth: color === col ? 3 : 0, borderColor: c.text }} />
        ))}
      </View>
      <TextField label="Notes" value={notes} onChangeText={setNotes} multiline maxLength={1000} />
      {err('form') ? (
        <Txt v="small" color={c.danger}>
          {err('form')}
        </Txt>
      ) : null}
    </Screen>
  );
}

export function GoalDetailScreen({ navigation, route }: RootScreenProps<'GoalDetail'>) {
  const { c } = useTheme();
  const id = route.params.id;
  const q = useQuery(async (ctx) => {
    const view = await getGoalView(ctx, id);
    return view ? { view, txs: await listTransactions(ctx.db, { goalId: id, limit: 200 }) } : null;
  }, [id]);
  if (!q.data) {
    return (
      <Screen title="Goal" onBack={() => navigation.goBack()}>
        {q.loading ? <LoadingBlock /> : <EmptyState icon="flag" title="Goal not found" message="It may have been deleted." />}
      </Screen>
    );
  }
  const { view, txs } = q.data;
  const g = view.goal;
  const p = view.progress;
  const m = (x: number | null) => (x == null ? '—' : formatMoney(x, g.currency));
  let running = g.initialMinor;
  const history = [{ label: 'Start', value: running }, ...view.contributions.map((x) => ({ label: x.date.slice(5).replace('-', '/'), value: (running += x.amountMinor) }))];

  const more = async () => {
    const choice = await chooseDialog(g.name, undefined, [
      { text: 'Edit goal', value: 'edit', variant: 'secondary' },
      { text: g.status === 'archived' ? 'Unarchive' : 'Archive', value: 'archive', variant: 'secondary' },
      { text: 'Delete goal', value: 'delete', variant: 'danger' },
      { text: 'Cancel', value: 'cancel', variant: 'ghost' },
    ]);
    if (choice === 'edit') navigation.navigate('GoalForm', { id });
    if (choice === 'archive') await mutate((ctx) => updateGoal(ctx, id, { ...g, archived: g.status !== 'archived' }), { success: 'Goal updated' });
    if (choice === 'delete' && (await confirmDialog({ title: 'Delete goal?', message: 'Only goals without deposits can be deleted.', confirmText: 'Delete', destructive: true }))) {
      const res = await mutate((ctx) => deleteGoal(ctx, id), { success: 'Goal deleted' });
      if (res.ok) navigation.goBack();
    }
  };

  return (
    <Screen
      title={g.name}
      subtitle={g.deadline ? `Deadline ${formatDate(g.deadline)}` : 'No deadline'}
      onBack={() => navigation.goBack()}
      right={<IconButton icon="ellipsis-horizontal" label="More actions" onPress={more} />}
      footer={
        g.status !== 'archived' ? (
          <Row gap={10}>
            <Button title="Withdraw" variant="ghost" icon="remove" onPress={() => navigation.navigate('GoalContribution', { goalId: id, kind: 'withdraw' })} style={{ flex: 1 }} disabled={p.savedMinor <= 0} />
            <Button title="Add money" icon="add" onPress={() => navigation.navigate('GoalContribution', { goalId: id, kind: 'deposit' })} style={{ flex: 1.4 }} />
          </Row>
        ) : undefined
      }
    >
      <Card>
        <Row gap={16}>
          <ProgressRing value={p.percent} size={110} stroke={11} color={g.color} label="Goal progress">
            <Txt v="h2">{Math.round(p.percent * 100)}%</Txt>
          </ProgressRing>
          <View style={{ flex: 1 }}>
            <Txt v="caption" dim>
              Saved
            </Txt>
            <Txt v="h1" numberOfLines={1} adjustsFontSizeToFit>
              {m(p.savedMinor)}
            </Txt>
            <Txt v="small" dim>
              of {m(g.targetMinor)}
            </Txt>
            <Row gap={6} style={{ marginTop: 6 }}>
              {p.state === 'on_track' ? <Badge label="On track" color={c.success} /> : null}
              {p.state === 'behind' ? <Badge label="Behind" color={c.warning} /> : null}
              {p.state === 'completed' ? <Badge label="Completed" color={c.success} /> : null}
              {p.state === 'overdue' ? <Badge label="Deadline passed" color={c.danger} /> : null}
            </Row>
          </View>
        </Row>
        <Txt v="small" style={{ marginTop: 12 }} color={p.state === 'behind' || p.state === 'overdue' ? c.warning : c.textDim}>
          {p.message}
        </Txt>
      </Card>
      <Spacer h={12} />
      <Row gap={10}>
        <StatPill label="Remaining" value={m(p.remainingMinor)} />
        <StatPill label="Days left" value={p.daysLeft == null ? '—' : String(Math.max(0, p.daysLeft))} />
      </Row>
      <Spacer h={10} />
      <Row gap={10}>
        <StatPill label="Needed per week" value={m(p.requiredWeeklyMinor)} color={c.accent} />
        <StatPill label="Needed per month" value={m(p.requiredMonthlyMinor)} color={c.accent} />
      </Row>
      <Spacer h={10} />
      <Row gap={10}>
        <StatPill label="Your pace / month" value={m(p.currentMonthlyRateMinor)} color={p.onTrack === false ? c.warning : undefined} />
        <StatPill label="Projected finish" value={p.projectedCompletionDate ? formatDate(p.projectedCompletionDate) : '—'} />
      </Row>
      {p.timeProgress != null ? (
        <>
          <SectionHeader title="Time vs money" />
          <Card>
            <Txt v="caption" dim>
              Time elapsed {Math.round(p.timeProgress * 100)}%
            </Txt>
            <ProgressBar value={p.timeProgress} color={c.textFaint} />
            <Spacer h={8} />
            <Txt v="caption" dim>
              Money saved {Math.round(p.percent * 100)}%
            </Txt>
            <ProgressBar value={p.percent} color={g.color} />
          </Card>
        </>
      ) : null}
      {history.length > 2 ? (
        <>
          <SectionHeader title="Savings history" />
          <Card>
            <LineChart points={history} color={g.color} currency={g.currency} />
          </Card>
        </>
      ) : null}
      <SectionHeader title="Deposits & withdrawals" />
      <Card padded={false} style={{ paddingHorizontal: 16 }}>
        {txs.length === 0 ? (
          <Txt v="small" dim style={{ paddingVertical: 16 }}>
            No deposits yet. Tap “Add money” to start.
          </Txt>
        ) : (
          txs.map((t) => (
            <ListRow
              key={t.id}
              icon={t.type === 'savings_deposit' ? 'arrow-down-circle' : 'arrow-up-circle'}
              iconColor={t.type === 'savings_deposit' ? c.success : c.warning}
              title={t.type === 'savings_deposit' ? 'Deposit' : 'Withdrawal'}
              subtitle={formatDate(t.date)}
              right={`${t.type === 'savings_deposit' ? '+' : '−'}${formatMoney(t.amountMinor, t.currency)}`}
              onPress={() => navigation.navigate('TransactionForm', { id: t.id })}
            />
          ))
        )}
      </Card>
    </Screen>
  );
}

export function GoalContributionScreen({ navigation, route }: RootScreenProps<'GoalContribution'>) {
  const { goalId, kind } = route.params;
  const q = useQuery(async (ctx) => ({ view: await getGoalView(ctx, goalId), accounts: await listAccounts(ctx.db) }), [goalId]);
  const [amount, setAmount] = useState<number | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [date, setDate] = useState(today());
  const [error, setError] = useState<string>();
  useEffect(() => {
    const v = q.data?.view;
    if (!v || accountId) return;
    const acc = q.data!.accounts.find((a) => a.id !== v.goal.linkedAccountId && a.type !== 'savings');
    if (acc) setAccountId(acc.id);
    if (kind === 'deposit' && v.progress.requiredMonthlyMinor) setAmount(Math.min(v.progress.requiredMonthlyMinor, v.progress.remainingMinor));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data]);
  if (!q.data?.view) {
    return (
      <Screen title="Savings" onBack={() => navigation.goBack()}>
        <LoadingBlock />
      </Screen>
    );
  }
  const v = q.data.view;
  const save = async () => {
    if (!amount) return setError('Enter an amount');
    if (!accountId) return setError('Choose an account');
    const res = await mutate((ctx) => contribute(ctx, goalId, kind, { amountMinor: amount, accountId, date }), {
      success: kind === 'deposit' ? (amount >= v.progress.remainingMinor ? 'Goal reached! 🎉' : 'Saved towards your goal') : 'Withdrawal recorded',
      silent: true,
    });
    if (res.ok) navigation.goBack();
    else setError(res.error);
  };
  return (
    <Screen title={kind === 'deposit' ? 'Add to savings' : 'Withdraw savings'} subtitle={v.goal.name} onBack={() => navigation.goBack()} footer={<Button title={kind === 'deposit' ? 'Save deposit' : 'Withdraw'} icon="checkmark" onPress={save} />}>
      <AmountField label="Amount" currency={v.goal.currency} valueMinor={amount} onChangeMinor={(x) => (setAmount(x), setError(undefined))} error={error} big autoFocus />
      {kind === 'deposit' && v.progress.requiredWeeklyMinor ? (
        <Row gap={8} style={{ marginBottom: 12, flexWrap: 'wrap' }}>
          <Chip label={`Weekly target ${formatMoney(v.progress.requiredWeeklyMinor, v.goal.currency, { compact: true })}`} onPress={() => setAmount(v.progress.requiredWeeklyMinor)} />
          {v.progress.requiredMonthlyMinor ? <Chip label={`Monthly ${formatMoney(v.progress.requiredMonthlyMinor, v.goal.currency, { compact: true })}`} onPress={() => setAmount(v.progress.requiredMonthlyMinor)} /> : null}
          <Chip label="Remaining" onPress={() => setAmount(v.progress.remainingMinor)} />
        </Row>
      ) : null}
      <SelectField
        label={kind === 'deposit' ? 'Take money from' : 'Put money into'}
        value={accountId}
        onChange={setAccountId}
        options={q.data.accounts.filter((a) => a.id !== v.goal.linkedAccountId).map((a) => ({ value: a.id, label: a.name, subtitle: formatMoney(a.balanceMinor, a.currency), icon: ACCOUNT_TYPE_ICON[a.type] }))}
      />
      <DateField label="Date" value={date} onChange={(x) => x && setDate(x)} />
    </Screen>
  );
}
