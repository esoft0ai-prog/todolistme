import Constants from 'expo-constants';
import React, { useEffect, useState } from 'react';
import { Linking, Platform, View } from 'react-native';
import { CURRENCIES, getCurrency } from '../../domain/currency';
import type { NotificationChannel, ThemeMode } from '../../domain/types';
import type { RootScreenProps } from '../../navigation/types';
import { expoNotificationGateway } from '../../platform/notifications';
import { biometricGateway, securityService } from '../../platform/security';
import { listAudit } from '../../services/audit';
import { deleteDemoData, hasDemoData, loadDemoData } from '../../services/demo';
import { deleteRate, listRates, recalculateBaseAmounts, setRate } from '../../services/rates';
import { validatePin } from '../../services/security';
import { mutate, runNotificationSync, updatePrefs } from '../../state/actions';
import { useAppStore, useCtx, usePrefs } from '../../state/appStore';
import { useQuery } from '../../state/useQuery';
import { alertDialog, confirmDialog } from '../../ui/components/feedback';
import { OptionSheet, Sheet, SwitchRow, TextField, TimeField } from '../../ui/components/forms';
import { PinPad } from '../../ui/components/PinPad';
import { Badge, Button, Card, Chip, ChipScroller, Icon, ListRow, LoadingBlock, Row, Screen, SectionHeader, Segmented, Spacer, Txt } from '../../ui/components/primitives';
import { resetAllData } from '../../core/bootstrap';
import { useTheme } from '../../ui/theme';

export const APP_VERSION: string = Constants.expoConfig?.version ?? '1.0.0';

