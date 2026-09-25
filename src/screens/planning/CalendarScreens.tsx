import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { addDays, addMonths, daysInMonth, formatDate, formatMonthKey, isValidTime, MONTH_NAMES, parts, relativeDays, startOfMonth, today, WEEKDAY_SHORT, weekday } from '../../domain/dates';
import { formatMoney } from '../../domain/money';
import type { FinancialEvent, RecurrenceFrequency } from '../../domain/types';
import type { RootScreenProps } from '../../navigation/types';
import { upcomingItems, type UpcomingItem } from '../../services/analytics';
import { deleteEvent, deleteReminder, listCustomReminders, listEvents, saveCustomReminder, saveEvent } from '../../services/reminders';
import { mutate } from '../../state/actions';
import { usePrefs } from '../../state/appStore';
import { useQuery } from '../../state/useQuery';
import { confirmDialog } from '../../ui/components/feedback';
import { AmountField, DateField, SwitchRow, TextField, TimeField } from '../../ui/components/forms';
import { Button, Card, Chip, ChipScroller, EmptyState, Fab, IconButton, ListRow, LoadingBlock, Row, Screen, SectionHeader, Segmented, Spacer, Txt } from '../../ui/components/primitives';
import { RECURRENCE_LABEL } from '../../ui/labels';
import { useTheme, type Palette } from '../../ui/theme';

function kindColor(c: Palette, u: UpcomingItem): string {
  if (u.overdue) return c.danger;
  switch (u.kind) {
    case 'debt':
      return c.warning;
    case 'bill':
      return c.info;
    case 'income':
      return c.success;
    case 'goal':
      return c.accent;
    case 'budget':
      return c.primary;
    default:
      return c.textDim;
  }
}

const KIND_ICON: Record<UpcomingItem['kind'], string> = {
  debt: 'card',
  bill: 'receipt',
  income: 'arrow-down-circle',
  event: 'bookmark',
  goal: 'flag',
  reminder: 'alarm',
  budget: 'pie-chart',
};

