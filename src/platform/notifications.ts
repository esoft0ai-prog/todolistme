import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import type { PlannedNotification } from '../domain/reminderPlanner';
import type { NotificationChannel } from '../domain/types';
import type { NotificationGateway, PermissionState } from '../services/notifications';

/**
 * expo-notifications adapter. Scheduled notifications are stored by the native
 * module and armed with AlarmManager (exact alarms when permitted). They are
 * re-armed automatically after a reboot (BOOT_COMPLETED) or app update
 * (MY_PACKAGE_REPLACED) — no server, Firebase or internet involved.
 */

const CHANNELS: { id: NotificationChannel; name: string; description: string; importance: Notifications.AndroidImportance }[] = [
  { id: 'debts', name: 'Debt payments', description: 'Upcoming, due and overdue loan and debt payments', importance: Notifications.AndroidImportance.HIGH },
  { id: 'bills', name: 'Bills & recurring payments', description: 'Bills and expected income', importance: Notifications.AndroidImportance.HIGH },
  { id: 'budgets', name: 'Budget warnings', description: 'Alerts when a budget is at risk or exceeded', importance: Notifications.AndroidImportance.DEFAULT },
  { id: 'savings', name: 'Savings reminders', description: 'Reminders to save towards your goals', importance: Notifications.AndroidImportance.DEFAULT },
  { id: 'reminders', name: 'Custom reminders', description: 'Reminders you created', importance: Notifications.AndroidImportance.HIGH },
  { id: 'general', name: 'General', description: 'Backup reminders and other tips', importance: Notifications.AndroidImportance.LOW },
];

let handlerInstalled = false;

export function installForegroundHandler(): void {
  if (handlerInstalled) return;
  handlerInstalled = true;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}

function mapStatus(s: Notifications.NotificationPermissionsStatus): PermissionState {
  if (s.granted) return 'granted';
  if (s.status === 'denied') return 'denied';
  return 'undetermined';
}

export const expoNotificationGateway: NotificationGateway = {
  async getPermission() {
    if (Platform.OS === 'web') return 'unsupported';
    return mapStatus(await Notifications.getPermissionsAsync());
  },
  async requestPermission() {
    if (Platform.OS === 'web') return 'unsupported';
    await this.ensureChannels(); // Android 13+ requires a channel before the permission prompt
    return mapStatus(await Notifications.requestPermissionsAsync());
  },
  async ensureChannels() {
    if (Platform.OS !== 'android') return;
    for (const c of CHANNELS) {
      await Notifications.setNotificationChannelAsync(c.id, {
        name: c.name,
        description: c.description,
        importance: c.importance,
        lightColor: '#7C8CFF',
        vibrationPattern: [0, 200, 120, 200],
        lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
        showBadge: true,
      });
    }
  },
  async schedule(n: PlannedNotification) {
    return Notifications.scheduleNotificationAsync({
      content: {
        title: n.title,
        body: n.body,
        data: { key: n.key, entityType: n.entityType ?? '', entityId: n.entityId ?? '' },
        sound: 'default',
      },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: n.fireAt, channelId: n.channel },
    });
  },
  async cancel(osId: string) {
    await Notifications.cancelScheduledNotificationAsync(osId);
  },
  async listScheduledIds() {
    if (Platform.OS === 'web') return [];
    return (await Notifications.getAllScheduledNotificationsAsync()).map((n) => n.identifier);
  },
  async presentNow(n: { title: string; body: string; channel: NotificationChannel; data?: Record<string, string> }) {
    await Notifications.scheduleNotificationAsync({
      content: { title: n.title, body: n.body, data: n.data ?? {}, sound: 'default' },
      trigger: Platform.OS === 'android' ? { channelId: n.channel } : null,
    });
  },
};

/** Subscribe to taps on notifications (used to deep-link to the related screen). */
export function onNotificationTap(cb: (data: Record<string, unknown>) => void): () => void {
  if (Platform.OS === 'web') return () => undefined;
  const sub = Notifications.addNotificationResponseReceivedListener((r) => cb((r.notification.request.content.data ?? {}) as Record<string, unknown>));
  // A tap that cold-started the app happens before the listener exists.
  void Notifications.getLastNotificationResponseAsync()
    .then((r) => {
      if (r) {
        cb((r.notification.request.content.data ?? {}) as Record<string, unknown>);
        void Notifications.clearLastNotificationResponseAsync();
      }
    })
    .catch(() => undefined);
  return () => sub.remove();
}
