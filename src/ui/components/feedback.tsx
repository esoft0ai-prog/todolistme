import React, { useEffect, useRef } from 'react';
import { Animated, Modal, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { create } from 'zustand';
import { useAppStore } from '../../state/appStore';
import { radius, spacing, useTheme } from '../theme';
import { Button, Icon, Txt, type IconName } from './primitives';

interface DialogButton {
  text: string;
  value: string;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
}

interface DialogRequest {
  title: string;
  message?: string;
  icon?: IconName;
  tone?: 'danger' | 'warning' | 'info';
  buttons: DialogButton[];
  resolve: (v: string | null) => void;
}

const useDialogStore = create<{ current: DialogRequest | null; queue: DialogRequest[] }>(() => ({ current: null, queue: [] }));

function enqueue(req: Omit<DialogRequest, 'resolve'>): Promise<string | null> {
  return new Promise((resolve) => {
    const item = { ...req, resolve };
    const s = useDialogStore.getState();
    if (!s.current) useDialogStore.setState({ current: item });
    else useDialogStore.setState({ queue: [...s.queue, item] });
  });
}

function close(value: string | null) {
  const s = useDialogStore.getState();
  s.current?.resolve(value);
  const [next, ...rest] = s.queue;
  useDialogStore.setState({ current: next ?? null, queue: rest });
}

/** Themed confirmation dialog. Resolves true when confirmed. */
export async function confirmDialog(opts: { title: string; message?: string; confirmText?: string; cancelText?: string; destructive?: boolean; icon?: IconName }): Promise<boolean> {
  const v = await enqueue({
    title: opts.title,
    message: opts.message,
    icon: opts.icon ?? (opts.destructive ? 'warning' : 'help-circle'),
    tone: opts.destructive ? 'danger' : 'info',
    buttons: [
      { text: opts.cancelText ?? 'Cancel', value: 'cancel', variant: 'ghost' },
      { text: opts.confirmText ?? 'Confirm', value: 'ok', variant: opts.destructive ? 'danger' : 'primary' },
    ],
  });
  return v === 'ok';
}

export async function alertDialog(title: string, message?: string, tone: 'danger' | 'warning' | 'info' = 'info'): Promise<void> {
  await enqueue({ title, message, tone, icon: tone === 'danger' ? 'alert-circle' : tone === 'warning' ? 'warning' : 'information-circle', buttons: [{ text: 'OK', value: 'ok', variant: 'primary' }] });
}

export async function chooseDialog(title: string, message: string | undefined, buttons: DialogButton[]): Promise<string | null> {
  return enqueue({ title, message, buttons, icon: 'options', tone: 'info' });
}

export function DialogHost() {
  const current = useDialogStore((s) => s.current);
  const { c } = useTheme();
  if (!current) return null;
  const toneColor = current.tone === 'danger' ? c.danger : current.tone === 'warning' ? c.warning : c.primary;
  const stacked = current.buttons.length > 2;
  return (
    <Modal visible transparent animationType="fade" onRequestClose={() => close(null)} statusBarTranslucent>
      <View style={[styles.backdrop, { backgroundColor: c.overlay }]}>
        <View style={[styles.dialog, { backgroundColor: c.surface, borderColor: c.glassBorder }]} accessibilityViewIsModal accessibilityRole="alert">
          {current.icon ? (
            <View style={[styles.dialogIcon, { backgroundColor: toneColor + '22' }]}>
              <Icon name={current.icon} size={26} color={toneColor} />
            </View>
          ) : null}
          <Txt v="h3" center accessibilityRole="header">
            {current.title}
          </Txt>
          {current.message ? (
            <Txt v="small" dim center style={{ marginTop: 8 }}>
              {current.message}
            </Txt>
          ) : null}
          <View style={{ flexDirection: stacked ? 'column' : 'row', gap: 10, marginTop: 20, alignSelf: 'stretch' }}>
            {current.buttons.map((b) => (
              <Button key={b.value} title={b.text} variant={b.variant ?? 'secondary'} onPress={() => close(b.value)} style={stacked ? undefined : { flex: 1 }} />
            ))}
          </View>
        </View>
      </View>
    </Modal>
  );
}

export function ToastHost() {
  const toast = useAppStore((s) => s.toast);
  const clear = useAppStore((s) => s.clearToast);
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!toast) return;
    anim.setValue(0);
    Animated.spring(anim, { toValue: 1, useNativeDriver: true, friction: 8 }).start();
    const t = setTimeout(() => {
      Animated.timing(anim, { toValue: 0, duration: 180, useNativeDriver: true }).start(() => clear());
    }, toast.tone === 'bad' ? 4200 : 2600);
    return () => clearTimeout(t);
  }, [toast, anim, clear]);
  if (!toast) return null;
  const col = toast.tone === 'bad' ? c.danger : toast.tone === 'info' ? c.info : c.success;
  return (
    <Animated.View
      pointerEvents="box-none"
      style={[styles.toastWrap, { bottom: insets.bottom + 90, opacity: anim, transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [20, 0] }) }] }]}
    >
      <Pressable onPress={clear} style={[styles.toast, { backgroundColor: c.surfaceAlt, borderColor: col + '66' }]} accessibilityLiveRegion="polite" accessibilityRole="alert">
        <Icon name={toast.tone === 'bad' ? 'alert-circle' : toast.tone === 'info' ? 'information-circle' : 'checkmark-circle'} size={20} color={col} />
        <Txt v="small" style={{ flex: 1 }}>
          {toast.message}
        </Txt>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  dialog: { width: '100%', maxWidth: 420, borderRadius: radius.xl, padding: spacing.xl, alignItems: 'center', borderWidth: 1 },
  dialogIcon: { width: 56, height: 56, borderRadius: 18, alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  toastWrap: { position: 'absolute', left: 16, right: 16 },
  toast: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 14, borderRadius: radius.md, borderWidth: 1, elevation: 8, shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 12, shadowOffset: { width: 0, height: 6 } },
});
