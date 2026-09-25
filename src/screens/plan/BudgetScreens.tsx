import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { validateBudget } from '../../domain/budget';
import { formatDate, startOfMonth, startOfWeek, today } from '../../domain/dates';
import { formatMoney } from '../../domain/money';
import type { BudgetPeriod } from '../../domain/types';
import { firstError, type FieldError } from '../../domain/validation';
import type { RootScreenProps } from '../../navigation/types';
import { budgetViews, createBudget, deleteBudget, updateBudget } from '../../services/budgets';
import { listCategories } from '../../services/categories';
import { listTransactions } from '../../services/transactions';
import { mutate } from '../../state/actions';
import { usePrefs } from '../../state/appStore';
import { useQuery } from '../../state/useQuery';
import { ProgressRing } from '../../ui/components/charts';
import { confirmDialog } from '../../ui/components/feedback';
import { AmountField, DateField, TextField } from '../../ui/components/forms';
import { Button, Card, Chip, EmptyState, IconButton, ListRow, LoadingBlock, Row, Screen, SectionHeader, Segmented, Spacer, StatPill, Txt } from '../../ui/components/primitives';
import { useTheme } from '../../ui/theme';
import { budgetStateColor } from './PlanScreen';

export function BudgetFormScreen({ navigation, route }: RootScreenProps<'BudgetForm'>) {
  const { c } = useTheme();
  const prefs = usePrefs();
  const editId = route.params?.id;
  const q = useQuery(async (ctx) => ({
    categories: await listCategories(ctx.db, { kind: 'expense' }),
    existing: editId ? (await budgetViews(ctx, { includeArchived: true })).find((b) => b.budget.id === editId)?.budget ?? null : null,
  }));
  const [name, setName] = useState('');
  const [period, setPeriod] = useState<BudgetPeriod>('monthly');
  const [limit, setLimit] = useState<number | null>(null);
  const [startDate, setStartDate] = useState(startOfMonth(today()));
  const [endDate, setEndDate] = useState<string | null>(null);
  const [cats, setCats] = useState<string[]>([]);
  const [threshold, setThreshold] = useState(0.8);
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!q.data || loaded) return;
    const e = q.data.existing;
    if (e) {
      setName(e.name);
      setPeriod(e.period);
      setLimit(e.limitMinor);
      setStartDate(e.startDate);
      setEndDate(e.endDate);
      setCats(e.categoryIds);
      setThreshold(e.alertThreshold);
    }
    setLoaded(true);
  }, [q.data, loaded]);

  if (!q.data) {
    return (
      <Screen title="Budget" onBack={() => navigation.goBack()}>
        <LoadingBlock />
      </Screen>
    );
  }
  const save = async () => {
    const input = { name: name || (cats.length === 1 ? q.data!.categories.find((x) => x.id === cats[0])?.name ?? '' : ''), period, limitMinor: limit ?? 0, startDate, endDate, categoryIds: cats, alertThreshold: threshold };
    const errs = validateBudget(input);
    setErrors(errs);
    if (errs.length) return;
    const res = await mutate<unknown>((ctx) => (editId ? updateBudget(ctx, editId, input) : createBudget(ctx, input)), { success: editId ? 'Budget updated' : 'Budget created', silent: true, budgetCheck: true });
    if (res.ok) navigation.goBack();
    else setErrors([{ field: res.field ?? 'form', message: res.error }]);
  };
  const remove = async () => {
    if (!editId || !(await confirmDialog({ title: 'Delete budget?', message: 'Your transactions are not affected.', confirmText: 'Delete', destructive: true }))) return;
    const res = await mutate((ctx) => deleteBudget(ctx, editId), { success: 'Budget deleted' });
    if (res.ok) navigation.pop(2);
  };
  const err = (f: string) => firstError(errors, f);
  return (
    <Screen
      title={editId ? 'Edit budget' : 'New budget'}
      onBack={() => navigation.goBack()}
      footer={
        <Row gap={10}>
          {editId ? <Button title="Delete" variant="ghost" icon="trash" onPress={remove} style={{ flex: 0.6 }} /> : null}
          <Button title="Save" icon="checkmark" onPress={save} style={{ flex: 1 }} />
        </Row>
      }
    >
      <Segmented
        value={period}
        onChange={(p) => {
          setPeriod(p);
          if (p === 'weekly') setStartDate(startOfWeek(today(), prefs.weekStartsOn));
          if (p === 'monthly') setStartDate(startOfMonth(today()));
        }}
        options={[{ value: 'monthly', label: 'Monthly' }, { value: 'weekly', label: 'Weekly' }, { value: 'custom', label: 'Custom dates' }]}
      />
      <Spacer h={14} />
      <Txt v="caption" dim style={{ fontWeight: '700', marginBottom: 6 }}>
        Categories (leave empty to include all expenses)
      </Txt>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
        {q.data.categories.map((x) => (
          <Chip key={x.id} label={x.name} icon={x.icon} color={x.color} active={cats.includes(x.id)} onPress={() => setCats((cs) => (cs.includes(x.id) ? cs.filter((i) => i !== x.id) : [...cs, x.id]))} />
        ))}
      </View>
      <TextField label="Budget name" value={name} onChangeText={setName} placeholder={cats.length === 1 ? q.data.categories.find((x) => x.id === cats[0])?.name : 'e.g. Food'} error={err('name')} maxLength={80} />
      <AmountField label={`Limit per ${period === 'weekly' ? 'week' : period === 'monthly' ? 'month' : 'period'}`} currency={prefs.baseCurrency} valueMinor={limit} onChangeMinor={setLimit} error={err('limitMinor')} big />
      <DateField
        label={period === 'custom' ? 'Start date' : period === 'monthly' ? 'Period starts on (e.g. salary day)' : 'Week starts on'}
        value={startDate}
        onChange={(v) => v && setStartDate(v)}
        error={err('startDate')}
        hint={period === 'monthly' ? `Each period starts on day ${Number(startDate.slice(8))} of the month.` : undefined}
      />
      {period === 'custom' ? <DateField label="End date" value={endDate} onChange={setEndDate} error={err('endDate')} minimumDate={startDate} /> : null}
      <Txt v="caption" dim style={{ fontWeight: '700', marginBottom: 6 }}>
        Warn me at
      </Txt>
      <Row gap={8}>
        {[0.5, 0.75, 0.8, 0.9, 1].map((t) => (
          <Chip key={t} label={`${Math.round(t * 100)}%`} active={threshold === t} onPress={() => setThreshold(t)} />
        ))}
      </Row>
      {err('form') ? (
        <Txt v="small" color={c.danger} style={{ marginTop: 12 }}>
          {err('form')}
        </Txt>
      ) : null}
    </Screen>
  );
}

