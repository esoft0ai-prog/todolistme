import { LinearGradient } from 'expo-linear-gradient';
import React, { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CURRENCIES, getCurrency } from '../domain/currency';
import { addMonths, today } from '../domain/dates';
import { formatMoney } from '../domain/money';
import type { AccountType } from '../domain/types';
import { biometricGateway, securityService } from '../platform/security';
import { expoNotificationGateway } from '../platform/notifications';
import { createAccount } from '../services/accounts';
import { createDebt } from '../services/debts';
import { loadDemoData } from '../services/demo';
import { createGoal } from '../services/goals';
import { savePreferences } from '../services/preferences';
import { validatePin } from '../services/security';
import { runNotificationSync } from '../state/actions';
import { useAppStore, useCtx } from '../state/appStore';
import { AmountField, DateField, OptionSheet, SwitchRow, TextField } from '../ui/components/forms';
import { PinPad } from '../ui/components/PinPad';
import { Button, Card, Chip, Icon, ListRow, ProgressBar, Row, Spacer, Txt, type IconName } from '../ui/components/primitives';
import { ACCOUNT_TYPE_ICON, ACCOUNT_TYPE_LABEL } from '../ui/labels';
import { useTheme } from '../ui/theme';

const GOALS: { key: string; label: string; icon: IconName }[] = [
  { key: 'debt', label: 'Get out of debt', icon: 'card' },
  { key: 'emergency', label: 'Build an emergency fund', icon: 'shield-checkmark' },
  { key: 'save', label: 'Save for something', icon: 'flag' },
  { key: 'spending', label: 'Control my spending', icon: 'pie-chart' },
  { key: 'business', label: 'Track business money', icon: 'briefcase' },
];

interface DebtDraft {
  lender: string;
  amount: number | null;
  monthly: number | null;
  due: string;
}

const STEPS = ['welcome', 'currency', 'income', 'balance', 'goal', 'debts', 'notifications', 'lock', 'finish'] as const;