export function SettingsScreen({ navigation }: RootScreenProps<'Settings'>) {
  const { c } = useTheme();
  const prefs = usePrefs();
  const [currencyOpen, setCurrencyOpen] = useState(false);
  const demo = useQuery((ctx) => hasDemoData(ctx));
  const [busy, setBusy] = useState(false);

  const changeCurrency = async (code: string) => {
    setCurrencyOpen(false);
    if (code === prefs.baseCurrency) return;
    const ok = await confirmDialog({
      title: `Use ${code} as your main currency?`,
      message: 'Totals, budgets and reports will be shown in this currency. Accounts in other currencies are converted using the exchange rates you set in Currency & rates.',
      confirmText: 'Change',
    });
    if (!ok) return;
    await updatePrefs({ baseCurrency: code });
    await mutate((ctx) => recalculateBaseAmounts(ctx), { success: `Main currency set to ${code}` });
  };

  const toggleDemo = async () => {
    if (demo.data) {
      if (!(await confirmDialog({ title: 'Delete all sample data?', message: 'Only records marked “sample” are removed. Your own records are kept.', confirmText: 'Delete sample data', destructive: true }))) return;
      setBusy(true);
      const res = await mutate((ctx) => deleteDemoData(ctx), { success: 'Sample data removed' });
      setBusy(false);
      if (res.ok) {
        useAppStore.getState().setPrefs({ ...useAppStore.getState().prefs, demoDataLoaded: false });
        if (res.value.keptAccounts) await alertDialog('Some sample accounts were kept', `${res.value.keptAccounts} sample account(s) contain your own transactions, so they were kept and converted to normal accounts.`);
      }
    } else {
      if (!(await confirmDialog({ title: 'Load sample data?', message: 'Adds realistic example accounts, transactions, debts, goals and budgets — all clearly labelled “sample” and removable any time.', confirmText: 'Load' }))) return;
      setBusy(true);
      const res = await mutate((ctx) => loadDemoData(ctx), { success: 'Sample data loaded' });
      setBusy(false);
      if (res.ok) useAppStore.getState().setPrefs({ ...useAppStore.getState().prefs, demoDataLoaded: true });
    }
  };

  return (
    <Screen title="Settings" onBack={() => navigation.goBack()}>
      <SectionHeader title="General" />
      <Card padded={false} style={{ paddingHorizontal: 14 }}>
        <ListRow icon="cash" title="Main currency" subtitle={`${getCurrency(prefs.baseCurrency).name} (${getCurrency(prefs.baseCurrency).symbol})`} chevron onPress={() => setCurrencyOpen(true)} />
        <ListRow icon="swap-horizontal" title="Currency & exchange rates" subtitle="For accounts in other currencies" chevron onPress={() => navigation.navigate('CurrencySettings')} />
        <ListRow icon="wallet" title="Accounts" chevron onPress={() => navigation.navigate('Accounts')} />
        <ListRow icon="pricetags" title="Categories" chevron onPress={() => navigation.navigate('Categories')} />
      </Card>

      <SectionHeader title="Appearance & accessibility" />
      <Card>
        <Segmented<ThemeMode>
          value={prefs.themeMode}
          onChange={(v) => updatePrefs({ themeMode: v })}
          options={[
            { value: 'dark', label: 'Dark' },
            { value: 'light', label: 'Light' },
            { value: 'system', label: 'System' },
          ]}
        />
        <SwitchRow label="Larger text" description="Increase text size throughout the app (also follows your phone's font size)" value={prefs.largeText} onChange={(v) => updatePrefs({ largeText: v })} icon="text" />
        <Txt v="caption" dim style={{ marginTop: 4, marginBottom: 6 }}>
          Week starts on
        </Txt>
        <Segmented value={String(prefs.weekStartsOn) as '0' | '1'} onChange={(v) => updatePrefs({ weekStartsOn: v === '0' ? 0 : 1 })} options={[{ value: '1', label: 'Monday' }, { value: '0', label: 'Sunday' }]} />
      </Card>

      <SectionHeader title="Security & privacy" />
      <Card padded={false} style={{ paddingHorizontal: 14 }}>
        <ListRow icon="lock-closed" title="App lock" subtitle={prefs.appLockEnabled ? `On · locks after ${prefs.autoLockSeconds ? `${prefs.autoLockSeconds / 60 >= 1 ? `${prefs.autoLockSeconds / 60} min` : `${prefs.autoLockSeconds}s`}` : 'leaving the app'}` : 'Off'} chevron onPress={() => navigation.navigate('SecuritySettings')} />
        <ListRow icon="notifications" title="Notifications" subtitle={prefs.notificationsEnabled ? 'On' : 'Off'} chevron onPress={() => navigation.navigate('NotificationSettings')} />
        <ListRow icon="cloud-download" title="Backup & restore" subtitle="Your data exists only on this phone — back it up" chevron onPress={() => navigation.navigate('Backup')} />
        <ListRow icon="document-text" title="Activity log" subtitle="Local audit trail of changes" chevron onPress={() => navigation.navigate('AuditLog')} />
        <ListRow icon="shield-checkmark" title="Privacy & about" chevron onPress={() => navigation.navigate('About')} />
      </Card>

      <SectionHeader title="Sample data" />
      <Card>
        <Row gap={10}>
          <Icon name="flask" size={20} color={c.warning} />
          <Txt v="small" dim style={{ flex: 1 }}>
            {demo.data ? 'Sample data is loaded. Every sample record is labelled “sample”.' : 'Explore Finora with realistic example data. It never mixes silently with your own records.'}
          </Txt>
        </Row>
        <Spacer h={10} />
        <Button title={demo.data ? 'Delete sample data' : 'Load sample data'} variant={demo.data ? 'danger' : 'secondary'} onPress={toggleDemo} loading={busy} />
      </Card>

      <SectionHeader title="Danger zone" />
      <Card tone="danger">
        <Txt v="small" dim>
          Erase everything on this phone (database, PIN and keys) and start over. Make a backup first — this cannot be undone.
        </Txt>
        <Spacer h={10} />
        <Button
          title="Erase all data"
          variant="danger"
          icon="trash"
          onPress={async () => {
            if (!(await confirmDialog({ title: 'Erase all data?', message: 'All accounts, transactions, debts, goals and settings will be permanently deleted from this phone.', confirmText: 'Erase', destructive: true }))) return;
            if (!(await confirmDialog({ title: 'Are you absolutely sure?', message: 'There is no way to recover your data without a backup file.', confirmText: 'Yes, erase everything', destructive: true }))) return;
            await resetAllData();
          }}
        />
      </Card>
      <Txt v="caption" faint center style={{ marginTop: 20 }}>
        Finora {APP_VERSION} · works 100% offline
      </Txt>
      <OptionSheet
        visible={currencyOpen}
        title="Main currency"
        value={prefs.baseCurrency}
        searchable
        options={CURRENCIES.map((x) => ({ value: x.code, label: `${x.name}`, subtitle: `${x.code} · ${x.symbol}` }))}
        onPick={changeCurrency}
        onClose={() => setCurrencyOpen(false)}
      />
    </Screen>
  );
}

