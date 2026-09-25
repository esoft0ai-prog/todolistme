import React, { useEffect, useState } from 'react';
import { Linking, View } from 'react-native';
import type { RootScreenProps } from '../../navigation/types';
import { expoNotificationGateway } from '../../platform/notifications';
import { clearHistory, listNotificationHistory, listScheduled, markAllRead, type PermissionState } from '../../services/notifications';
import { getLastSync, mutate, runNotificationSync } from '../../state/actions';
import { useAppStore } from '../../state/appStore';
import { useQuery } from '../../state/useQuery';
import { confirmDialog } from '../../ui/components/feedback';
import { Button, Card, EmptyState, Icon, IconButton, ListRow, LoadingBlock, Row, Screen, Segmented, Spacer, Txt } from '../../ui/components/primitives';
import { useTheme } from '../../ui/theme';

const CHANNEL_ICON: Record<string, string> = { debts: 'card', bills: 'receipt', budgets: 'pie-chart', savings: 'flag', reminders: 'alarm', general: 'information-circle' };

export function NotificationsScreen({ navigation }: RootScreenProps<'Notifications'>) {
  const { c } = useTheme();
  const [tab, setTab] = useState<'history' | 'scheduled'>('history');
  const [permission, setPermission] = useState<PermissionState | null>(null);
  const q = useQuery(async (ctx) => ({ history: await listNotificationHistory(ctx), scheduled: await listScheduled(ctx, 200) }));

  useEffect(() => {
    void expoNotificationGateway.getPermission().then(setPermission);
    const store = useAppStore.getState();
    if (store.ctx) void markAllRead(store.ctx).then(() => store.setUnread(0));
  }, []);

  const request = async () => {
    const p = await expoNotificationGateway.requestPermission();
    setPermission(p);
    if (p === 'granted') {
      await runNotificationSync();
      useAppStore.getState().bump();
    } else await Linking.openSettings().catch(() => undefined);
  };

  const sync = getLastSync();
  return (
    <Screen
      title="Notifications"
      onBack={() => navigation.goBack()}
      right={<IconButton icon="settings-outline" label="Notification settings" onPress={() => navigation.navigate('NotificationSettings')} />}
    >
      {permission && permission !== 'granted' && permission !== 'unsupported' ? (
        <Card tone="warning" style={{ marginBottom: 12 }}>
          <Row gap={10} align="flex-start">
            <Icon name="notifications-off" size={20} color={c.warning} />
            <View style={{ flex: 1 }}>
              <Txt v="bodyStrong">Notifications are blocked</Txt>
              <Txt v="small" dim>
                Finora cannot remind you about due payments until you allow notifications. Reminders are created on this phone — no internet needed.
              </Txt>
              <Spacer h={8} />
              <Button title={permission === 'denied' ? 'Open settings' : 'Allow notifications'} small onPress={request} />
            </View>
          </Row>
        </Card>
      ) : null}
      <Segmented value={tab} onChange={setTab} options={[{ value: 'history', label: 'History' }, { value: 'scheduled', label: `Scheduled${q.data ? ` (${q.data.scheduled.length})` : ''}` }]} />
      <Spacer h={12} />
      {!q.data ? (
        <LoadingBlock />
      ) : tab === 'history' ? (
        q.data.history.length === 0 ? (
          <EmptyState icon="notifications-outline" title="No notifications yet" message="Delivered reminders and budget alerts will appear here." />
        ) : (
          <>
            <Card padded={false} style={{ paddingHorizontal: 14 }}>
              {q.data.history.map((n) => (
                <ListRow key={n.id} icon={CHANNEL_ICON[n.channel] ?? 'notifications'} iconColor={n.channel === 'debts' ? c.warning : c.primary} title={n.title} subtitle={`${n.body}\n${new Date(n.firedAt).toLocaleString()}`} />
              ))}
            </Card>
            <Spacer h={10} />
            <Button
              title="Clear history"
              variant="ghost"
              small
              onPress={async () => {
                if (await confirmDialog({ title: 'Clear notification history?', confirmText: 'Clear', destructive: true })) await mutate((ctx) => clearHistory(ctx), { success: 'History cleared' });
              }}
            />
          </>
        )
      ) : q.data.scheduled.length === 0 ? (
        <EmptyState icon="alarm-outline" title="Nothing scheduled" message="Add debts, bills or reminders and Finora will schedule local notifications for them." />
      ) : (
        <>
          <Card padded={false} style={{ paddingHorizontal: 14 }}>
            {q.data.scheduled.map((n) => (
              <ListRow key={n.key} icon={CHANNEL_ICON[n.channel] ?? 'alarm'} iconColor={c.accent} title={n.title} subtitle={`${new Date(n.fire_at).toLocaleString()} · ${n.body}`} />
            ))}
          </Card>
          <Txt v="caption" faint style={{ marginTop: 8 }}>
            Scheduled locally with Android's alarm service — survives app closing and phone restarts. {sync ? `Last sync: ${sync.scheduled} added, ${sync.cancelled} removed.` : ''}
          </Txt>
        </>
      )}
    </Screen>
  );
}