export function BudgetDetailScreen({ navigation, route }: RootScreenProps<'BudgetDetail'>) {
  const { c } = useTheme();
  const prefs = usePrefs();
  const id = route.params.id;
  const q = useQuery(async (ctx) => {
    const view = (await budgetViews(ctx, { includeArchived: true })).find((b) => b.budget.id === id) ?? null;
    if (!view) return null;
    const txs = await listTransactions(ctx.db, {
      range: view.status.range,
      types: view.budget.categoryIds.length ? ['expense', 'debt_repayment'] : ['expense'],
      categoryIds: view.budget.categoryIds.length ? view.budget.categoryIds : undefined,
      limit: 200,
    });
    return { view, txs };
  }, [id]);
  if (!q.data) {
    return (
      <Screen title="Budget" onBack={() => navigation.goBack()}>
        {q.loading ? <LoadingBlock /> : <EmptyState icon="pie-chart" title="Budget not found" message="It may have been deleted." />}
      </Screen>
    );
  }
  const { view, txs } = q.data;
  const s = view.status;
  const cur = prefs.baseCurrency;
  const m = (x: number) => formatMoney(x, cur);
  const col = budgetStateColor(c, s.state);
  return (
    <Screen title={view.budget.name} subtitle={`${formatDate(s.range.start)} – ${formatDate(s.range.end)}`} onBack={() => navigation.goBack()} right={<IconButton icon="create-outline" label="Edit budget" onPress={() => navigation.navigate('BudgetForm', { id })} />}>
      <Card tone={s.state === 'exceeded' ? 'danger' : s.state === 'at_risk' ? 'warning' : undefined}>
        <Row gap={16}>
          <ProgressRing value={s.percentUsed} size={100} stroke={10} color={col} label="Budget used">
            <Txt v="h3">{Math.round(s.percentUsed * 100)}%</Txt>
            <Txt v="caption" faint>
              used
            </Txt>
          </ProgressRing>
          <View style={{ flex: 1 }}>
            <Txt v="caption" dim>
              Remaining
            </Txt>
            <Txt v="h1" color={s.remainingMinor < 0 ? c.danger : c.text} numberOfLines={1} adjustsFontSizeToFit>
              {m(s.remainingMinor)}
            </Txt>
            <Txt v="small" color={s.state === 'ok' ? c.textDim : col}>
              {s.message}
            </Txt>
          </View>
        </Row>
      </Card>
      <Spacer h={12} />
      <Row gap={10}>
        <StatPill label="Spent" value={m(s.spentMinor)} />
        <StatPill label="Limit" value={m(s.limitMinor)} />
      </Row>
      <Spacer h={10} />
      <Row gap={10}>
        <StatPill label="Days remaining" value={String(s.daysRemaining)} />
        <StatPill label="Daily pace" value={m(s.dailyPaceMinor)} color={s.projectedSpendMinor > s.limitMinor ? c.warning : undefined} />
      </Row>
      <Spacer h={10} />
      <Row gap={10}>
        <StatPill label="Safe to spend / day" value={m(s.safeDailyMinor)} color={c.accent} />
        <StatPill label="Projected total" value={m(s.projectedSpendMinor)} color={s.projectedSpendMinor > s.limitMinor ? c.danger : undefined} />
      </Row>
      <SectionHeader title={`Transactions this period (${txs.length})`} />
      <Card padded={false} style={{ paddingHorizontal: 16 }}>
        {txs.length === 0 ? (
          <Txt v="small" dim style={{ paddingVertical: 16 }}>
            No spending recorded in this period.
          </Txt>
        ) : (
          txs.map((t) => <ListRow key={t.id} icon="receipt" iconColor={c.danger} title={t.description || 'Expense'} subtitle={formatDate(t.date)} right={formatMoney(t.amountMinor, t.currency)} onPress={() => navigation.navigate('TransactionForm', { id: t.id })} />)
        )}
      </Card>
    </Screen>
  );
}
