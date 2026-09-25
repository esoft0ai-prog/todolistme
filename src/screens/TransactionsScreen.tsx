import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import React, { useEffect, useMemo, useState } from 'react';
import { SectionList, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { formatDate, periodRange, relativeDays, type PeriodPreset } from '../domain/dates';
import { formatMoney } from '../domain/money';
import { TRANSACTION_TYPES, type Transaction, type TransactionType } from '../domain/types';
import type { RootStackParamList, TabParamList } from '../navigation/types';
import { listAccounts } from '../services/accounts';
import { totals } from '../services/analytics';
import { listCategories } from '../services/categories';
import { countTransactions, listTransactions, type TransactionFilter } from '../services/transactions';
import { usePrefs } from '../state/appStore';
import { useQuery } from '../state/useQuery';
import { OptionSheet, TextField } from '../ui/components/forms';
import { Chip, ChipScroller, EmptyState, Fab, IconButton, ListRow, LoadingBlock, Row, Screen, Spacer, Txt } from '../ui/components/primitives';
import { TX_TYPE_ICON, TX_TYPE_LABEL, txColor, txSign } from '../ui/labels';
import { useTheme } from '../ui/theme';

type Nav = NativeStackNavigationProp<RootStackParamList>;
const PAGE = 60;

const PERIODS: { key: PeriodPreset | 'all'; label: string }[] = [
  { key: 'all', label: 'All time' },
  { key: 'this_month', label: 'This month' },
  { key: 'last_month', label: 'Last month' },
  { key: 'last_3_months', label: '3 months' },
  { key: 'this_year', label: 'This year' },
];

export function TransactionsScreen() {
  const nav = useNavigation<Nav>();
  const route = useRoute<RouteProp<TabParamList, 'Activity'>>();
  const insets = useSafeAreaInsets();
  const { c } = useTheme();
  const prefs = usePrefs();
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [type, setType] = useState<TransactionType | null>(route.params?.type ?? null);
  const [accountId, setAccountId] = useState<string | null>(route.params?.accountId ?? null);
  const [categoryId, setCategoryId] = useState<string | null>(route.params?.categoryId ?? null);
  const [period, setPeriod] = useState<PeriodPreset | 'all'>('all');
  const [limit, setLimit] = useState(PAGE);
  const [sheet, setSheet] = useState<'account' | 'category' | null>(null);

  useEffect(() => {
    if (route.params?.type !== undefined) setType(route.params.type ?? null);
    if (route.params?.accountId !== undefined) setAccountId(route.params.accountId ?? null);
    if (route.params?.categoryId !== undefined) setCategoryId(route.params.categoryId ?? null);
  }, [route.params]);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 250);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => setLimit(PAGE), [debounced, type, accountId, categoryId, period]);

  const filter: TransactionFilter = {
    search: debounced || undefined,
    types: type ? [type] : undefined,
    accountId: accountId ?? undefined,
    categoryIds: categoryId ? [categoryId] : undefined,
    range: period === 'all' ? undefined : periodRange(period, undefined, prefs.weekStartsOn),
  };
  const key = JSON.stringify(filter);
  const lookups = useQuery(async (ctx) => ({ accounts: await listAccounts(ctx.db, { includeArchived: true }), categories: await listCategories(ctx.db, { includeArchived: true }) }));
  const q = useQuery(
    async (ctx) => ({
      items: await listTransactions(ctx.db, { ...filter, limit }),
      count: await countTransactions(ctx.db, filter),
      totals: await totals(ctx.db, filter),
    }),
    [key, limit],
  );

  const accountName = (id: string | null) => lookups.data?.accounts.find((a) => a.id === id)?.name ?? '';
  const category = (id: string | null) => lookups.data?.categories.find((x) => x.id === id);

  const sections = useMemo(() => {
    const groups = new Map<string, Transaction[]>();
    for (const t of q.data?.items ?? []) {
      const g = groups.get(t.date) ?? [];
      g.push(t);
      groups.set(t.date, g);
    }
    return [...groups.entries()].map(([date, data]) => ({ title: date, data }));
  }, [q.data]);

  const filtersActive = !!(type || accountId || categoryId || period !== 'all' || debounced);

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <Screen
        title="Activity"
        subtitle={q.data ? `${q.data.count} transaction${q.data.count === 1 ? '' : 's'}` : undefined}
        right={<IconButton icon="repeat" label="Recurring transactions" onPress={() => nav.navigate('Recurring')} />}
        scroll={false}
        padded={false}
      >
        <View style={{ paddingHorizontal: 16 }}>
          <TextField value={search} onChangeText={setSearch} placeholder="Search description, notes, tags, amount…" icon="search" style={{ marginBottom: 8 }} />
          <ChipScroller>
            <Chip label="All types" active={!type} onPress={() => setType(null)} />
            {TRANSACTION_TYPES.map((t) => (
              <Chip key={t} label={TX_TYPE_LABEL[t]} icon={TX_TYPE_ICON[t]} active={type === t} color={txColor(c, t)} onPress={() => setType(type === t ? null : t)} />
            ))}
          </ChipScroller>
          <Spacer h={8} />
          <ChipScroller>
            {PERIODS.map((p) => (
              <Chip key={p.key} label={p.label} active={period === p.key} onPress={() => setPeriod(p.key)} />
            ))}
            <Chip label={accountId ? accountName(accountId) : 'Any account'} icon="wallet" active={!!accountId} onPress={() => setSheet('account')} />
            <Chip label={categoryId ? (category(categoryId)?.name ?? 'Category') : 'Any category'} icon="pricetag" active={!!categoryId} onPress={() => setSheet('category')} />
            {filtersActive ? (
              <Chip
                label="Clear"
                icon="close"
                onPress={() => {
                  setType(null);
                  setAccountId(null);
                  setCategoryId(null);
                  setPeriod('all');
                  setSearch('');
                }}
              />
            ) : null}
          </ChipScroller>
          {q.data && filtersActive ? (
            <Row gap={14} style={{ marginTop: 10 }}>
              <Txt v="caption" color={c.success}>
                In {formatMoney(q.data.totals.incomeMinor + q.data.totals.loanReceivedMinor, prefs.baseCurrency, { compact: true })}
              </Txt>
              <Txt v="caption" color={c.danger}>
                Out {formatMoney(q.data.totals.expenseMinor + q.data.totals.debtRepaymentMinor, prefs.baseCurrency, { compact: true })}
              </Txt>
            </Row>
          ) : null}
        </View>
        {!q.data && q.loading ? (
          <View style={{ padding: 16 }}>
            <LoadingBlock />
          </View>
        ) : (
          <SectionList
            sections={sections}
            keyExtractor={(t) => t.id}
            stickySectionHeadersEnabled={false}
            contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: insets.bottom + 120 }}
            initialNumToRender={20}
            windowSize={9}
            removeClippedSubviews
            renderSectionHeader={({ section }) => (
              <Txt v="label" dim style={{ marginTop: 16, marginBottom: 4 }}>
                {formatDate(section.title, 'long')} · {relativeDays(section.title)}
              </Txt>
            )}
            renderItem={({ item: t }) => {
              const cat = category(t.categoryId);
              const sign = txSign(t.type);
              const sub =
                t.type === 'transfer'
                  ? `${accountName(t.accountId)} → ${accountName(t.toAccountId)}`
                  : [cat?.name ?? TX_TYPE_LABEL[t.type], accountName(t.accountId), t.tags.length ? `#${t.tags.join(' #')}` : ''].filter(Boolean).join(' · ');
              return (
                <ListRow
                  icon={cat?.icon ?? TX_TYPE_ICON[t.type]}
                  iconColor={cat?.color ?? txColor(c, t.type)}
                  title={t.description || cat?.name || TX_TYPE_LABEL[t.type]}
                  subtitle={sub}
                  right={`${sign > 0 ? '+' : sign < 0 ? '−' : ''}${formatMoney(t.amountMinor, t.currency)}`}
                  rightColor={sign > 0 ? c.success : sign < 0 ? c.text : c.info}
                  rightSub={t.time ?? (t.recurringId ? 'recurring' : t.isDemo ? 'sample' : undefined)}
                  onPress={() => nav.navigate('TransactionForm', { id: t.id })}
                />
              );
            }}
            ListEmptyComponent={
              <EmptyState
                icon={filtersActive ? 'search' : 'receipt'}
                title={filtersActive ? 'No matching transactions' : 'No transactions yet'}
                message={filtersActive ? 'Try different filters or search words.' : 'Record income, expenses and transfers — everything stays on your phone.'}
                action={filtersActive ? undefined : 'Add transaction'}
                onAction={() => nav.navigate('TransactionForm')}
              />
            }
            onEndReachedThreshold={0.4}
            onEndReached={() => {
              if (q.data && q.data.items.length < q.data.count) setLimit((l) => l + PAGE);
            }}
            ListFooterComponent={
              q.data && q.data.items.length < q.data.count ? (
                <Txt v="caption" faint center style={{ padding: 16 }}>
                  Loading more…
                </Txt>
              ) : null
            }
          />
        )}
      </Screen>
      <Fab label="Add transaction" onPress={() => nav.navigate('TransactionForm', type ? { type } : undefined)} />
      <OptionSheet
        visible={sheet === 'account'}
        title="Filter by account"
        value={accountId}
        options={(lookups.data?.accounts ?? []).map((a) => ({ value: a.id, label: a.name, subtitle: a.archived ? 'Archived' : a.currency }))}
        onPick={(v) => {
          setAccountId(v);
          setSheet(null);
        }}
        onClear={() => {
          setAccountId(null);
          setSheet(null);
        }}
        onClose={() => setSheet(null)}
      />
      <OptionSheet
        visible={sheet === 'category'}
        title="Filter by category"
        value={categoryId}
        searchable
        options={(lookups.data?.categories ?? []).map((x) => ({ value: x.id, label: x.name, subtitle: x.kind === 'income' ? 'Income' : 'Expense', icon: x.icon, color: x.color }))}
        onPick={(v) => {
          setCategoryId(v);
          setSheet(null);
        }}
        onClear={() => {
          setCategoryId(null);
          setSheet(null);
        }}
        onClose={() => setSheet(null)}
      />
    </View>
  );
}