const AUTO_LOCK: { value: number; label: string }[] = [
  { value: 0, label: 'Immediately' },
  { value: 30, label: '30 s' },
  { value: 60, label: '1 min' },
  { value: 300, label: '5 min' },
  { value: 900, label: '15 min' },
];

export function SecuritySettingsScreen({ navigation }: RootScreenProps<'SecuritySettings'>) {
  const { c } = useTheme();
  const prefs = usePrefs();
  const [hasPin, setHasPin] = useState<boolean | null>(null);
  const [bioAvailable, setBioAvailable] = useState(false);
  const [pinFlow, setPinFlow] = useState<null | { step: 'current' | 'new' | 'confirm'; first?: string; purpose: 'enable' | 'change' | 'disable' }>(null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string>();

  useEffect(() => {
    void securityService.hasPin().then(setHasPin);
    void biometricGateway.isAvailable().then(setBioAvailable);
  }, []);

  const startEnable = () => {
    setPin('');
    setError(undefined);
    setPinFlow({ step: 'new', purpose: 'enable' });
  };

  const submit = async (value: string) => {
    if (!pinFlow) return;
    if (pinFlow.step === 'current') {
      const r = await securityService.verifyPin(value);
      if (!r.ok) {
        setError(r.lockedMs ? `Too many attempts. Try again in ${Math.ceil(r.lockedMs / 1000)}s` : `${r.error}${r.attemptsLeft ? ` — ${r.attemptsLeft} attempts left` : ''}`);
        setPin('');
        return;
      }
      if (pinFlow.purpose === 'disable') {
        await securityService.clearPin();
        await updatePrefs({ appLockEnabled: false, biometricEnabled: false });
        setHasPin(false);
        setPinFlow(null);
        useAppStore.getState().showToast('App lock turned off');
        return;
      }
      setPinFlow({ step: 'new', purpose: pinFlow.purpose });
      setPin('');
      setError(undefined);
      return;
    }
    if (pinFlow.step === 'new') {
      const problem = validatePin(value);
      if (problem) {
        setError(problem);
        setPin('');
        return;
      }
      setPinFlow({ ...pinFlow, step: 'confirm', first: value });
      setPin('');
      setError(undefined);
      return;
    }
    if (value !== pinFlow.first) {
      setError('PINs do not match. Try again.');
      setPinFlow({ step: 'new', purpose: pinFlow.purpose });
      setPin('');
      return;
    }
    await securityService.setPin(value);
    await updatePrefs({ appLockEnabled: true });
    setHasPin(true);
    setPinFlow(null);
    useAppStore.getState().showToast(pinFlow.purpose === 'change' ? 'PIN changed' : 'App lock enabled');
  };

  const onPinChange = (v: string) => {
    setPin(v);
    setError(undefined);
  };

  const enabled = prefs.appLockEnabled && hasPin;
  return (
    <Screen title="Security" onBack={() => navigation.goBack()}>
      {hasPin == null ? (
        <LoadingBlock />
      ) : (
        <>
          <Card>
            <Row gap={12}>
              <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: enabled ? c.successSoft : c.inputBg, alignItems: 'center', justifyContent: 'center' }}>
                <Icon name={enabled ? 'lock-closed' : 'lock-open'} size={22} color={enabled ? c.success : c.textDim} />
              </View>
              <View style={{ flex: 1 }}>
                <Txt v="bodyStrong">App lock is {enabled ? 'on' : 'off'}</Txt>
                <Txt v="caption" dim>
                  {enabled ? 'A PIN (and optionally your fingerprint) is required to open Finora.' : 'Anyone with your unlocked phone can open Finora.'}
                </Txt>
              </View>
            </Row>
            <Spacer h={12} />
            {enabled ? (
              <Row gap={10}>
                <Button title="Change PIN" variant="secondary" small onPress={() => (setPin(''), setError(undefined), setPinFlow({ step: 'current', purpose: 'change' }))} style={{ flex: 1 }} />
                <Button title="Turn off" variant="ghost" small onPress={() => (setPin(''), setError(undefined), setPinFlow({ step: 'current', purpose: 'disable' }))} style={{ flex: 1 }} />
              </Row>
            ) : (
              <Button title="Set up PIN lock" icon="keypad" onPress={startEnable} />
            )}
          </Card>
          {enabled ? (
            <>
              <SectionHeader title="Options" />
              <Card>
                <SwitchRow
                  label="Fingerprint / face unlock"
                  description={bioAvailable ? 'Use your phone’s biometrics; your PIN remains the fallback' : 'No biometrics enrolled on this phone'}
                  value={prefs.biometricEnabled && bioAvailable}
                  disabled={!bioAvailable}
                  onChange={async (v) => {
                    if (v) {
                      const r = await biometricGateway.authenticate('Confirm to enable biometric unlock');
                      if (!r.success) return;
                    }
                    await updatePrefs({ biometricEnabled: v });
                  }}
                  icon="finger-print"
                />
                <Txt v="caption" dim style={{ marginTop: 8, marginBottom: 6 }}>
                  Lock automatically after leaving the app
                </Txt>
                <ChipScroller>
                  {AUTO_LOCK.map((a) => (
                    <Chip key={a.value} label={a.label} active={prefs.autoLockSeconds === a.value} onPress={() => updatePrefs({ autoLockSeconds: a.value })} />
                  ))}
                </ChipScroller>
              </Card>
            </>
          ) : null}
          <SectionHeader title="Privacy screen" />
          <Card>
            <SwitchRow label="Hide content in recent apps" description="Blocks screenshots and screen recording, and blanks Finora in the app switcher" value={prefs.hideInRecents} onChange={(v) => updatePrefs({ hideInRecents: v })} icon="eye-off" />
          </Card>
          <SectionHeader title="How your data is protected" />
          <Card>
            {[
              'Your database is encrypted with SQLCipher (AES-256) using a random key stored in the Android Keystore.',
              'Your PIN is never stored — only a salted PBKDF2 hash inside the Keystore-protected secure storage.',
              'After 5 wrong PINs, Finora locks for 30 seconds, doubling after each further failure (up to 1 hour).',
              'Finora has no internet permission in release builds, no analytics and no ads. Nothing leaves your phone unless you export it.',
            ].map((t) => (
              <Row key={t} gap={8} align="flex-start" style={{ marginBottom: 6 }}>
                <Icon name="checkmark-circle" size={16} color={c.success} />
                <Txt v="small" dim style={{ flex: 1 }}>
                  {t}
                </Txt>
              </Row>
            ))}
          </Card>
        </>
      )}
      <Sheet visible={!!pinFlow} onClose={() => setPinFlow(null)} title={pinFlow?.step === 'current' ? 'Enter current PIN' : pinFlow?.step === 'new' ? 'Choose a new PIN (4–6 digits)' : 'Confirm your PIN'}>
        <PinPad value={pin} onChange={onPinChange} />
        {error ? (
          <Txt v="small" color={c.danger} center style={{ marginTop: 12 }}>
            {error}
          </Txt>
        ) : null}
        <Spacer h={12} />
        <Button title="Continue" onPress={() => submit(pin)} disabled={pin.length < 4} />
      </Sheet>
    </Screen>
  );
}