export function CalendarScreen({ navigation }: RootScreenProps<'Calendar'>) {
  const { c } = useTheme();
  const prefs = usePrefs();
  const [month, setMonth] = useState(startOfMonth(today()));
  const [selected, setSelected] = useState(today());
  const [view, setView] = useState<'month' | 'upcoming' | 'overdue'>('month');
  const monthEnd = addDays(addMonths(month, 1), -1);
  const q = useQuery(async (ctx) => {
    const t = ctx.today();
    const all = await upcomingItems(ctx, month, monthEnd, { includeOverdue: false });
    const upcoming = await upcomingItems(ctx, t, addDays(t, 60), { includeOverdue: false });
    const overdue = (await upcomingItems(ctx, t, t, { includeOverdue: true })).filter((i) => i.overdue);
    return { all, upcoming, overdue };
  }, [month]);

  const byDay = useMemo(() => {
    const m = new Map<string, UpcomingItem[]>();
    for (const i of q.data?.all ?? []) m.set(i.date, [...(m.get(i.date) ?? []), i]);
    return m;
  }, [q.data]);

  const { y, m } = parts(month);
  const first = weekday(month);
  const offset = (first - prefs.weekStartsOn + 7) % 7;
  const cells: (string | null)[] = [...Array(offset).fill(null), ...Array.from({ length: daysInMonth(y, m) }, (_, i) => `${month.slice(0, 8)}${String(i + 1).padStart(2, '0')}`)];
  while (cells.length % 7) cells.push(null);
  const weekdays = Array.from({ length: 7 }, (_, i) => WEEKDAY_SHORT[(i + prefs.weekStartsOn) % 7]);
  const dayItems = byDay.get(selected) ?? [];
  const t = today();

  const renderItem = (u: UpcomingItem) => (
    <ListRow
      key={u.id}
      icon={KIND_ICON[u.kind]}
      iconColor={kindColor(c, u)}
      title={u.title}
      subtitle={`${u.subtitle} · ${formatDate(u.date)}${u.overdue ? ` · ${relativeDays(u.date)}` : ''}`}
      right={u.amountMinor ? formatMoney(u.amountMinor, u.currency) : undefined}
      rightColor={u.overdue ? c.danger : u.kind === 'income' ? c.success : undefined}
      onPress={() => {
        if (u.kind === 'debt' && u.entityId) navigation.navigate('DebtDetail', { id: u.entityId });
        else if ((u.kind === 'bill' || u.kind === 'income') && u.id.startsWith('rec-') && u.entityId) navigation.navigate('RecurringForm', { id: u.entityId });
        else if (u.id.startsWith('event-') && u.entityId) navigation.navigate('EventForm', { id: u.entityId });
        else if (u.kind === 'goal' && u.entityId) navigation.navigate('GoalDetail', { id: u.entityId });
        else if (u.kind === 'reminder' && u.entityId) navigation.navigate('ReminderForm', { id: u.entityId });
        else if (u.kind === 'budget' && u.entityId) navigation.navigate('BudgetDetail', { id: u.entityId });
      }}
    />
  );

  return (
    <View style={{ flex: 1 }}>
      <Screen title="Financial calendar" onBack={() => navigation.goBack()}>
        <Segmented value={view} onChange={setView} options={[{ value: 'month', label: 'Month' }, { value: 'upcoming', label: 'Upcoming' }, { value: 'overdue', label: `Overdue${q.data?.overdue.length ? ` (${q.data.overdue.length})` : ''}` }]} />
        <Spacer h={12} />
        {!q.data ? (
          <LoadingBlock />
        ) : view === 'month' ? (
          <>
            <Card>
              <Row justify="space-between" style={{ marginBottom: 10 }}>
                <IconButton icon="chevron-back" label="Previous month" onPress={() => setMonth(addMonths(month, -1))} />
                <Txt v="h3" accessibilityRole="header">
                  {MONTH_NAMES[m - 1]} {y}
                </Txt>
                <IconButton icon="chevron-forward" label="Next month" onPress={() => setMonth(addMonths(month, 1))} />
              </Row>
              <Row gap={0}>
                {weekdays.map((w) => (
                  <Txt key={w} v="caption" faint center style={{ flex: 1 }}>
                    {w}
                  </Txt>
                ))}
              </Row>
              {Array.from({ length: cells.length / 7 }).map((_, row) => (
                <Row key={row} gap={0} style={{ marginTop: 4 }}>
                  {cells.slice(row * 7, row * 7 + 7).map((d, i) => {
                    if (!d) return <View key={i} style={{ flex: 1, height: 46 }} />;
                    const items = byDay.get(d) ?? [];
                    const isSel = d === selected;
                    const isToday = d === t;
                    const hasOverdue = items.some((x) => x.overdue);
                    return (
                      <Pressable
                        key={d}
                        onPress={() => setSelected(d)}
                        accessibilityRole="button"
                        accessibilityLabel={`${formatDate(d, 'long')}, ${items.length} event${items.length === 1 ? '' : 's'}`}
                        accessibilityState={{ selected: isSel }}
                        style={{ flex: 1, height: 46, alignItems: 'center', justifyContent: 'center', borderRadius: 12, backgroundColor: isSel ? c.primary : isToday ? c.primarySoft : 'transparent' }}
                      >
                        <Txt v="small" color={isSel ? c.onPrimary : undefined} style={{ fontWeight: isToday || isSel ? '800' : '500' }}>
                          {Number(d.slice(8))}
                        </Txt>
                        <Row gap={2} style={{ height: 6, marginTop: 2 }}>
                          {items.slice(0, 3).map((x) => (
                            <View key={x.id} style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: isSel ? c.onPrimary : hasOverdue ? c.danger : kindColor(c, x) }} />
                          ))}
                        </Row>
                      </Pressable>
                    );
                  })}
                </Row>
              ))}
            </Card>
            <SectionHeader title={formatDate(selected, 'long')} action="Add event" onAction={() => navigation.navigate('EventForm', { date: selected })} />
            <Card padded={false} style={{ paddingHorizontal: 14 }}>
              {dayItems.length ? dayItems.map(renderItem) : <Txt v="small" dim style={{ paddingVertical: 16 }}>No financial events on this day.</Txt>}
            </Card>
            <Txt v="caption" faint style={{ marginTop: 8 }}>
              {formatMonthKey(month.slice(0, 7))}: {q.data.all.length} events · Debt payments, bills, income, goal deadlines, budget resets and reminders.
            </Txt>
          </>
        ) : view === 'upcoming' ? (
          q.data.upcoming.length ? (
            <Card padded={false} style={{ paddingHorizontal: 14 }}>
              {q.data.upcoming.map(renderItem)}
            </Card>
          ) : (
            <EmptyState icon="calendar" title="Nothing coming up" message="Debt payments, bills and reminders for the next 60 days will appear here." />
          )
        ) : q.data.overdue.length ? (
          <Card padded={false} style={{ paddingHorizontal: 14 }} tone="danger">
            {q.data.overdue.map(renderItem)}
          </Card>
        ) : (
          <EmptyState icon="checkmark-done-circle" title="Nothing overdue" message="Great — you are up to date with all payments." />
        )}
      </Screen>
      <Fab label="Add calendar event" onPress={() => navigation.navigate('EventForm', { date: selected })} />
    </View>
  );
}

