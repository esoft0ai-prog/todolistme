import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { formatDate, periodRange, type PeriodPreset } from '../../domain/dates';
import { formatMoney } from '../../domain/money';
import { TRANSACTION_TYPES, type TransactionType } from '../../domain/types';
import type { RootScreenProps } from '../../navigation/types';
import { searchAll } from '../../services/search';
import { usePrefs } from '../../state/appStore';
import { useQuery } from '../../state/useQuery';
import { TextField } from '../../ui/components/forms';
import { Card, Chip, ChipScroller, EmptyState, ListRow, LoadingBlock, Screen, SectionHeader, Spacer } from '../../ui/components/primitives';
import { TX_TYPE_ICON, TX_TYPE_LABEL, txColor } from '../../ui/labels';
import { useTheme } from '../../ui/theme';

export function SearchScreen({ navigation }: RootScreenProps<'Search'>) {
  const { c } = useTheme();
  const prefs = usePrefs();
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [type, setType] = useState<TransactionType | null>(null);
  const [period, setPeriod] = useState<PeriodPreset | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setQuery(text), 250);
    return () => clearTimeout(t);
  }, [text]);
  const q = useQuery(
    (ctx) => searchAll(ctx.db, query, { types: type ? [type] : undefined, range: period ? periodRange(period, undefined, prefs.weekStartsOn) : undefined }),
    [query, type, period],
  );
  const r = q.data;
  const empty = !query && !type && !period;
  return (
    <Screen title="Search" onBack={() => navigation.goBack()}>
      <TextField value={text} onChangeText={setText} placeholder="Transactions, debts, goals, accounts, notes, amounts…" icon="search" autoFocus />
      <ChipScroller>
        {TRANSACTION_TYPES.map((t) => (
          <Chip key={t} label={TX_TYPE_LABEL[t]} icon={TX_TYPE_ICON[t]} color={txColor(c, t)} active={type === t} onPress={() => setType(type === t ? null : t)} />
        ))}
      </ChipScroller>
      <Spacer h={8} />
      <ChipScroller>
        {(['this_month', 'last_month', 'last_3_months', 'this_year'] as PeriodPreset[]).map((p) => (
          <Chip key={p} label={p.replace(/_/g, ' ').replace(/^\w/, (s) => s.toUpperCase())} active={period === p} onPress={() => setPeriod(period === p ? null : p)} />
        ))}
      </ChipScroller>
      <Spacer h={10} />
      {empty ? (
        <EmptyState icon="search" title="Search everything" message="Search works entirely offline across transactions, notes, tags, debts, goals, accounts, categories, reminders and calendar events." />
      ) : !r ? (
        <LoadingBlock />
      ) : r.total === 0 ? (
        <EmptyState icon="search" title="No results" message="Try a different word, an amount (e.g. 25000) or remove filters." />
      ) : (
        <View>
          {r.transactions.length ? (
            <>
              <SectionHeader title={`Transactions (${r.transactions.length})`} />
              <Card padded={false} style={{ paddingHorizontal: 14 }}>
                {r.transactions.map((t) => (
                  <ListRow key={t.id} icon={TX_TYPE_ICON[t.type]} iconColor={txColor(c, t.type)} title={t.description || TX_TYPE_LABEL[t.type]} subtitle={`${formatDate(t.date)}${t.notes ? ` · ${t.notes}` : ''}`} right={formatMoney(t.amountMinor, t.currency)} onPress={() => navigation.navigate('TransactionForm', { id: t.id })} />
                ))}
              </Card>
            </>
          ) : null}
          {r.debts.length ? (
            <>
              <SectionHeader title="Debts" />
              <Card padded={false} style={{ paddingHorizontal: 14 }}>
                {r.debts.map((d) => (
                  <ListRow key={d.id} icon="card" iconColor={c.danger} title={d.lenderName} subtitle={d.notes ?? d.debtType} right={formatMoney(d.principalMinor, d.currency)} onPress={() => navigation.navigate('DebtDetail', { id: d.id })} />
                ))}
              </Card>
            </>
          ) : null}
          {r.goals.length ? (
            <>
              <SectionHeader title="Goals" />
              <Card padded={false} style={{ paddingHorizontal: 14 }}>
                {r.goals.map((g) => (
                  <ListRow key={g.id} icon={g.icon} iconColor={g.color} title={g.name} right={formatMoney(g.targetMinor, g.currency)} onPress={() => navigation.navigate('GoalDetail', { id: g.id })} />
                ))}
              </Card>
            </>
          ) : null}
          {r.accounts.length ? (
            <>
              <SectionHeader title="Accounts" />
              <Card padded={false} style={{ paddingHorizontal: 14 }}>
                {r.accounts.map((a) => (
                  <ListRow key={a.id} icon="wallet" title={a.name} subtitle={a.currency} onPress={() => navigation.navigate('AccountForm', { id: a.id })} />
                ))}
              </Card>
            </>
          ) : null}
          {r.categories.length ? (
            <>
              <SectionHeader title="Categories" />
              <Card padded={false} style={{ paddingHorizontal: 14 }}>
                {r.categories.map((x) => (
                  <ListRow key={x.id} icon={x.icon} iconColor={x.color} title={x.name} subtitle={x.kind} onPress={() => navigation.navigate('Tabs', { screen: 'Activity', params: { categoryId: x.id } })} />
                ))}
              </Card>
            </>
          ) : null}
          {r.reminders.length || r.events.length ? (
            <>
              <SectionHeader title="Reminders & events" />
              <Card padded={false} style={{ paddingHorizontal: 14 }}>
                {r.reminders.map((x) => (
                  <ListRow key={x.id} icon="alarm" title={x.title} subtitle={x.message} onPress={() => navigation.navigate('ReminderForm', { id: x.id })} />
                ))}
                {r.events.map((x) => (
                  <ListRow key={x.id} icon="calendar" title={x.title} subtitle={formatDate(x.date)} onPress={() => navigation.navigate('EventForm', { id: x.id })} />
                ))}
              </Card>
            </>
          ) : null}
        </View>
      )}
    </Screen>
  );
}