const CHANNEL_INFO: { key: NotificationChannel; label: string; desc: string; icon: string }[] = [
  { key: 'debts', label: 'Debt payments', desc: 'Upcoming, due, overdue and final payments', icon: 'card' },
  { key: 'bills', label: 'Bills & recurring', desc: 'Bills, subscriptions and expected income', icon: 'receipt' },
  { key: 'budgets', label: 'Budget warnings', desc: 'When spending pace puts a budget at risk', icon: 'pie-chart' },
  { key: 'savings', label: 'Savings reminders', desc: 'Weekly or monthly nudges for goals', icon: 'flag' },
  { key: 'reminders', label: 'Custom reminders', desc: 'Reminders and calendar events you created', icon: 'alarm' },
  { key: 'general', label: 'Backup reminders', desc: 'Monthly reminder to back up your data', icon: 'cloud-download' },
];

export function NotificationSettingsScreen({ navigation }: RootScreenProps<'NotificationSettings'>) {
  const { c } = useTheme();
  const prefs = usePrefs();
  const [permission, setPermission] = useState<string>('…');
  useEffect(() => {
    void expoNotificationGateway.getPermission().then(setPermission);
  }, []);
  const setChannel = (k: NotificationChannel, v: boolean) => updatePrefs({ notificationChannels: { ...prefs.notificationChannels, [k]: v } });
  const toggleOffset = (d: number) => {
    const next = prefs.defaultDebtReminderOffsets.includes(d) ? prefs.defaultDebtReminderOffsets.filter((x) => x !== d) : [...prefs.defaultDebtReminderOffsets, d].sort((a, b) => b - a);
    void updatePrefs({ defaultDebtReminderOffsets: next });
  };
  return (
    <Screen title="Notification settings" onBack={() => navigation.goBack()}>
      <Card>
        <SwitchRow
          label="Notifications"
          description={`Permission: ${permission}. All reminders are scheduled on this phone.`}
          value={prefs.notificationsEnabled}
          onChange={async (v) => {
            if (v && permission !== 'granted') {
              const p = await expoNotificationGateway.requestPermission();
              setPermission(p);
              if (p !== 'granted') {
                await alertDialog('Permission needed', 'Allow notifications for Finora in Android settings to receive reminders.', 'warning');
                await Linking.openSettings().catch(() => undefined);
              }
            }
            await updatePrefs({ notificationsEnabled: v });
          }}
          icon="notifications"
        />
      </Card>
      <SectionHeader title="Categories" />
      <Card padded={false} style={{ paddingHorizontal: 14 }}>
        {CHANNEL_INFO.map((ch) => (
          <SwitchRow key={ch.key} label={ch.label} description={ch.desc} value={prefs.notificationChannels[ch.key]} onChange={(v) => setChannel(ch.key, v)} disabled={!prefs.notificationsEnabled} icon={ch.icon as never} />
        ))}
      </Card>
      <SectionHeader title="Timing" />
      <Card>
        <TimeField label="Default reminder time" value={prefs.reminderTime} onChange={(v) => v && updatePrefs({ reminderTime: v })} />
        <Txt v="caption" dim style={{ marginBottom: 6 }}>
          Default debt reminders (can be changed per debt)
        </Txt>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {[30, 14, 7, 3, 1, 0].map((d) => (
            <Chip key={d} label={d === 0 ? 'On due date' : `${d} day${d > 1 ? 's' : ''} before`} active={prefs.defaultDebtReminderOffsets.includes(d)} onPress={() => toggleOffset(d)} />
          ))}
        </View>
      </Card>
      <SectionHeader title="Reliability" />
      <Card>
        <Txt v="small" dim>
          Reminders use Android’s alarm service, so they fire even when Finora is closed, swiped away from recent apps, or after the phone restarts. Some phone brands (e.g. Tecno, Infinix, itel,
          Xiaomi, Samsung) aggressively stop background apps — if reminders arrive late, set Finora’s battery usage to “Unrestricted”.
        </Txt>
        <Spacer h={10} />
        <Row gap={10}>
          {Platform.OS === 'android' ? <Button title="Battery settings" small variant="secondary" onPress={() => Linking.sendIntent('android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS').catch(() => Linking.openSettings())} style={{ flex: 1 }} /> : null}
          <Button
            title="Send test"
            small
            variant="secondary"
            style={{ flex: 1 }}
            onPress={async () => {
              if (permission !== 'granted') {
                await alertDialog('Notifications are not allowed', 'Turn on notifications first.', 'warning');
                return;
              }
              await expoNotificationGateway.ensureChannels();
              await expoNotificationGateway.presentNow({ title: 'Finora test notification', body: 'Reminders are working on this phone. ✅', channel: 'general' });
            }}
          />
        </Row>
        <Spacer h={8} />
        <Button
          title="Re-schedule all reminders now"
          small
          variant="ghost"
          onPress={async () => {
            const r = await runNotificationSync();
            useAppStore.getState().showToast(r?.error ? `Failed: ${r.error}` : `Reminders up to date (${r?.total ?? 0} scheduled)`, r?.error ? 'bad' : 'good');
          }}
        />
      </Card>
      <Txt v="caption" faint style={{ marginTop: 10 }}>
        <Badge label="Tip" color={c.info} /> Finora never uses Firebase or any server for reminders.
      </Txt>
    </Screen>
  );
}