export function EventFormScreen({ navigation, route }: RootScreenProps<'EventForm'>) {
  const prefs = usePrefs();
  const editId = route.params?.id;
  const q = useQuery(async (ctx) => (editId ? (await listEvents(ctx.db)).find((e) => e.id === editId) ?? null : null));
  const [title, setTitle] = useState('');
  const [date, setDate] = useState(route.params?.date ?? today());
  const [kind, setKind] = useState<FinancialEvent['kind']>('bill');
  const [amount, setAmount] = useState<number | null>(null);
  const [notes, setNotes] = useState('');
  const [remind, setRemind] = useState(true);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (q.data) {
      setTitle(q.data.title);
      setDate(q.data.date);
      setKind(q.data.kind);
      setAmount(q.data.amountMinor);
      setNotes(q.data.notes ?? '');
      setRemind(q.data.remind);
    }
  }, [q.data]);
  const save = async () => {
    const res = await mutate(async (ctx) => saveEvent(ctx, { title, date, kind, amountMinor: amount, notes: notes || null, remind }, editId), { success: 'Event saved', silent: true });
    if (res.ok) navigation.goBack();
    else setError(res.error);
  };
  const remove = async () => {
    if (!editId || !(await confirmDialog({ title: 'Delete event?', destructive: true, confirmText: 'Delete' }))) return;
    await mutate((ctx) => deleteEvent(ctx, editId), { success: 'Event deleted' });
    navigation.goBack();
  };
  return (
    <Screen
      title={editId ? 'Edit event' : 'New calendar event'}
      onBack={() => navigation.goBack()}
      footer={
        <Row gap={10}>
          {editId ? <Button title="Delete" variant="ghost" icon="trash" onPress={remove} style={{ flex: 0.6 }} /> : null}
          <Button title="Save" icon="checkmark" onPress={save} style={{ flex: 1 }} />
        </Row>
      }
    >
      <Segmented value={kind} onChange={setKind} options={[{ value: 'bill', label: 'Bill' }, { value: 'income', label: 'Income' }, { value: 'savings', label: 'Savings' }, { value: 'note', label: 'Note' }]} />
      <Spacer h={12} />
      <TextField label="Title" value={title} onChangeText={setTitle} placeholder="e.g. School fees, NEPA bill, Ajo contribution" error={error} maxLength={80} />
      <DateField label="Date" value={date} onChange={(v) => v && setDate(v)} />
      <AmountField label="Amount (optional)" currency={prefs.baseCurrency} valueMinor={amount} onChangeMinor={setAmount} />
      <SwitchRow label="Remind me" description={kind === 'bill' ? 'The day before and on the day' : 'On the day'} value={remind} onChange={setRemind} icon="alarm" />
      <TextField label="Notes" value={notes} onChangeText={setNotes} multiline maxLength={500} />
    </Screen>
  );
}

