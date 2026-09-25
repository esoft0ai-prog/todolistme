import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { nowTime, today } from '../domain/dates';
import { formatMoney } from '../domain/money';
import { PAYMENT_METHODS, RECURRENCE_FREQUENCIES, TRANSACTION_TYPES, type PaymentMethod, type RecurrenceFrequency, type TransactionInput, type TransactionType } from '../domain/types';
import { firstError, validateTransaction, type FieldError } from '../domain/validation';
import type { RootScreenProps } from '../navigation/types';
import { listAccounts } from '../services/accounts';
import { listCategories } from '../services/categories';
import { listDebts } from '../services/debts';
import { listGoals } from '../services/goals';
import { saveRecurring } from '../services/recurring';
import { createTransaction, deleteTransaction, getTransaction, listTags, updateTransaction } from '../services/transactions';
import { mutate } from '../state/actions';
import { usePrefs } from '../state/appStore';
import { useQuery } from '../state/useQuery';
import { confirmDialog } from '../ui/components/feedback';
import { AmountField, DateField, SelectField, SwitchRow, TextField, TimeField } from '../ui/components/forms';
import { Button, Card, Chip, ChipScroller, Icon, LoadingBlock, Row, Screen, SectionHeader, Spacer, Txt } from '../ui/components/primitives';
import { ACCOUNT_TYPE_ICON, PAYMENT_METHOD_LABEL, RECURRENCE_LABEL, TX_TYPE_ICON, TX_TYPE_LABEL, txColor } from '../ui/labels';
import { useTheme } from '../ui/theme';