export function CurrencySettingsScreen({ navigation }: RootScreenProps<'CurrencySettings'>) {
  const prefs = usePrefs();
  const q = useQuery(async (ctx) => ({ rates: await listRates(ctx.db), used: await ctx.db.all<{ currency: string }>('SELECT DISTINCT currency FROM accounts UNION SELECT DISTINCT currency FROM debts UNION SELECT DISTINCT currency FROM savings_goals') }));
  const [editing, setEditing] = useState<{ code: string; text: string } | null>(null);
  const [pick, setPick] = useState(false);
  const base = getCurrency(prefs.baseCurrency);
  const save = async () => {
    if (!editing) return;
    const rate = Number(editing.text.replace(',', '.'));
    const res = await mutate(
      async (ctx) => {
        await setRate(ctx, editing.code, rate);
        await recalculateBaseAmounts(ctx);
      },
      { success: 'Rate saved' },
    );
    if (res.ok) setEditing(null);
  };
  const used = (q.data?.used ?? []).map((u) => u.currency).filter((x) => x !== prefs.baseCurrency);
  return (
    <Screen title="Currency & rates" onBack={() => navigation.goBack()}>
      <Card>
        <Txt v="small" dim>
          Main currency: <Txt v="small" style={{ fontWeight: '700' }}>{base.name} ({base.code})</Txt>. Finora works offline, so exchange rates are entered by you. Each transaction stores the rate used when
          it was recorded; changing a rate recalculates the converted totals.
        </Txt>
      </Card>
      <SectionHeader title="Exchange rates" action="Add" onAction={() => setPick(true)} />
      {!q.data ? (
        <LoadingBlock />
      ) : (
        <Card padded={false} style={{ paddingHorizontal: 14 }}>
          {[...new Set([...used, ...q.data.rates.map((r) => r.currency)])].map((code) => {
            const r = q.data!.rates.find((x) => x.currency === code);
            return (
              <ListRow
                key={code}
                icon="swap-horizontal"
                title={`1 ${code} = ${r ? r.rate : '?'} ${prefs.baseCurrency}`}
                subtitle={r ? `Updated ${new Date(r.updatedAt).toLocaleDateString()}` : 'Not set — converted 1:1. Tap to set.'}
                badge={r ? undefined : 'Missing'}
                chevron
                onPress={() => setEditing({ code, text: r ? String(r.rate) : '' })}
              />
            );
          })}
          {used.length === 0 && q.data.rates.length === 0 ? (
            <Txt v="small" dim style={{ paddingVertical: 14 }}>
              All your accounts use {prefs.baseCurrency}. Add a rate only if you use other currencies.
            </Txt>
          ) : null}
        </Card>
      )}
      <Sheet visible={!!editing} onClose={() => setEditing(null)} title={`Rate for ${editing?.code}`}>
        {editing ? (
          <>
            <TextField label={`1 ${editing.code} equals how many ${prefs.baseCurrency}?`} value={editing.text} onChangeText={(v) => setEditing({ ...editing, text: v.replace(/[^0-9.,]/g, '') })} keyboardType="decimal-pad" autoFocus />
            <Row gap={10}>
              {q.data?.rates.some((r) => r.currency === editing.code) ? (
                <Button title="Remove" variant="ghost" onPress={async () => (await mutate(async (ctx) => { await deleteRate(ctx, editing.code); await recalculateBaseAmounts(ctx); }), setEditing(null))} style={{ flex: 1 }} />
              ) : null}
              <Button title="Save" onPress={save} style={{ flex: 1 }} disabled={!(Number(editing.text.replace(',', '.')) > 0)} />
            </Row>
          </>
        ) : null}
      </Sheet>
      <OptionSheet
        visible={pick}
        title="Currency"
        value={null}
        searchable
        options={CURRENCIES.filter((x) => x.code !== prefs.baseCurrency).map((x) => ({ value: x.code, label: x.name, subtitle: x.code }))}
        onPick={(code) => {
          setPick(false);
          setEditing({ code, text: '' });
        }}
        onClose={() => setPick(false)}
      />
    </Screen>
  );
}

