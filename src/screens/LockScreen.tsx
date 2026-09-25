import { LinearGradient } from 'expo-linear-gradient';
import React, { useCallback, useEffect, useState } from 'react';
import { BackHandler, Pressable, StyleSheet, View } from 'react-native';
import { biometricGateway, securityService } from '../platform/security';
import { useAppStore, usePrefs } from '../state/appStore';
import { PinPad } from '../ui/components/PinPad';
import { Icon, Txt } from '../ui/components/primitives';
import { useTheme } from '../ui/theme';

/**
 * Full-screen lock. Rendered above the navigator (which is hidden from
 * accessibility services while locked), so no screen content is reachable
 * until the PIN or biometric check succeeds.
 */
export function LockScreen() {
  const { c } = useTheme();
  const prefs = usePrefs();
  const setLocked = useAppStore((s) => s.setLocked);
  const [pin, setPin] = useState('');
  const [message, setMessage] = useState<string>();
  const [lockedMs, setLockedMs] = useState(0);
  const [checking, setChecking] = useState(false);
  const [bioAvailable, setBioAvailable] = useState(false);
  const [pinLength, setPinLength] = useState<number | null>(null);

  const tryBiometric = useCallback(async () => {
    if (!prefs.biometricEnabled) return;
    if ((await securityService.lockoutRemainingMs()) > 0) return;
    const r = await biometricGateway.authenticate('Unlock Finora');
    if (r.success) setLocked(false);
  }, [prefs.biometricEnabled, setLocked]);

  useEffect(() => {
    void biometricGateway.isAvailable().then((a) => {
      setBioAvailable(a);
      if (a && prefs.biometricEnabled) void tryBiometric();
    });
    void securityService.lockoutRemainingMs().then(setLockedMs);
    void securityService.pinLength().then(setPinLength);
    // Android back button minimises the app instead of revealing content.
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      BackHandler.exitApp();
      return true;
    });
    return () => sub.remove();
  }, [prefs.biometricEnabled, tryBiometric]);

  useEffect(() => {
    if (lockedMs <= 0) return;
    const t = setInterval(() => setLockedMs((ms) => Math.max(0, ms - 1000)), 1000);
    return () => clearInterval(t);
  }, [lockedMs > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async (v: string) => {
    if (checking || v.length < 4) return;
    setChecking(true);
    const r = await securityService.verifyPin(v);
    setChecking(false);
    if (r.ok) {
      setLocked(false);
      return;
    }
    setPin('');
    if (r.lockedMs) {
      setLockedMs(r.lockedMs);
      setMessage('Too many wrong attempts');
    } else {
      setMessage(`Incorrect PIN${r.attemptsLeft != null ? ` — ${r.attemptsLeft} attempt${r.attemptsLeft === 1 ? '' : 's'} left` : ''}`);
    }
  };

  const onChange = (v: string) => {
    setPin(v);
    setMessage(undefined);
    // Submit automatically once the PIN is complete (length known from the stored record).
    if (v.length === (pinLength ?? 6)) void submit(v);
  };

  const locked = lockedMs > 0;
  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: c.bg, zIndex: 100 }]} accessibilityViewIsModal>
      <LinearGradient colors={c.bgGradient} style={StyleSheet.absoluteFill} />
      <View style={styles.center}>
        <LinearGradient colors={c.heroGradient} style={styles.logo}>
          <Icon name="lock-closed" size={30} color="#fff" />
        </LinearGradient>
        <Txt v="h2" center>
          Finora is locked
        </Txt>
        <Txt v="small" dim center style={{ marginBottom: 28, marginTop: 4 }} accessibilityLiveRegion="polite">
          {locked ? `Try again in ${Math.ceil(lockedMs / 1000)} seconds` : message ?? 'Enter your PIN to continue'}
        </Txt>
        <PinPad value={pin} onChange={onChange} disabled={locked || checking} onBiometric={bioAvailable && prefs.biometricEnabled ? tryBiometric : undefined} />
        {pinLength == null && pin.length >= 4 && pin.length < 6 ? (
          <Pressable onPress={() => submit(pin)} accessibilityRole="button" style={{ marginTop: 16, padding: 10 }}>
            <Txt v="bodyStrong" color={c.primary}>
              Unlock
            </Txt>
          </Pressable>
        ) : null}
        {message && !locked ? (
          <Txt v="caption" color={c.danger} center style={{ marginTop: 16 }}>
            {message}
          </Txt>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  logo: { width: 68, height: 68, borderRadius: 22, alignItems: 'center', justifyContent: 'center', marginBottom: 16 },
});