export function TransactionFormScreen({ navigation, route }: RootScreenProps<'TransactionForm'>) {
  const { c } = useTheme();
  const prefs = usePrefs();
  const editId = route.params?.id;
  const lookups = useQuery(async (ctx) => ({
    accounts: await listAccounts(ctx.db),
    allAccounts: await listAccounts(ctx.db, { includeArchived: true }),
    categories: await listCategories(ctx.db),
    debts: (await listDebts(ctx.db, ctx.today())).filter((d) => d.debt.status === 'active' || d.debt.id === route.params?.debtId),
    goals: (await listGoals(ctx)).filter((g) => g.goal.status !== 'archived'),
    tags: await listTags(ctx.db),
    existing: editId ? await getTransaction(ctx.db, editId) : null,
  }));

  const [type, setType] = useState<TransactionType>(route.params?.type ?? 'expense');
  const [amount, setAmount] = useState<number | null>(null);
  const [accountId, setAccountId] = useState<string | null>(route.params?.accountId ?? null);
  const [toAccountId, setToAccountId] = useState<string | null>(null);
  const [toAmount, setToAmount] = useState<number | null>(null);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [debtId, setDebtId] = useState<string | null>(route.params?.debtId ?? null);
  const [goalId, setGoalId] = useState<string | null>(route.params?.goalId ?? null);
  const [date, setDate] = useState<string>(today());
  const [time, setTime] = useState<string | null>(nowTime());
  const [description, setDescription] = useState('');
  const [method, setMethod] = useState<PaymentMethod | null>(null);
  const [tagsText, setTagsText] = useState('');
  const [notes, setNotes] = useState('');
  const [reference, setReference] = useState('');
  const [recurring, setRecurring] = useState(false);
  const [frequency, setFrequency] = useState<RecurrenceFrequency>('monthly');
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [saving, setSaving] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [initialised, setInitialised] = useState(false);

  const L = lookups.data;
  useEffect(() => {
    if (!L || initialised) return;
    const e = L.existing;
    if (e) {
      setType(e.type);
      setAmount(e.amountMinor);
      setAccountId(e.accountId);
      setToAccountId(e.toAccountId);
      setToAmount(e.toAmountMinor);
      setCategoryId(e.categoryId);
      setDebtId(e.debtId);
      setGoalId(e.goalId);
      setDate(e.date);
      setTime(e.time);
      setDescription(e.description);
      setMethod(e.paymentMethod);
      setTagsText(e.tags.join(', '));
      setNotes(e.notes ?? '');
      setReference(e.reference ?? '');
      setShowMore(!!(e.notes || e.reference || e.tags.length || e.paymentMethod));
    } else if (!accountId && L.accounts.length) {
      setAccountId(L.accounts.find((a) => a.type !== 'savings')?.id ?? L.accounts[0].id);
    }
    setInitialised(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [L]);

  const account = L?.allAccounts.find((a) => a.id === accountId);
  const toAccount = L?.allAccounts.find((a) => a.id === toAccountId);
  const currency = account?.currency ?? prefs.baseCurrency;
  const catKind = type === 'income' ? 'income' : 'expense';
  const categories = useMemo(() => (L?.categories ?? []).filter((x) => x.kind === catKind), [L, catKind]);
  const needsCategory = type === 'income' || type === 'expense';

  if (!L) {
    return (
      <Screen title={editId ? 'Edit transaction' : 'New transaction'} onBack={() => navigation.goBack()}>
        <LoadingBlock />
      </Screen>
    );
  }

  if (L.accounts.length === 0) {
    return (
      <Screen title="New transaction" onBack={() => navigation.goBack()}>
        <Card>
          <Txt v="h3">Create an account first</Txt>
          <Txt v="small" dim style={{ marginVertical: 8 }}>
            Transactions belong to an account such as Cash, a bank account or a mobile wallet.
          </Txt>
          <Button title="Add account" icon="add" onPress={() => navigation.replace('AccountForm')} />
        </Card>
      </Screen>
    );
  }

  const tags = tagsText
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

  const input = (): TransactionInput => ({
    type,
    amountMinor: amount ?? 0,
    date,
    time,
    accountId: accountId ?? '',
    toAccountId: type === 'transfer' ? toAccountId : null,
    toAmountMinor: type === 'transfer' && toAccount && account && toAccount.currency !== account.currency ? toAmount : null,
    categoryId: needsCategory || type === 'debt_repayment' ? categoryId ?? (type === 'debt_repayment' ? 'sys-exp-debt' : null) : null,
    debtId: type === 'debt_repayment' || type === 'loan_received' ? debtId : null,
    goalId: type === 'savings_deposit' || type === 'savings_withdrawal' ? goalId : null,
    recurringId: null,
    description,
    paymentMethod: method,
    notes: notes || null,
    reference: reference || null,
    tags,
  });

  const save = async (allowDuplicate = false) => {
    const i = input();
    const errs = validateTransaction(i);
    setErrors(errs);
    if (errs.length) return;
    setSaving(true);
    const res = await mutate(
      async (ctx) => {
        const t = editId ? await updateTransaction(ctx, editId, i) : await createTransaction(ctx, i, { allowDuplicate });
        if (!editId && recurring && type !== 'loan_received') {
          const rid = await saveRecurring(ctx, {
            type: type as Exclude<TransactionType, 'loan_received'>,
            amountMinor: i.amountMinor,
            accountId: i.accountId,
            toAccountId: i.toAccountId,
            categoryId: i.categoryId,
            debtId: i.debtId,
            goalId: i.goalId,
            description: i.description,
            paymentMethod: i.paymentMethod,
            frequency,
            interval: 1,
            unit: 'month',
            startDate: i.date,
            endDate: null,
            isBill: type === 'expense',
            autoCreate: true,
            remindDaysBefore: type === 'expense' ? 1 : -1,
            active: true,
          });
          // This transaction is the first occurrence.
          await ctx.db.run('UPDATE recurring_transactions SET last_generated_date = ? WHERE id = ?', [i.date, rid]);
          await ctx.db.run('UPDATE transactions SET recurring_id = ? WHERE id = ?', [rid, t.id]);
        }
        return t;
      },
      { success: editId ? 'Transaction updated' : 'Transaction saved', budgetCheck: true, silent: true },
    );
    setSaving(false);
    if (res.ok) {
      navigation.goBack();
      return;
    }
    if ('duplicateOf' in res && res.duplicateOf) {
      const again = await confirmDialog({
        title: 'Possible duplicate',
        message: `You recorded the same ${TX_TYPE_LABEL[type].toLowerCase()} of ${formatMoney(i.amountMinor, currency)} a moment ago. Save it again?`,
        confirmText: 'Save anyway',
        icon: 'copy',
      });
      if (again) await save(true);
      return;
    }
    setErrors([{ field: res.field ?? 'form', message: res.error }]);
  };

  const remove = async () => {
    if (!editId) return;
    const ok = await confirmDialog({
      title: 'Delete transaction?',
      message: L.existing?.debtId && L.existing.type === 'debt_repayment' ? 'The linked debt repayment will also be removed and the debt balance will go back up.' : 'This cannot be undone.',
      confirmText: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    const res = await mutate((ctx) => deleteTransaction(ctx, editId), { success: 'Transaction deleted' });
    if (res.ok) navigation.goBack();
  };

  const err = (f: string) => firstError(errors, f);
  const formError = errors.find((e) => e.field === 'form')?.message;
  const accountOptions = L.accounts.map((a) => ({ value: a.id, label: a.name, subtitle: `${formatMoney(a.balanceMinor, a.currency)} · ${a.currency}`, icon: ACCOUNT_TYPE_ICON[a.type] }));

  return (
    <Screen
      title={editId ? 'Edit transaction' : 'New transaction'}
      onBack={() => navigation.goBack()}
      footer={
        <Row gap={10}>
          {editId ? <Button title="Delete" variant="ghost" icon="trash" onPress={remove} style={{ flex: 0.6 }} /> : null}
          <Button title={editId ? 'Save changes' : 'Save'} icon="checkmark" onPress={() => save()} loading={saving} style={{ flex: 1 }} />
        </Row>
      }
    >
      {L.existing?.recurringId ? (
        <Card style={{ marginBottom: 12 }}>
          <Row gap={8}>
            <Icon name="repeat" size={16} color={c.info} />
            <Txt v="caption" dim style={{ flex: 1 }}>
              Created from a recurring schedule. Edits here only change this occurrence.
            </Txt>
          </Row>
        </Card>
      ) : null}

      <Txt v="caption" dim style={{ marginBottom: 6, fontWeight: '700' }}>
        Type
      </Txt>
      <ChipScroller>
        {TRANSACTION_TYPES.map((t) => (
          <Chip
            key={t}
            label={TX_TYPE_LABEL[t]}
            icon={TX_TYPE_ICON[t]}
            color={txColor(c, t)}
            active={type === t}
            onPress={() => {
              setType(t);
              setCategoryId(null);
              setErrors([]);
            }}
          />
        ))}
      </ChipScroller>
      <Spacer h={14} />

      <AmountField label="Amount" currency={currency} valueMinor={amount} onChangeMinor={setAmount} error={err('amountMinor')} big autoFocus={!editId} />

      <SelectField label={type === 'transfer' ? 'From account' : type === 'income' || type === 'loan_received' || type === 'savings_withdrawal' ? 'Into account' : 'From account'} value={accountId} options={accountOptions} onChange={setAccountId} error={err('accountId')} />

      {type === 'transfer' ? (
        <>
          <SelectField label="To account" value={toAccountId} options={accountOptions.filter((a) => a.value !== accountId)} onChange={setToAccountId} error={err('toAccountId')} />
          {toAccount && account && toAccount.currency !== account.currency ? (
            <AmountField label={`Amount received (${toAccount.currency})`} currency={toAccount.currency} valueMinor={toAmount} onChangeMinor={setToAmount} hint="Leave empty to convert using your saved exchange rate." error={err('toAmountMinor')} />
          ) : null}
          <Txt v="caption" faint style={{ marginTop: -6, marginBottom: 10 }}>
            Transfers move money between your accounts and are never counted as income or spending.
          </Txt>
        </>
      ) : null}

      {needsCategory ? (
        <View style={{ marginBottom: 12 }}>
          <Row justify="space-between" style={{ marginBottom: 6 }}>
            <Txt v="caption" dim style={{ fontWeight: '700' }}>
              Category
            </Txt>
            <Pressable onPress={() => navigation.navigate('Categories')} accessibilityRole="button" hitSlop={8}>
              <Txt v="caption" color={c.primary} style={{ fontWeight: '700' }}>
                Manage
              </Txt>
            </Pressable>
          </Row>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {categories.map((x) => (
              <Chip key={x.id} label={x.name} icon={x.icon} color={x.color} active={categoryId === x.id} onPress={() => setCategoryId(x.id)} />
            ))}
          </View>
          {err('categoryId') ? (
            <Txt v="caption" color={c.danger} style={{ marginTop: 6 }}>
              {err('categoryId')}
            </Txt>
          ) : null}
        </View>
      ) : null}

      {type === 'debt_repayment' || type === 'loan_received' ? (
        <SelectField
          label={type === 'debt_repayment' ? 'Debt being repaid' : 'Link to a debt (optional)'}
          value={debtId}
          allowClear={type === 'loan_received'}
          options={L.debts.map((d) => ({ value: d.debt.id, label: d.debt.lenderName, subtitle: `Outstanding ${formatMoney(d.summary.outstandingMinor, d.debt.currency)}`, icon: 'card' }))}
          onChange={setDebtId}
          error={err('debtId')}
          hint={L.debts.length === 0 ? 'No active debts. Add one from the Debts tab.' : undefined}
        />
      ) : null}

      {type === 'savings_deposit' || type === 'savings_withdrawal' ? (
        <SelectField
          label="Savings goal"
          value={goalId}
          options={L.goals.map((g) => ({ value: g.goal.id, label: g.goal.name, subtitle: `${formatMoney(g.progress.savedMinor, g.goal.currency)} of ${formatMoney(g.goal.targetMinor, g.goal.currency)}`, icon: g.goal.icon, color: g.goal.color }))}
          onChange={setGoalId}
          error={err('goalId')}
          hint={L.goals.length === 0 ? 'No goals yet. Create one in Plan → Goals.' : undefined}
        />
      ) : null}

      <Row gap={10} align="flex-start">
        <View style={{ flex: 1.4 }}>
          <DateField label="Date" value={date} onChange={(v) => v && setDate(v)} error={err('date')} />
        </View>
        <View style={{ flex: 1 }}>
          <TimeField label="Time" value={time} onChange={setTime} optional />
        </View>
      </Row>

      <TextField label="Description" value={description} onChangeText={setDescription} placeholder={type === 'expense' ? 'e.g. Market foodstuff' : type === 'income' ? 'e.g. March salary' : 'Optional'} maxLength={500} error={err('description')} />

      {!editId && type !== 'loan_received' ? (
        <Card style={{ marginBottom: 12 }} padded={false}>
          <View style={{ paddingHorizontal: 14 }}>
            <SwitchRow label="Repeat automatically" description="Create this transaction again on a schedule" value={recurring} onChange={setRecurring} icon="repeat" />
            {recurring ? (
              <View style={{ paddingBottom: 12 }}>
                <ChipScroller>
                  {RECURRENCE_FREQUENCIES.filter((f) => f !== 'custom').map((f) => (
                    <Chip key={f} label={RECURRENCE_LABEL[f]} active={frequency === f} onPress={() => setFrequency(f)} />
                  ))}
                </ChipScroller>
              </View>
            ) : null}
          </View>
        </Card>
      ) : null}

      <Pressable onPress={() => setShowMore(!showMore)} accessibilityRole="button" style={{ paddingVertical: 8 }}>
        <Row gap={6}>
          <Icon name={showMore ? 'chevron-up' : 'chevron-down'} size={16} color={c.primary} />
          <Txt v="small" color={c.primary} style={{ fontWeight: '700' }}>
            {showMore ? 'Fewer details' : 'More details (payment method, tags, notes, reference)'}
          </Txt>
        </Row>
      </Pressable>

      {showMore ? (
        <>
          <SectionHeader title="Payment method" />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
            {PAYMENT_METHODS.map((m) => (
              <Chip key={m} label={PAYMENT_METHOD_LABEL[m]} active={method === m} onPress={() => setMethod(method === m ? null : m)} />
            ))}
          </View>
          <TextField label="Tags" value={tagsText} onChangeText={setTagsText} placeholder="e.g. family, work, market" hint="Separate tags with commas" error={err('tags')} />
          {L.tags.length ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: -4, marginBottom: 12 }}>
              {L.tags.slice(0, 12).map((t) => (
                <Chip
                  key={t.id}
                  label={`#${t.name}`}
                  active={tags.map((x) => x.toLowerCase()).includes(t.name.toLowerCase())}
                  onPress={() => {
                    const has = tags.map((x) => x.toLowerCase()).includes(t.name.toLowerCase());
                    setTagsText((has ? tags.filter((x) => x.toLowerCase() !== t.name.toLowerCase()) : [...tags, t.name]).join(', '));
                  }}
                />
              ))}
            </View>
          ) : null}
          <TextField label="Reference / receipt number" value={reference} onChangeText={setReference} placeholder="e.g. bank transfer reference" maxLength={200} />
          <TextField label="Notes" value={notes} onChangeText={setNotes} multiline maxLength={2000} />
        </>
      ) : null}

      {formError ? (
        <Card tone="danger" style={{ marginTop: 8 }}>
          <Txt v="small" color={c.danger}>
            {formError}
          </Txt>
        </Card>
      ) : null}
    </Screen>
  );
}