export function AuditLogScreen({ navigation }: RootScreenProps<'AuditLog'>) {
  const { c } = useTheme();
  const ctx = useCtx();
  const q = useQuery(() => listAudit(ctx, 300));
  return (
    <Screen title="Activity log" subtitle="Stored only on this phone" onBack={() => navigation.goBack()}>
      {!q.data ? (
        <LoadingBlock />
      ) : (
        <Card padded={false} style={{ paddingHorizontal: 14 }}>
          {q.data.map((a) => (
            <ListRow
              key={a.id}
              icon={a.action === 'create' ? 'add-circle' : a.action === 'delete' ? 'trash' : a.action === 'restore' || a.action === 'import' ? 'cloud-download' : a.action === 'export' ? 'cloud-upload' : 'create'}
              iconColor={a.action === 'delete' ? c.danger : a.action === 'create' ? c.success : c.info}
              title={a.summary}
              subtitle={`${a.entity_type} · ${new Date(a.created_at).toLocaleString()}`}
            />
          ))}
          {q.data.length === 0 ? (
            <Txt v="small" dim style={{ paddingVertical: 14 }}>
              No activity yet.
            </Txt>
          ) : null}
        </Card>
      )}
    </Screen>
  );
}

export function AboutScreen({ navigation }: RootScreenProps<'About'>) {
  const { c } = useTheme();
  const points: [string, string][] = [
    ['cloud-offline', 'Works 100% offline. No account, no server, no cloud database, no Firebase.'],
    ['lock-closed', 'Encrypted database (SQLCipher AES-256) with the key held in the Android Keystore.'],
    ['eye-off', 'No analytics, no ads, no trackers. The release app does not even request internet access.'],
    ['hand-left', 'No access to your location, contacts, SMS, call logs, microphone or camera.'],
    ['share-social', 'Data only leaves your phone when you export a backup or report yourself.'],
    ['sparkles', 'The assistant is rule-based and runs entirely on your phone — it is not a cloud AI.'],
  ];
  return (
    <Screen title="Privacy & about" onBack={() => navigation.goBack()}>
      <Card>
        <Txt v="h2">Finora</Txt>
        <Txt v="small" dim>
          Personal Finance & Debt Intelligence · version {APP_VERSION}
        </Txt>
      </Card>
      <SectionHeader title="Your privacy" />
      <Card>
        {points.map(([icon, text]) => (
          <Row key={text} gap={10} align="flex-start" style={{ marginBottom: 10 }}>
            <Icon name={icon} size={18} color={c.accent} />
            <Txt v="small" style={{ flex: 1 }}>
              {text}
            </Txt>
          </Row>
        ))}
      </Card>
      <SectionHeader title="Important" />
      <Card>
        <Txt v="small" dim>
          Because Finora stores everything only on this phone, uninstalling the app or losing the phone deletes your data. Export a backup regularly (Settings → Backup & restore) and keep it somewhere
          safe, such as your email, Google Drive, a memory card or a computer. Finora provides calculations to help you plan; it is not financial, legal or tax advice.
        </Txt>
      </Card>
    </Screen>
  );
}
