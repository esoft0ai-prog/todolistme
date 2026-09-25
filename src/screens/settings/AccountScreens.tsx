import React, { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import { CURRENCIES } from '../../domain/currency';
import { formatMoney } from '../../domain/money';
import { ACCOUNT_TYPES, type AccountType, type CategoryKind } from '../../domain/types';
import { firstError, validateAccount, type FieldError } from '../../domain/validation';
import type { RootScreenProps } from '../../navigation/types';
import { createAccount, deleteAccount, getAccount, listAccounts, updateAccount } from '../../services/accounts';
import { makeConverter } from '../../services/rates';
import { categoryUsage, createCategory, deleteCategory, listCategories, updateCategory } from '../../services/categories';
import { mutate } from '../../state/actions';
import { useCtx, usePrefs } from '../../state/appStore';
import { useQuery } from '../../state/useQuery';
import { chooseDialog, confirmDialog } from '../../ui/components/feedback';
import { AmountField, OptionSheet, SelectField, Sheet, TextField } from '../../ui/components/forms';
import { Badge, Button, Card, Chip, EmptyState, Fab, Icon, IconButton, ListRow, LoadingBlock, Row, Screen, Segmented, Spacer, Txt } from '../../ui/components/primitives';
import { ACCOUNT_TYPE_ICON, ACCOUNT_TYPE_LABEL, CATEGORY_ICONS, COLOR_SWATCHES } from '../../ui/labels';
import { useTheme } from '../../ui/theme';

export function AccountsScreen({ navigation }: RootScreenProps<'Accounts'>) {
  const { c } = useTheme();
  const prefs = usePrefs();
  const [showArchived, setShowArchived] = useState(false);
  const q = useQuery(async (ctx) => {
    const accounts = await listAccounts(ctx.db, { includeArchived: true });
    const conv = await makeConverter(ctx.db);
    return { accounts, total: accounts.filter((a) => !a.archived).reduce((s, a) => s + conv.toBase(a.balanceMinor, a.currency), 0) };
  });
  const list = (q.data?.accounts ?? []).filter((a) => showArchived || !a.archived);
  return (
    <View style={{ flex: 1 }}>
      <Screen title="Accounts" subtitle={q.data ? `Total ${formatMoney(q.data.total, prefs.baseCurrency)}` : undefined} onBack={() => navigation.goBack()} right={<IconButton icon="swap-horizontal" label="Transfer between accounts" onPress={() => navigation.navigate('TransactionForm', { type: 'transfer' })} />}>
        {!q.data ? (
          <LoadingBlock />
        ) : q.data.accounts.length === 0 ? (
          <EmptyState icon="wallet" title="No accounts yet" message="Add Cash, a bank account, a mobile wallet or a savings account." action="Add account" onAction={() => navigation.navigate('AccountForm')} />
        ) : (
          <>
            {list.map((a) => (
              <Card key={a.id} style={{ marginBottom: 10 }} padded={false}>
                <View style={{ paddingHorizontal: 14 }}>
                  <ListRow
                    icon={ACCOUNT_TYPE_ICON[a.type]}
                    iconColor={a.color ?? c.primary}
                    title={a.name}
                    subtitle={`${ACCOUNT_TYPE_LABEL[a.type]} · ${a.currency}${a.archived ? ' · archived' : ''}`}
                    right={formatMoney(a.balanceMinor, a.currency)}
                    rightColor={a.balanceMinor < 0 ? c.danger : undefined}
                    badge={a.isDemo ? 'Sample' : undefined}
                    onPress={() => navigation.navigate('AccountForm', { id: a.id })}
                  />
                </View>
                <Row style={{ borderTopWidth: 1, borderTopColor: c.border, paddingHorizontal: 14, paddingVertical: 8 }} gap={16}>
                  <Pressable onPress={() => navigation.navigate('Tabs', { screen: 'Activity', params: { accountId: a.id } })} accessibilityRole="button" hitSlop={6}>
                    <Txt v="caption" color={c.primary} style={{ fontWeight: '700' }}>
                      Transactions
                    </Txt>
                  </Pressable>
                  <Pressable onPress={() => navigation.navigate('TransactionForm', { accountId: a.id })} accessibilityRole="button" hitSlop={6}>
                    <Txt v="caption" color={c.primary} style={{ fontWeight: '700' }}>
                      Add transaction
                    </Txt>
                  </Pressable>
                </Row>
              </Card>
            ))}
            {q.data.accounts.some((a) => a.archived) ? (
              <Button title={showArchived ? 'Hide archived' : 'Show archived'} variant="ghost" small onPress={() => setShowArchived(!showArchived)} />
            ) : null}
          </>
        )}
      </Screen>
      <Fab label="Add account" onPress={() => navigation.navigate('AccountForm')} />
    </View>
  );
}

export function AccountFormScreen({ navigation, route }: RootScreenProps<'AccountForm'>) {
  const prefs = usePrefs();
  const editId = route.params?.id;
  const q = useQuery(async (ctx) => (editId ? getAccount(ctx.db, editId) : null));
  const [name, setName] = useState('');
  const [type, setType] = useState<AccountType>('bank');
  const [currency, setCurrency] = useState(prefs.baseCurrency);
  const [opening, setOpening] = useState<number | null>(0);
  const [color, setColor] = useState<string>(COLOR_SWATCHES[0]);
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (loaded || (editId && !q.data)) return;
    if (q.data) {
      setName(q.data.name);
      setType(q.data.type);
      setCurrency(q.data.currency);
      setOpening(q.data.openingBalanceMinor);
      setColor(q.data.color ?? COLOR_SWATCHES[0]);
    }
    setLoaded(true);
  }, [q.data, loaded, editId]);

  const save = async () => {
    const input = { name, type, currency, openingBalanceMinor: opening ?? 0, color, icon: ACCOUNT_TYPE_ICON[type] };
    const errs = validateAccount(input);
    setErrors(errs);
    if (errs.length) return;
    const res = await mutate<unknown>((ctx) => (editId ? updateAccount(ctx, editId, input) : createAccount(ctx, input)), { success: editId ? 'Account updated' : 'Account created', silent: true });
    if (res.ok) navigation.goBack();
    else setErrors([{ field: res.field ?? 'form', message: res.error }]);
  };
  const more = async () => {
    if (!editId || !q.data) return;
    const choice = await chooseDialog(q.data.name, undefined, [
      { text: q.data.archived ? 'Unarchive' : 'Archive (hide, keep history)', value: 'archive', variant: 'secondary' },
      { text: 'Delete', value: 'delete', variant: 'danger' },
      { text: 'Cancel', value: 'cancel', variant: 'ghost' },
    ]);
    if (choice === 'archive') {
      const res = await mutate((ctx) => updateAccount(ctx, editId, { archived: !q.data!.archived }), { success: 'Account updated' });
      if (res.ok) navigation.goBack();
    }
    if (choice === 'delete' && (await confirmDialog({ title: 'Delete account?', message: 'Only accounts without transactions can be deleted.', destructive: true, confirmText: 'Delete' }))) {
      const res = await mutate((ctx) => deleteAccount(ctx, editId), { success: 'Account deleted' });
      if (res.ok) navigation.goBack();
    }
  };
  const err = (f: string) => firstError(errors, f);
  const { c } = useTheme();
  return (
    <Screen title={editId ? 'Edit account' : 'New account'} onBack={() => navigation.goBack()} right={editId ? <IconButton icon="ellipsis-horizontal" label="More" onPress={more} /> : undefined} footer={<Button title="Save" icon="checkmark" onPress={save} />}>
      <TextField label="Account name" value={name} onChangeText={setName} placeholder="e.g. GTBank Salary, OPay, Cash" error={err('name')} maxLength={80} autoFocus={!editId} />
      <Txt v="caption" dim style={{ fontWeight: '700', marginBottom: 6 }}>
        Type
      </Txt>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
        {ACCOUNT_TYPES.map((t) => (
          <Chip key={t} label={ACCOUNT_TYPE_LABEL[t]} icon={ACCOUNT_TYPE_ICON[t]} active={type === t} onPress={() => setType(t)} />
        ))}
      </View>
      <SelectField label="Currency" value={currency} onChange={(v) => v && setCurrency(v)} options={CURRENCIES.map((x) => ({ value: x.code, label: `${x.code} — ${x.name}`, subtitle: x.symbol }))} error={err('currency')} hint={editId ? 'Currency cannot be changed once transactions exist.' : undefined} />
      <AmountField label="Opening balance" currency={currency} valueMinor={opening} onChangeMinor={setOpening} allowZero error={err('openingBalanceMinor')} hint="How much is in this account right now (before any transactions you record)." />
      <Txt v="caption" dim style={{ fontWeight: '700', marginBottom: 6 }}>
        Colour
      </Txt>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        {COLOR_SWATCHES.map((col) => (
          <Pressable key={col} onPress={() => setColor(col)} accessibilityRole="button" accessibilityLabel={`Colour ${col}`} style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: col, borderWidth: color === col ? 3 : 0, borderColor: c.text }} />
        ))}
      </View>
      {err('form') ? (
        <Txt v="small" color={c.danger} style={{ marginTop: 12 }}>
          {err('form')}
        </Txt>
      ) : null}
    </Screen>
  );
}

