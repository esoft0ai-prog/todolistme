import { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import React, { useEffect, useMemo, useState } from 'react';
import { FlatList, Modal, Platform, Pressable, StyleSheet, Switch, TextInput, View, type KeyboardTypeOptions, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getCurrency } from '../../domain/currency';
import { formatDate, isValidISODate, isValidTime, parts, toISODate } from '../../domain/dates';
import { minorToInput, parseAmount } from '../../domain/money';
import { radius, spacing, useTheme } from '../theme';
import { Icon, Row, Txt, type IconName } from './primitives';

// ---------------------------------------------------------------- Field shell
export function FieldShell({ label, error, hint, children, style }: { label?: string; error?: string; hint?: string; children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  const { c } = useTheme();
  return (
    <View style={[{ marginBottom: spacing.md }, style]}>
      {label ? (
        <Txt v="caption" dim style={{ marginBottom: 6, fontWeight: '700' }}>
          {label}
        </Txt>
      ) : null}
      {children}
      {error ? (
        <Row gap={4} style={{ marginTop: 4 }}>
          <Icon name="alert-circle" size={14} color={c.danger} />
          <Txt v="caption" color={c.danger} accessibilityLiveRegion="polite" style={{ flex: 1 }}>
            {error}
          </Txt>
        </Row>
      ) : hint ? (
        <Txt v="caption" faint style={{ marginTop: 4 }}>
          {hint}
        </Txt>
      ) : null}
    </View>
  );
}

export function TextField({
  label,
  value,
  onChangeText,
  placeholder,
  error,
  hint,
  multiline,
  keyboardType,
  maxLength = 200,
  autoFocus,
  secure,
  icon,
  style,
  onSubmitEditing,
}: {
  label?: string;
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  error?: string;
  hint?: string;
  multiline?: boolean;
  keyboardType?: KeyboardTypeOptions;
  maxLength?: number;
  autoFocus?: boolean;
  secure?: boolean;
  icon?: IconName;
  style?: StyleProp<ViewStyle>;
  onSubmitEditing?: () => void;
}) {
  const { c, t } = useTheme();
  const [focused, setFocused] = useState(false);
  return (
    <FieldShell label={label} error={error} hint={hint} style={style}>
      <View style={[styles.input, { backgroundColor: c.inputBg, borderColor: error ? c.danger : focused ? c.primary : c.border }, multiline && { minHeight: 90, alignItems: 'flex-start' }]}>
        {icon ? <Icon name={icon} size={18} color={c.textFaint} style={{ marginTop: multiline ? 12 : 0 }} /> : null}
        <TextInput
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={c.textFaint}
          style={[t.body, { color: c.text, flex: 1, minWidth: 0, paddingVertical: multiline ? 10 : 0, textAlignVertical: multiline ? 'top' : 'center', minHeight: multiline ? 80 : 48 }]}
          multiline={multiline}
          keyboardType={keyboardType}
          maxLength={maxLength}
          autoFocus={autoFocus}
          secureTextEntry={secure}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          accessibilityLabel={label ?? placeholder}
          onSubmitEditing={onSubmitEditing}
          maxFontSizeMultiplier={1.5}
        />
      </View>
    </FieldShell>
  );
}

/**
 * Money input. Keeps the raw text while typing and reports parsed minor units
 * (or null when invalid) through `onChangeMinor`.
 */
export function AmountField({
  label,
  currency,
  valueMinor,
  onChangeMinor,
  error,
  hint,
  allowZero,
  big,
  autoFocus,
}: {
  label?: string;
  currency: string;
  valueMinor: number | null;
  onChangeMinor: (minor: number | null) => void;
  error?: string;
  hint?: string;
  allowZero?: boolean;
  big?: boolean;
  autoFocus?: boolean;
}) {
  const { c, t } = useTheme();
  const [text, setText] = useState(valueMinor != null && (valueMinor !== 0 || allowZero) ? minorToInput(valueMinor, currency) : '');
  const [localError, setLocalError] = useState<string | undefined>();
  const symbol = getCurrency(currency).symbol;

  useEffect(() => {
    // Sync when the value is changed externally (e.g. prefilled after load).
    const parsed = parseAmount(text, currency, { allowZero });
    const current = parsed.ok ? parsed.minor : null;
    if (valueMinor !== current && valueMinor != null) setText(minorToInput(valueMinor, currency));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valueMinor, currency]);

  const onChange = (raw: string) => {
    const cleaned = raw.replace(/[^0-9.,kKmMbBnN]/g, '');
    setText(cleaned);
    if (!cleaned) {
      setLocalError(undefined);
      onChangeMinor(null);
      return;
    }
    const r = parseAmount(cleaned, currency, { allowZero });
    if (r.ok) {
      setLocalError(undefined);
      onChangeMinor(r.minor);
    } else {
      setLocalError(r.error);
      onChangeMinor(null);
    }
  };

  return (
    <FieldShell label={label} error={error ?? localError} hint={hint ?? (big ? 'Tip: type 25k for 25,000 or 1.5m for 1,500,000' : undefined)}>
      <View style={[styles.input, { backgroundColor: c.inputBg, borderColor: (error ?? localError) ? c.danger : c.border }, big && { minHeight: 72 }]}>
        <Txt v={big ? 'h1' : 'h3'} dim>
          {symbol}
        </Txt>
        <TextInput
          value={text}
          onChangeText={onChange}
          placeholder="0"
          placeholderTextColor={c.textFaint}
          keyboardType="decimal-pad"
          style={[big ? t.display : t.number, { color: c.text, flex: 1, minWidth: 0, minHeight: 48, padding: 0 }]}
          accessibilityLabel={`${label ?? 'Amount'} in ${currency}`}
          autoFocus={autoFocus}
          maxLength={20}
          maxFontSizeMultiplier={1.3}
        />
        <Txt v="caption" faint>
          {currency}
        </Txt>
      </View>
    </FieldShell>
  );
}

function openAndroidPicker(mode: 'date' | 'time', value: Date, onPick: (d: Date) => void, minimumDate?: Date, maximumDate?: Date) {
  DateTimePickerAndroid.open({
    value,
    mode,
    is24Hour: true,
    minimumDate,
    maximumDate,
    onChange: (event, date) => {
      if (event.type === 'set' && date) onPick(date);
    },
  });
}

export function DateField({ label, value, onChange, error, hint, optional, minimumDate, maximumDate }: { label: string; value: string | null; onChange: (v: string | null) => void; error?: string; hint?: string; optional?: boolean; minimumDate?: string; maximumDate?: string }) {
  const { c } = useTheme();
  const [webText, setWebText] = useState(value ?? '');
  useEffect(() => setWebText(value ?? ''), [value]);
  const toDate = (s: string) => {
    const p = parts(s);
    return new Date(p.y, p.m - 1, p.d);
  };
  if (Platform.OS === 'web') {
    return (
      <TextField
        label={label}
        value={webText}
        onChangeText={(v) => {
          setWebText(v);
          if (!v && optional) onChange(null);
          else if (isValidISODate(v)) onChange(v);
        }}
        placeholder="YYYY-MM-DD"
        error={error ?? (webText && !isValidISODate(webText) ? 'Use the format YYYY-MM-DD' : undefined)}
        hint={hint}
      />
    );
  }
  return (
    <FieldShell label={label} error={error} hint={hint}>
      <Row gap={8}>
        <Pressable
          onPress={() => openAndroidPicker('date', value && isValidISODate(value) ? toDate(value) : new Date(), (d) => onChange(toISODate(d)), minimumDate ? toDate(minimumDate) : undefined, maximumDate ? toDate(maximumDate) : undefined)}
          accessibilityRole="button"
          accessibilityLabel={`${label}: ${value ? formatDate(value, 'long') : 'not set'}. Double tap to change`}
          style={[styles.input, { flex: 1, backgroundColor: c.inputBg, borderColor: error ? c.danger : c.border }]}
        >
          <Icon name="calendar-outline" size={18} color={c.textFaint} />
          <Txt v="body" dim={!value} style={{ flex: 1 }}>
            {value ? formatDate(value, 'long') : 'Select a date'}
          </Txt>
        </Pressable>
        {optional && value ? (
          <Pressable onPress={() => onChange(null)} accessibilityRole="button" accessibilityLabel={`Clear ${label}`} style={[styles.clearBtn, { borderColor: c.border }]}>
            <Icon name="close" size={18} color={c.textDim} />
          </Pressable>
        ) : null}
      </Row>
    </FieldShell>
  );
}

export function TimeField({ label, value, onChange, optional }: { label: string; value: string | null; onChange: (v: string | null) => void; optional?: boolean }) {
  const { c } = useTheme();
  if (Platform.OS === 'web') {
    return <TextField label={label} value={value ?? ''} onChangeText={(v) => onChange(isValidTime(v) ? v : optional && !v ? null : value)} placeholder="HH:MM" />;
  }
  const base = new Date();
  if (value && isValidTime(value)) base.setHours(Number(value.slice(0, 2)), Number(value.slice(3, 5)));
  return (
    <FieldShell label={label}>
      <Row gap={8}>
        <Pressable
          onPress={() => openAndroidPicker('time', base, (d) => onChange(`${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`))}
          accessibilityRole="button"
          accessibilityLabel={`${label}: ${value ?? 'not set'}`}
          style={[styles.input, { flex: 1, backgroundColor: c.inputBg, borderColor: c.border }]}
        >
          <Icon name="time-outline" size={18} color={c.textFaint} />
          <Txt v="body" dim={!value}>
            {value ?? 'Select a time'}
          </Txt>
        </Pressable>
        {optional && value ? (
          <Pressable onPress={() => onChange(null)} accessibilityRole="button" accessibilityLabel={`Clear ${label}`} style={[styles.clearBtn, { borderColor: c.border }]}>
            <Icon name="close" size={18} color={c.textDim} />
          </Pressable>
        ) : null}
      </Row>
    </FieldShell>
  );
}

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  subtitle?: string;
  icon?: IconName | string;
  color?: string;
}

export function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
  placeholder = 'Select',
  error,
  hint,
  searchable,
  allowClear,
}: {
  label: string;
  value: T | null;
  options: SelectOption<T>[];
  onChange: (v: T | null) => void;
  placeholder?: string;
  error?: string;
  hint?: string;
  searchable?: boolean;
  allowClear?: boolean;
}) {
  const { c } = useTheme();
  const [open, setOpen] = useState(false);
  const selected = options.find((o) => o.value === value);
  return (
    <FieldShell label={label} error={error} hint={hint}>
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${selected?.label ?? 'not selected'}. Double tap to choose`}
        style={[styles.input, { backgroundColor: c.inputBg, borderColor: error ? c.danger : c.border }]}
      >
        {selected?.icon ? <Icon name={selected.icon} size={18} color={selected.color ?? c.primary} /> : null}
        <Txt v="body" dim={!selected} style={{ flex: 1 }} numberOfLines={1}>
          {selected?.label ?? placeholder}
        </Txt>
        <Icon name="chevron-down" size={18} color={c.textFaint} />
      </Pressable>
      <OptionSheet
        visible={open}
        title={label}
        options={options}
        value={value}
        searchable={searchable ?? options.length > 8}
        onClose={() => setOpen(false)}
        onPick={(v) => {
          onChange(v);
          setOpen(false);
        }}
        onClear={allowClear ? () => (onChange(null), setOpen(false)) : undefined}
      />
    </FieldShell>
  );
}

export function OptionSheet<T extends string>({
  visible,
  title,
  options,
  value,
  onPick,
  onClose,
  searchable,
  onClear,
}: {
  visible: boolean;
  title: string;
  options: SelectOption<T>[];
  value: T | null;
  onPick: (v: T) => void;
  onClose: () => void;
  searchable?: boolean;
  onClear?: () => void;
}) {
  const { c } = useTheme();
  const [q, setQ] = useState('');
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? options.filter((o) => o.label.toLowerCase().includes(s) || o.subtitle?.toLowerCase().includes(s)) : options;
  }, [q, options]);
  return (
    <Sheet visible={visible} onClose={onClose} title={title}>
      {searchable ? <TextField value={q} onChangeText={setQ} placeholder="Search" icon="search" /> : null}
      <FlatList
        data={filtered}
        keyExtractor={(o) => o.value}
        style={{ maxHeight: 420 }}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          onClear ? (
            <Pressable onPress={onClear} style={styles.option} accessibilityRole="button" accessibilityLabel="None">
              <Txt v="body" dim>
                None
              </Txt>
            </Pressable>
          ) : null
        }
        renderItem={({ item }) => {
          const active = item.value === value;
          return (
            <Pressable
              onPress={() => onPick(item.value)}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              accessibilityLabel={item.label}
              style={[styles.option, active && { backgroundColor: c.primarySoft }]}
            >
              {item.icon ? (
                <View style={[styles.optionIcon, { backgroundColor: (item.color ?? c.primary) + '22' }]}>
                  <Icon name={item.icon} size={18} color={item.color ?? c.primary} />
                </View>
              ) : null}
              <View style={{ flex: 1 }}>
                <Txt v="bodyStrong">{item.label}</Txt>
                {item.subtitle ? (
                  <Txt v="caption" dim>
                    {item.subtitle}
                  </Txt>
                ) : null}
              </View>
              {active ? <Icon name="checkmark-circle" size={20} color={c.primary} /> : null}
            </Pressable>
          );
        }}
        ListEmptyComponent={
          <Txt v="small" dim center style={{ padding: 20 }}>
            Nothing found
          </Txt>
        }
      />
    </Sheet>
  );
}

export function Sheet({ visible, onClose, title, children }: { visible: boolean; onClose: () => void; title?: string; children: React.ReactNode }) {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: c.overlay }]} onPress={onClose} accessibilityLabel="Close" accessibilityRole="button" />
      <View style={[styles.sheet, { backgroundColor: c.surface, borderColor: c.glassBorder, paddingBottom: Math.max(insets.bottom, 16) + 8 }]}>
        <View style={[styles.grabber, { backgroundColor: c.border }]} />
        {title ? (
          <Row justify="space-between" style={{ marginBottom: 12 }}>
            <Txt v="h3" accessibilityRole="header">
              {title}
            </Txt>
            <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close">
              <Icon name="close" size={22} color={c.textDim} />
            </Pressable>
          </Row>
        ) : null}
        {children}
      </View>
    </Modal>
  );
}

export function SwitchRow({ label, description, value, onChange, disabled, icon }: { label: string; description?: string; value: boolean; onChange: (v: boolean) => void; disabled?: boolean; icon?: IconName }) {
  const { c } = useTheme();
  return (
    <Pressable
      onPress={() => !disabled && onChange(!value)}
      accessibilityRole="switch"
      accessibilityState={{ checked: value, disabled }}
      accessibilityLabel={label}
      accessibilityHint={description}
      style={[styles.switchRow, disabled && { opacity: 0.5 }]}
    >
      {icon ? (
        <View style={[styles.optionIcon, { backgroundColor: c.primarySoft }]}>
          <Icon name={icon} size={18} color={c.primary} />
        </View>
      ) : null}
      <View style={{ flex: 1 }}>
        <Txt v="bodyStrong">{label}</Txt>
        {description ? (
          <Txt v="caption" dim>
            {description}
          </Txt>
        ) : null}
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        disabled={disabled}
        trackColor={{ false: c.surfaceAlt, true: c.primary }}
        thumbColor={Platform.OS === 'android' ? (value ? '#fff' : c.textDim) : undefined}
        importantForAccessibility="no-hide-descendants"
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  input: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderRadius: radius.md, paddingHorizontal: 14, minHeight: 52 },
  clearBtn: { width: 52, height: 52, borderRadius: radius.md, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  sheet: { position: 'absolute', left: 0, right: 0, bottom: 0, borderTopLeftRadius: 26, borderTopRightRadius: 26, padding: spacing.lg, borderWidth: 1, maxHeight: '88%' },
  grabber: { width: 42, height: 5, borderRadius: 3, alignSelf: 'center', marginBottom: 12 },
  option: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 8, borderRadius: 12, minHeight: 52 },
  optionIcon: { width: 36, height: 36, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, minHeight: 56 },
});
