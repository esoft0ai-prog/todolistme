import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useTheme } from '../theme';
import { Icon, Txt } from './primitives';

/** Numeric PIN pad with large touch targets and screen-reader labels. */
export function PinPad({ value, onChange, length = 6, onBiometric, disabled }: { value: string; onChange: (v: string) => void; length?: number; onBiometric?: () => void; disabled?: boolean }) {
  const { c } = useTheme();
  const press = (d: string) => {
    if (disabled) return;
    if (d === 'del') onChange(value.slice(0, -1));
    else if (value.length < length) onChange(value + d);
  };
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'bio', '0', 'del'];
  return (
    <View style={{ alignItems: 'center' }}>
      <View accessible accessibilityLabel={`${value.length} digits entered`} style={{ flexDirection: 'row', gap: 14, marginBottom: 28 }}>
        {Array.from({ length: Math.max(4, Math.min(length, Math.max(value.length, 4))) }).map((_, i) => (
          <View key={i} style={[styles.dot, { borderColor: c.primary, backgroundColor: i < value.length ? c.primary : 'transparent' }]} />
        ))}
      </View>
      <View style={styles.grid}>
        {keys.map((k) => {
          if (k === 'bio' && !onBiometric) return <View key={k} style={styles.key} />;
          return (
            <Pressable
              key={k}
              onPress={() => (k === 'bio' ? onBiometric?.() : press(k))}
              accessibilityRole="button"
              accessibilityLabel={k === 'del' ? 'Delete' : k === 'bio' ? 'Use fingerprint or face unlock' : k}
              disabled={disabled}
              style={({ pressed }) => [styles.key, { backgroundColor: pressed ? c.primarySoft : k === 'bio' || k === 'del' ? 'transparent' : c.glass, borderColor: c.glassBorder, borderWidth: k === 'bio' || k === 'del' ? 0 : 1 }]}
            >
              {k === 'del' ? <Icon name="backspace-outline" size={26} color={c.text} /> : k === 'bio' ? <Icon name="finger-print" size={30} color={c.primary} /> : <Txt v="h1">{k}</Txt>}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  dot: { width: 16, height: 16, borderRadius: 8, borderWidth: 2 },
  grid: { width: 300, flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: 16 },
  key: { width: 84, height: 72, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
});