export function CategoriesScreen({ navigation }: RootScreenProps<'Categories'>) {
  const { c } = useTheme();
  const ctx = useCtx();
  const [kind, setKind] = useState<CategoryKind>('expense');
  const q = useQuery((ctx) => listCategories(ctx.db, { includeArchived: true }));
  const [editing, setEditing] = useState<{ id?: string; name: string; icon: string; color: string } | null>(null);
  const [iconSheet, setIconSheet] = useState(false);
  const [error, setError] = useState<string>();
  const list = (q.data ?? []).filter((x) => x.kind === kind);

  const save = async () => {
    if (!editing) return;
    const res = await mutate<unknown>((ctx) => (editing.id ? updateCategory(ctx, editing.id, editing) : createCategory(ctx, { ...editing, kind })), { success: 'Category saved', silent: true });
    if (res.ok) setEditing(null);
    else setError(res.error);
  };
  const remove = async (id: string, name: string) => {
    const used = await categoryUsage(ctx.db, id);
    if (used > 0) {
      const others = list.filter((x) => x.id !== id && !x.archived);
      const choice = await chooseDialog(`Delete “${name}”?`, `${used} transaction(s) use this category. Move them to another category, or leave them uncategorised.`, [
        ...others.slice(0, 4).map((o) => ({ text: `Move to ${o.name}`, value: o.id, variant: 'secondary' as const })),
        { text: 'Leave uncategorised', value: '__none', variant: 'danger' },
        { text: 'Cancel', value: 'cancel', variant: 'ghost' },
      ]);
      if (!choice || choice === 'cancel') return;
      await mutate((ctx) => deleteCategory(ctx, id, choice === '__none' ? null : choice), { success: 'Category deleted' });
    } else if (await confirmDialog({ title: `Delete “${name}”?`, destructive: true, confirmText: 'Delete' })) {
      await mutate((ctx) => deleteCategory(ctx, id), { success: 'Category deleted' });
    }
    setEditing(null);
  };

  return (
    <View style={{ flex: 1 }}>
      <Screen title="Categories" onBack={() => navigation.goBack()}>
        <Segmented value={kind} onChange={setKind} options={[{ value: 'expense', label: 'Expenses' }, { value: 'income', label: 'Income' }]} />
        <Spacer h={10} />
        {!q.data ? (
          <LoadingBlock />
        ) : (
          <Card padded={false} style={{ paddingHorizontal: 14 }}>
            {list.map((x) => (
              <ListRow
                key={x.id}
                icon={x.icon}
                iconColor={x.color}
                title={x.name}
                subtitle={x.archived ? 'Hidden' : x.isSystem ? 'Default' : 'Custom'}
                chevron
                onPress={() => {
                  setError(undefined);
                  setEditing({ id: x.id, name: x.name, icon: x.icon, color: x.color });
                }}
              />
            ))}
          </Card>
        )}
      </Screen>
      <Fab
        label="Add category"
        onPress={() => {
          setError(undefined);
          setEditing({ name: '', icon: 'pricetag', color: COLOR_SWATCHES[0] });
        }}
      />
      <Sheet visible={!!editing} onClose={() => setEditing(null)} title={editing?.id ? 'Edit category' : `New ${kind} category`}>
        {editing ? (
          <>
            <Row gap={10} align="flex-start">
              <Pressable onPress={() => setIconSheet(true)} accessibilityRole="button" accessibilityLabel="Choose icon" style={{ width: 52, height: 52, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: editing.color + '22', marginTop: 20 }}>
                <Icon name={editing.icon} size={24} color={editing.color} />
              </Pressable>
              <View style={{ flex: 1 }}>
                <TextField label="Name" value={editing.name} onChangeText={(v) => setEditing({ ...editing, name: v })} maxLength={40} error={error} />
              </View>
            </Row>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 16 }}>
              {COLOR_SWATCHES.map((col) => (
                <Pressable key={col} onPress={() => setEditing({ ...editing, color: col })} accessibilityRole="button" accessibilityLabel={`Colour ${col}`} style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: col, borderWidth: editing.color === col ? 3 : 0, borderColor: c.text }} />
              ))}
            </View>
            <Row gap={10}>
              {editing.id ? (
                <>
                  <Button title="Delete" variant="ghost" icon="trash" onPress={() => remove(editing.id!, editing.name)} style={{ flex: 1 }} />
                  <Button
                    title={(q.data ?? []).find((x) => x.id === editing.id)?.archived ? 'Show' : 'Hide'}
                    variant="ghost"
                    onPress={async () => {
                      const cur = (q.data ?? []).find((x) => x.id === editing.id);
                      await mutate((ctx) => updateCategory(ctx, editing.id!, { archived: !cur?.archived }), { success: 'Category updated' });
                      setEditing(null);
                    }}
                    style={{ flex: 1 }}
                  />
                </>
              ) : null}
              <Button title="Save" onPress={save} style={{ flex: 1.2 }} />
            </Row>
            {editing.id && (q.data ?? []).find((x) => x.id === editing.id)?.isSystem ? (
              <Row gap={6} style={{ marginTop: 10 }}>
                <Badge label="Default" color={c.info} />
                <Txt v="caption" dim style={{ flex: 1 }}>
                  Default categories can be renamed, hidden or deleted.
                </Txt>
              </Row>
            ) : null}
          </>
        ) : null}
      </Sheet>
      <OptionSheet
        visible={iconSheet}
        title="Icon"
        value={editing?.icon ?? null}
        options={CATEGORY_ICONS.map((i) => ({ value: i, label: i.replace(/-/g, ' '), icon: i, color: editing?.color }))}
        onPick={(v) => {
          if (editing) setEditing({ ...editing, icon: v });
          setIconSheet(false);
        }}
        onClose={() => setIconSheet(false)}
        searchable
      />
    </View>
  );
}