export function OnboardingScreen() {
  const { c } = useTheme();
  const ctx = useCtx();
  const insets = useSafeAreaInsets();
  const [step, setStep] = useState(0);
  const [currency, setCurrency] = useState('NGN');
  const [currencyOpen, setCurrencyOpen] = useState(false);
  const [income, setIncome] = useState<number | null>(null);
  const [accName, setAccName] = useState('Bank account');
  const [accType, setAccType] = useState<AccountType>('bank');
  const [balance, setBalance] = useState<number | null>(null);
  const [cash, setCash] = useState<number | null>(null);
  const [goal, setGoal] = useState<string>('');
  const [goalName, setGoalName] = useState('');
  const [goalTarget, setGoalTarget] = useState<number | null>(null);
  const [goalDeadline, setGoalDeadline] = useState<string | null>(addMonths(today(), 6));
  const [debts, setDebts] = useState<DebtDraft[]>([]);
  const [draft, setDraft] = useState<DebtDraft>({ lender: '', amount: null, monthly: null, due: addMonths(today(), 1) });
  const [notif, setNotif] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const [pinFirst, setPinFirst] = useState<string | null>(null);
  const [pinError, setPinError] = useState<string>();
  const [pinDone, setPinDone] = useState(false);
  const [bio, setBio] = useState(false);
  const [demo, setDemo] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [error, setError] = useState<string>();
  const name = STEPS[step];
  const next = () => setStep((s) => Math.min(STEPS.length - 1, s + 1));
  const back = () => setStep((s) => Math.max(0, s - 1));

  const addDebt = () => {
    if (!draft.lender.trim() || !draft.amount) return;
    setDebts((d) => [...d, draft]);
    setDraft({ lender: '', amount: null, monthly: null, due: addMonths(today(), 1) });
  };

  const onPin = (v: string) => {
    setPin(v);
    setPinError(undefined);
  };
  const confirmPin = async () => {
    if (!pinFirst) {
      const problem = validatePin(pin);
      if (problem) {
        setPinError(problem);
        setPin('');
        return;
      }
      setPinFirst(pin);
      setPin('');
      return;
    }
    if (pin !== pinFirst) {
      setPinError('PINs do not match — start again');
      setPinFirst(null);
      setPin('');
      return;
    }
    await securityService.setPin(pin);
    setPinDone(true);
    if (await biometricGateway.isAvailable()) setBio(true);
  };

  const finish = async () => {
    setFinishing(true);
    setError(undefined);
    try {
      await ctx.db.transaction(async (tx) => {
        await savePreferences(ctx, { baseCurrency: currency, monthlyIncomeMinor: income ?? 0, mainGoal: goal }, tx);
        await createAccount(ctx, { name: accName.trim() || ACCOUNT_TYPE_LABEL[accType], type: accType, currency, openingBalanceMinor: balance ?? 0 }, tx);
        if (cash) await createAccount(ctx, { name: 'Cash', type: 'cash', currency, openingBalanceMinor: cash }, tx);
        if ((goal === 'save' || goal === 'emergency') && goalTarget) {
          await createGoal(
            ctx,
            {
              name: goalName.trim() || (goal === 'emergency' ? 'Emergency fund' : 'My savings goal'),
              targetMinor: goalTarget,
              currency,
              initialMinor: 0,
              startDate: today(),
              deadline: goalDeadline,
              linkedAccountId: null,
              icon: goal === 'emergency' ? 'shield-checkmark' : 'flag',
              color: '#22D3A6',
              reminderFrequency: 'monthly',
              notes: null,
            },
            tx,
          );
        }
        for (const d of debts) {
          await createDebt(
            ctx,
            {
              lenderName: d.lender.trim(),
              debtType: 'other',
              currency,
              principalMinor: d.amount!,
              interestType: 'none',
              interestValue: 0,
              paymentFrequency: d.monthly ? 'monthly' : 'one_time',
              minimumPaymentMinor: d.monthly ?? 0,
              installmentCount: d.monthly ? 0 : 1,
              startDate: today() < d.due ? today() : d.due,
              firstDueDate: d.due,
              endDate: null,
              penaltyType: 'none',
              penaltyValue: 0,
              paidBeforeMinor: 0,
              totalPayableOverrideMinor: null,
              notes: 'Added during setup — edit to add interest and terms',
            },
            { exec: tx },
          );
        }
        await savePreferences(
          ctx,
          { notificationsEnabled: notif === 'granted', appLockEnabled: pinDone, biometricEnabled: pinDone && bio, onboardingComplete: true },
          tx,
        );
      });
      if (demo) await loadDemoData(ctx);
      const prefs = await savePreferences(ctx, { demoDataLoaded: demo });
      const store = useAppStore.getState();
      store.setPrefs(prefs);
      store.bump();
      void runNotificationSync();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setFinishing(false);
    }
  };

  const skippable = ['income', 'balance', 'goal', 'debts', 'notifications', 'lock'].includes(name);

  const content = () => {
    switch (name) {
      case 'welcome':
        return (
          <>
            <LinearGradient colors={c.heroGradient} style={styles.logo}>
              <Icon name="trending-up" size={40} color="#fff" />
            </LinearGradient>
            <Txt v="display" center>
              Finora
            </Txt>
            <Txt v="h3" dim center>
              Personal Finance & Debt Intelligence
            </Txt>
            <Spacer h={24} />
            {(
              [
                ['cloud-offline', 'Works 100% offline — no account, no internet needed'],
                ['lock-closed', 'Encrypted on your phone. Nothing is ever uploaded'],
                ['card', 'Track loans, get payment reminders, never miss a due date'],
                ['sparkles', 'A private assistant that answers money questions'],
              ] as [IconName, string][]
            ).map(([i, t]) => (
              <Row key={t} gap={12} style={{ marginBottom: 12 }}>
                <View style={[styles.bullet, { backgroundColor: c.primarySoft }]}>
                  <Icon name={i} size={18} color={c.primary} />
                </View>
                <Txt v="body" style={{ flex: 1 }}>
                  {t}
                </Txt>
              </Row>
            ))}
          </>
        );
      case 'currency':
        return (
          <>
            <Txt v="h1">Your currency</Txt>
            <Txt v="body" dim style={{ marginBottom: 16 }}>
              Used for totals, budgets and reports. You can add accounts in other currencies later.
            </Txt>
            {CURRENCIES.slice(0, 6).map((cur) => (
              <Card key={cur.code} style={{ marginBottom: 8 }} tone={currency === cur.code ? 'primary' : undefined} onPress={() => setCurrency(cur.code)} accessibilityLabel={cur.name}>
                <Row gap={12}>
                  <Txt v="h3" style={{ width: 44 }}>
                    {cur.symbol}
                  </Txt>
                  <Txt v="bodyStrong" style={{ flex: 1 }}>
                    {cur.name}
                  </Txt>
                  {currency === cur.code ? <Icon name="checkmark-circle" size={22} color={c.primary} /> : null}
                </Row>
              </Card>
            ))}
            <Button title={`Other currency (${getCurrency(currency).code})`} variant="ghost" small onPress={() => setCurrencyOpen(true)} />
          </>
        );
      case 'income':
        return (
          <>
            <Txt v="h1">Monthly income</Txt>
            <Txt v="body" dim style={{ marginBottom: 16 }}>
              Roughly how much do you earn per month? This helps calculate your debt-to-income ratio before you record income. Optional.
            </Txt>
            <AmountField label="Monthly income" currency={currency} valueMinor={income} onChangeMinor={setIncome} big autoFocus />
          </>
        );
      case 'balance':
        return (
          <>
            <Txt v="h1">Starting balance</Txt>
            <Txt v="body" dim style={{ marginBottom: 16 }}>
              Create your first account. You can add more (wallets, savings, business) later.
            </Txt>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
              {(['bank', 'mobile_wallet', 'savings', 'business'] as AccountType[]).map((t) => (
                <Chip key={t} label={ACCOUNT_TYPE_LABEL[t]} icon={ACCOUNT_TYPE_ICON[t]} active={accType === t} onPress={() => (setAccType(t), setAccName(ACCOUNT_TYPE_LABEL[t]))} />
              ))}
            </View>
            <TextField label="Account name" value={accName} onChangeText={setAccName} maxLength={80} />
            <AmountField label="Current balance" currency={currency} valueMinor={balance} onChangeMinor={setBalance} allowZero />
            <AmountField label="Cash in hand (optional)" currency={currency} valueMinor={cash} onChangeMinor={setCash} allowZero />
          </>
        );
      case 'goal':
        return (
          <>
            <Txt v="h1">Main financial goal</Txt>
            <Txt v="body" dim style={{ marginBottom: 16 }}>
              What matters most to you right now?
            </Txt>
            {GOALS.map((g) => (
              <Card key={g.key} style={{ marginBottom: 8 }} tone={goal === g.key ? 'primary' : undefined} onPress={() => setGoal(g.key)} accessibilityLabel={g.label}>
                <Row gap={12}>
                  <Icon name={g.icon} size={20} color={c.primary} />
                  <Txt v="bodyStrong" style={{ flex: 1 }}>
                    {g.label}
                  </Txt>
                  {goal === g.key ? <Icon name="checkmark-circle" size={22} color={c.primary} /> : null}
                </Row>
              </Card>
            ))}
            {goal === 'save' || goal === 'emergency' ? (
              <View style={{ marginTop: 8 }}>
                <TextField label="Goal name" value={goalName} onChangeText={setGoalName} placeholder={goal === 'emergency' ? 'Emergency fund' : 'e.g. New Laptop'} />
                <AmountField label="Target amount" currency={currency} valueMinor={goalTarget} onChangeMinor={setGoalTarget} />
                <DateField label="Target date" value={goalDeadline} onChange={setGoalDeadline} optional minimumDate={today()} />
              </View>
            ) : null}
          </>
        );
      case 'debts':
        return (
          <>
            <Txt v="h1">Existing debts</Txt>
            <Txt v="body" dim style={{ marginBottom: 16 }}>
              Loans from banks, loan apps, family or friends. Add the basics now — you can add interest and full terms later.
            </Txt>
            {debts.map((d, i) => (
              <ListRow key={i} icon="card" iconColor={c.danger} title={d.lender} subtitle={d.monthly ? `${formatMoney(d.monthly, currency)}/month from ${d.due}` : `Due ${d.due}`} right={formatMoney(d.amount!, currency)} onPress={() => setDebts((x) => x.filter((_, j) => j !== i))} accessibilityLabel={`${d.lender}. Double tap to remove`} />
            ))}
            <Card>
              <TextField label="Who do you owe?" value={draft.lender} onChangeText={(v) => setDraft({ ...draft, lender: v })} placeholder="e.g. FairMoney, Uncle Tunde" maxLength={80} />
              <AmountField label="Amount owed" currency={currency} valueMinor={draft.amount} onChangeMinor={(v) => setDraft({ ...draft, amount: v })} />
              <AmountField label="Monthly payment (optional)" currency={currency} valueMinor={draft.monthly} onChangeMinor={(v) => setDraft({ ...draft, monthly: v })} hint="Leave empty if it is paid all at once." />
              <DateField label={draft.monthly ? 'Next payment date' : 'Due date'} value={draft.due} onChange={(v) => v && setDraft({ ...draft, due: v })} />
              <Button title="Add debt" icon="add" variant="secondary" onPress={addDebt} disabled={!draft.lender.trim() || !draft.amount} />
            </Card>
          </>
        );
      case 'notifications':
        return (
          <>
            <Txt v="h1">Payment reminders</Txt>
            <Txt v="body" dim style={{ marginBottom: 16 }}>
              Get reminded before debts and bills are due, when payments are overdue, and when a budget is at risk. Reminders are created on your phone and work without internet.
            </Txt>
            <Card>
              {notif === 'granted' ? (
                <Row gap={10}>
                  <Icon name="checkmark-circle" size={22} color={c.success} />
                  <Txt v="bodyStrong">Notifications allowed</Txt>
                </Row>
              ) : (
                <>
                  <Button title="Allow notifications" icon="notifications" onPress={async () => setNotif(await expoNotificationGateway.requestPermission())} />
                  {notif && notif !== 'granted' ? (
                    <Txt v="small" color={c.warning} style={{ marginTop: 8 }}>
                      Notifications were not allowed. You can enable them later in Settings.
                    </Txt>
                  ) : null}
                </>
              )}
            </Card>
          </>
        );
      case 'lock':
        return (
          <>
            <Txt v="h1">Protect Finora</Txt>
            <Txt v="body" dim style={{ marginBottom: 16 }}>
              {pinDone ? 'App lock is set up.' : pinFirst ? 'Enter the same PIN again to confirm.' : 'Choose a 4–6 digit PIN to lock the app. Optional but recommended.'}
            </Txt>
            {pinDone ? (
              <Card>
                <Row gap={10}>
                  <Icon name="lock-closed" size={22} color={c.success} />
                  <Txt v="bodyStrong">PIN lock enabled</Txt>
                </Row>
                <SwitchRow label="Also use fingerprint / face" value={bio} onChange={async (v) => setBio(v && (await biometricGateway.authenticate('Confirm biometric unlock')).success)} icon="finger-print" />
              </Card>
            ) : (
              <>
                <PinPad value={pin} onChange={onPin} />
                {pinError ? (
                  <Txt v="small" color={c.danger} center style={{ marginTop: 10 }}>
                    {pinError}
                  </Txt>
                ) : null}
                <Spacer h={12} />
                <Button title={pinFirst ? 'Confirm PIN' : 'Set PIN'} onPress={confirmPin} disabled={pin.length < 4} />
              </>
            )}
          </>
        );
      case 'finish':
        return (
          <>
            <LinearGradient colors={c.heroGradient} style={styles.logo}>
              <Icon name="checkmark" size={40} color="#fff" />
            </LinearGradient>
            <Txt v="h1" center>
              You're all set
            </Txt>
            <Txt v="body" dim center style={{ marginBottom: 20 }}>
              Remember: your data lives only on this phone. Make regular backups from Settings → Backup & restore.
            </Txt>
            <Card>
              <SwitchRow label="Load sample data" description="Explore with realistic examples (clearly labelled, removable any time)" value={demo} onChange={setDemo} icon="flask" />
            </Card>
            {error ? (
              <Txt v="small" color={c.danger} style={{ marginTop: 10 }}>
                {error}
              </Txt>
            ) : null}
          </>
        );
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <LinearGradient colors={c.bgGradient} style={StyleSheet.absoluteFill} />
      <View style={{ paddingTop: insets.top + 12, paddingHorizontal: 20 }}>
        <ProgressBar value={(step + 1) / STEPS.length} height={4} />
      </View>
      <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 40, flexGrow: 1, justifyContent: name === 'welcome' || name === 'finish' ? 'center' : 'flex-start' }} keyboardShouldPersistTaps="handled">
        {content()}
      </ScrollView>
      <View style={{ paddingHorizontal: 20, paddingBottom: Math.max(insets.bottom, 16), paddingTop: 8 }}>
        <Row gap={10}>
          {step > 0 ? <Button title="Back" variant="ghost" onPress={back} style={{ flex: 0.6 }} /> : null}
          {skippable && name !== 'lock' ? <Button title="Skip" variant="ghost" onPress={next} style={{ flex: 0.6 }} /> : null}
          {name === 'lock' && !pinDone ? <Button title="Skip" variant="ghost" onPress={next} style={{ flex: 0.6 }} /> : null}
          {name === 'finish' ? (
            <Button title="Start using Finora" icon="arrow-forward" onPress={finish} loading={finishing} style={{ flex: 1.4 }} />
          ) : name === 'lock' && !pinDone ? null : (
            <Button
              title={name === 'welcome' ? 'Get started' : name === 'debts' && draft.lender && draft.amount ? 'Add & continue' : 'Continue'}
              icon="arrow-forward"
              onPress={() => {
                if (name === 'debts' && draft.lender.trim() && draft.amount) addDebt();
                next();
              }}
              style={{ flex: 1.4 }}
            />
          )}
        </Row>
      </View>
      <OptionSheet
        visible={currencyOpen}
        title="Currency"
        value={currency}
        searchable
        options={CURRENCIES.map((x) => ({ value: x.code, label: x.name, subtitle: `${x.code} · ${x.symbol}` }))}
        onPick={(v) => (setCurrency(v), setCurrencyOpen(false))}
        onClose={() => setCurrencyOpen(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  logo: { width: 84, height: 84, borderRadius: 28, alignItems: 'center', justifyContent: 'center', alignSelf: 'center', marginBottom: 18 },
  bullet: { width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
});