export function RemindersScreen({ navigation }: RootScreenProps<'Reminders'>) {
  const { c } = useTheme();
  const q = useQuery((ctx) => listCustomReminders(ctx.db));
  return (
    <View style={{ flex: 1 }}>
      <Screen title="Reminders" subtitle="Custom reminders — delivered even offline" onBack={() => navigation.goBack()}>
        {!q.data ? (
          <LoadingBlock />
        ) : q.data.length === 0 ? (
          <EmptyState icon="alarm" title="No custom reminders" message="Create reminders for anything money-related: ajo/esusu contributions, estate dues, rent renewal…" action="Add reminder" onAction={() => navigation.navigate('ReminderForm')} />
        ) : (
          <Card padded={false} style={{ paddingHorizontal: 14 }}>
            {q.data.map((r) => (
              <ListRow
                key={r.id}
                icon="alarm"
                iconColor={r.enabled ? c.primary : c.textFaint}
                title={r.title}
                subtitle={`${r.date ? formatDate(r.date) : ''} at ${r.timeOfDay} · ${r.repeat === 'none' ? 'once' : RECURRENCE_LABEL[r.repeat as RecurrenceFrequency].toLowerCase()}${r.enabled ? '' : ' · off'}`}
                badge={r.isDemo ? 'Sample' : undefined}
                chevron
                onPress={() => navigation.navigate('ReminderForm', { id: r.id })}
              />
            ))}
          </Card>
        )}
        <Txt v="caption" faint style={{ marginTop: 12 }}>
          Debt reminders are configured on each debt. Bill reminders are configured on recurring transactions.
        </Txt>
      </Screen>
      <Fab label="Add reminder" onPress={() => navigation.navigate('ReminderForm')} />
    </View>
  );
}

export function ReminderFormScreen({ navigation, route }: RootScreenProps<'ReminderForm'>) {
  const prefs = usePrefs();
  const editId = route.params?.id;
  const q = useQuery(async (ctx) => (editId ? (await listCustomReminders(ctx.db)).find((r) => r.id === editId) ?? null : null));
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [date, setDate] = useState(addDays(today(), 1));
  const [time, setTime] = useState<string | null>(prefs.reminderTime);
  const [repeat, setRepeat] = useState<'none' | RecurrenceFrequency>('none');
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (q.data) {
      setTitle(q.data.title);
      setMessage(q.data.message);
      setDate(q.data.date ?? today());
      setTime(q.data.timeOfDay);
      setRepeat(q.data.repeat);
      setEnabled(q.data.enabled);
    }
  }, [q.data]);
  const save = async () => {
    const res = await mutate(
      (ctx) => saveCustomReminder(ctx, { title, message, date, timeOfDay: time && isValidTime(time) ? time : prefs.reminderTime, repeat, enabled }, editId),
      { success: 'Reminder saved', silent: true },
    );
    if (res.ok) navigation.goBack();
    else setError(res.error);
  };
  const remove = async () => {
    if (!editId || !(await confirmDialog({ title: 'Delete reminder?', destructive: true, confirmText: 'Delete' }))) return;
    await mutate((ctx) => deleteReminder(ctx, editId), { success: 'Reminder deleted' });
    navigation.goBack();
  };
  return (
    <Screen
      title={editId ? 'Edit reminder' : 'New reminder'}
      onBack={() => navigation.goBack()}
      footer={
        <Row gap={10}>
          {editId ? <Button title="Delete" variant="ghost" icon="trash" onPress={remove} style={{ flex: 0.6 }} /> : null}
          <Button title="Save" icon="checkmark" onPress={save} style={{ flex: 1 }} />
        </Row>
      }
    >
      <TextField label="Title" value={title} onChangeText={setTitle} placeholder="e.g. Ajo contribution" error={error} maxLength={80} autoFocus={!editId} />
      <TextField label="Message" value={message} onChangeText={setMessage} placeholder="Optional details" maxLength={300} />
      <Row gap={10} align="flex-start">
        <View style={{ flex: 1.4 }}>
          <DateField label="Date" value={date} onChange={(v) => v && setDate(v)} />
        </View>
        <View style={{ flex: 1 }}>
          <TimeField label="Time" value={time} onChange={setTime} />
        </View>
      </Row>
      <Txt v="caption" dim style={{ fontWeight: '700', marginBottom: 6 }}>
        Repeat
      </Txt>
      <ChipScroller>
        <Chip label="Once" active={repeat === 'none'} onPress={() => setRepeat('none')} />
        {(['daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly'] as RecurrenceFrequency[]).map((f) => (
          <Chip key={f} label={RECURRENCE_LABEL[f]} active={repeat === f} onPress={() => setRepeat(f)} />
        ))}
      </ChipScroller>
      <Spacer h={10} />
      <SwitchRow label="Enabled" value={enabled} onChange={setEnabled} icon="notifications" />
    </Screen>
  );
}
