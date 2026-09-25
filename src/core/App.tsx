import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import React, { useEffect, useMemo, useRef } from 'react';
import { AppState, StyleSheet, useColorScheme, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { navigationRef, RootNavigator } from '../navigation/RootNavigator';
import { onNotificationTap } from '../platform/notifications';
import { securityService } from '../platform/security';
import { LockScreen } from '../screens/LockScreen';
import { OnboardingScreen } from '../screens/OnboardingScreen';
import { shouldLockOnResume } from '../services/security';
import { useAppStore } from '../state/appStore';
import { DialogHost, ToastHost } from '../ui/components/feedback';
import { Button, Icon, Spacer, Txt } from '../ui/components/primitives';
import { makeTheme, ThemeContext, useTheme } from '../ui/theme';
import { bootstrap, onResume, resetAllData } from './bootstrap';
import { confirmDialog } from '../ui/components/feedback';

void SplashScreen.preventAutoHideAsync().catch(() => undefined);

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) return <Fatal message={this.state.error.message} onRetry={() => this.setState({ error: null })} />;
    return this.props.children;
  }
}

function Fatal({ message, onRetry, canReset }: { message: string; onRetry?: () => void; canReset?: boolean }) {
  const { c } = useTheme();
  return (
    <View style={[styles.center, { backgroundColor: c.bg }]}>
      <Icon name="alert-circle" size={48} color={c.danger} />
      <Spacer h={12} />
      <Txt v="h2" center>
        Something went wrong
      </Txt>
      <Txt v="small" dim center style={{ marginTop: 8, marginBottom: 20 }}>
        {message}
      </Txt>
      {onRetry ? <Button title="Try again" onPress={onRetry} /> : null}
      {canReset ? (
        <>
          <Spacer h={10} />
          <Button
            title="Reset app data"
            variant="danger"
            onPress={async () => {
              if (await confirmDialog({ title: 'Reset Finora?', message: 'This deletes the local database on this phone. You can restore a backup afterwards.', confirmText: 'Reset', destructive: true })) await resetAllData();
            }}
          />
        </>
      ) : null}
    </View>
  );
}

function Shell() {
  const status = useAppStore((s) => s.status);
  const error = useAppStore((s) => s.error);
  const errorKind = useAppStore((s) => s.errorKind);
  const prefs = useAppStore((s) => s.prefs);
  const locked = useAppStore((s) => s.locked);
  const { c } = useTheme();
  const backgroundedAt = useRef<number | null>(null);

  useEffect(() => {
    void bootstrap();
  }, []);

  useEffect(() => {
    if (status !== 'booting') void SplashScreen.hideAsync().catch(() => undefined);
  }, [status]);

  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(c.bg).catch(() => undefined);
  }, [c.bg]);

  // Auto-lock + catch-up when returning to the foreground.
  useEffect(() => {
    const sub = AppState.addEventListener('change', async (next) => {
      const state = useAppStore.getState();
      if (next === 'background' || next === 'inactive') {
        if (backgroundedAt.current == null) backgroundedAt.current = Date.now();
        if (state.prefs.appLockEnabled && state.prefs.autoLockSeconds === 0 && (await securityService.hasPin())) state.setLocked(true);
        return;
      }
      if (next === 'active') {
        const lock = shouldLockOnResume({ enabled: state.prefs.appLockEnabled, backgroundedAt: backgroundedAt.current, now: Date.now(), autoLockSeconds: state.prefs.autoLockSeconds });
        backgroundedAt.current = null;
        if (lock && (await securityService.hasPin())) state.setLocked(true);
        void onResume();
      }
    });
    return () => sub.remove();
  }, []);

  // Tapping a notification opens the related screen.
  useEffect(
    () =>
      onNotificationTap((data) => {
        let tries = 0;
        const go = () => {
          if (!navigationRef.isReady()) {
            if (tries++ < 20) setTimeout(go, 500); // wait for boot/unlock
            return;
          }
          const type = String(data.entityType ?? '');
          const id = String(data.entityId ?? '');
          if (type === 'debt' && id) navigationRef.navigate('DebtDetail', { id });
          else if (type === 'goal' && id) navigationRef.navigate('GoalDetail', { id });
          else if (type === 'budget' && id) navigationRef.navigate('BudgetDetail', { id });
          else if (type === 'recurring' || type === 'event' || type === 'reminder') navigationRef.navigate('Calendar');
          else navigationRef.navigate('Notifications');
        };
        setTimeout(go, 400);
      }),
    [],
  );

  if (status === 'booting') return <View style={{ flex: 1, backgroundColor: c.bg }} />;
  if (status === 'error') return <Fatal message={error ?? 'Unknown error'} onRetry={errorKind === 'generic' ? () => void bootstrap() : undefined} canReset={errorKind === 'decrypt' || errorKind === 'migration'} />;
  if (!prefs.onboardingComplete) return <OnboardingScreen />;
  return (
    <View style={{ flex: 1 }}>
      <View style={{ flex: 1 }} importantForAccessibility={locked ? 'no-hide-descendants' : 'auto'} accessibilityElementsHidden={locked}>
        <RootNavigator />
      </View>
      {locked ? <LockScreen /> : null}
    </View>
  );
}

export default function App() {
  const scheme = useColorScheme();
  const prefs = useAppStore((s) => s.prefs);
  const mode = prefs.themeMode === 'system' ? (scheme === 'light' ? 'light' : 'dark') : prefs.themeMode;
  const theme = useMemo(() => makeTheme(mode, prefs.largeText), [mode, prefs.largeText]);
  return (
    <SafeAreaProvider>
      <ThemeContext.Provider value={theme}>
        <StatusBar style={mode === 'dark' ? 'light' : 'dark'} />
        <ErrorBoundary>
          <Shell />
        </ErrorBoundary>
        <DialogHost />
        <ToastHost />
      </ThemeContext.Provider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28 },
});
