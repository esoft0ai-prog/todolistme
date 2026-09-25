import Ionicons from '@expo/vector-icons/Ionicons';
import { LinearGradient } from 'expo-linear-gradient';
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type PressableProps,
  type StyleProp,
  type TextProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { formatMoney } from '../../domain/money';
import { radius, spacing, useTheme, type TypeVariant } from '../theme';

export type IconName = React.ComponentProps<typeof Ionicons>['name'];

// ---------------------------------------------------------------- Text
export function Txt({
  v = 'body',
  color,
  dim,
  faint,
  center,
  style,
  children,
  ...rest
}: TextProps & { v?: TypeVariant; color?: string; dim?: boolean; faint?: boolean; center?: boolean }) {
  const { c, t } = useTheme();
  return (
    <Text
      {...rest}
      maxFontSizeMultiplier={1.6}
      style={[t[v], { color: color ?? (faint ? c.textFaint : dim ? c.textDim : c.text) }, center && { textAlign: 'center' }, style]}
    >
      {children}
    </Text>
  );
}

export function Icon({ name, size = 20, color, style }: { name: IconName | string; size?: number; color?: string; style?: StyleProp<TextStyle> }) {
  const { c } = useTheme();
  return <Ionicons name={name as IconName} size={size} color={color ?? c.text} style={style} accessibilityElementsHidden importantForAccessibility="no" />;
}

// ---------------------------------------------------------------- Layout
export function Screen({
  title,
  subtitle,
  onBack,
  right,
  children,
  scroll = true,
  refreshing,
  onRefresh,
  padded = true,
  footer,
  contentStyle,
}: {
  title?: string;
  subtitle?: string;
  onBack?: () => void;
  right?: React.ReactNode;
  children: React.ReactNode;
  scroll?: boolean;
  refreshing?: boolean;
  onRefresh?: () => void;
  padded?: boolean;
  footer?: React.ReactNode;
  contentStyle?: StyleProp<ViewStyle>;
}) {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const header =
    title || onBack || right ? (
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        {onBack ? (
          <IconButton icon="chevron-back" onPress={onBack} label="Go back" />
        ) : null}
        <View style={{ flex: 1, marginLeft: onBack ? 6 : 0 }}>
          {title ? (
            <Txt v={onBack ? 'h2' : 'h1'} numberOfLines={1} accessibilityRole="header">
              {title}
            </Txt>
          ) : null}
          {subtitle ? (
            <Txt v="small" dim numberOfLines={1}>
              {subtitle}
            </Txt>
          ) : null}
        </View>
        {right}
      </View>
    ) : (
      <View style={{ height: insets.top }} />
    );
  const body = scroll ? (
    <ScrollView
      contentContainerStyle={[padded && styles.padded, { paddingBottom: 120 }, contentStyle]}
      keyboardShouldPersistTaps="handled"
      refreshControl={onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} tintColor={c.primary} colors={[c.primary]} progressBackgroundColor={c.surface} /> : undefined}
    >
      {children}
    </ScrollView>
  ) : (
    <View style={[{ flex: 1 }, padded && styles.padded, contentStyle]}>{children}</View>
  );
  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <LinearGradient colors={c.bgGradient} style={StyleSheet.absoluteFill} />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {header}
        {body}
        {footer ? <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 12), borderTopColor: c.border, backgroundColor: c.bg }]}>{footer}</View> : null}
      </KeyboardAvoidingView>
    </View>
  );
}

export function Row({ children, gap = spacing.sm, style, align = 'center', justify }: { children: React.ReactNode; gap?: number; style?: StyleProp<ViewStyle>; align?: ViewStyle['alignItems']; justify?: ViewStyle['justifyContent'] }) {
  return <View style={[{ flexDirection: 'row', alignItems: align, gap, justifyContent: justify }, style]}>{children}</View>;
}

export function Spacer({ h = spacing.md }: { h?: number }) {
  return <View style={{ height: h }} />;
}

export function Card({
  children,
  style,
  onPress,
  accessibilityLabel,
  tone,
  padded = true,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  onPress?: () => void;
  accessibilityLabel?: string;
  tone?: 'primary' | 'danger' | 'warning' | 'success';
  padded?: boolean;
}) {
  const { c } = useTheme();
  const toneBorder = tone === 'danger' ? c.danger : tone === 'warning' ? c.warning : tone === 'success' ? c.success : tone === 'primary' ? c.primary : c.glassBorder;
  const base = [
    styles.card,
    padded && { padding: spacing.lg },
    { backgroundColor: c.mode === 'dark' ? c.glass : c.surface, borderColor: tone ? toneBorder + '66' : c.glassBorder },
    c.mode === 'light' && styles.lightShadow,
    style,
  ];
  if (!onPress) return <View style={base}>{children}</View>;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      android_ripple={{ color: c.primarySoft }}
      style={({ pressed }) => [...base, pressed && { opacity: 0.85, transform: [{ scale: 0.99 }] }]}
    >
      {children}
    </Pressable>
  );
}

export function GradientCard({ children, style, colors }: { children: React.ReactNode; style?: StyleProp<ViewStyle>; colors?: [string, string] }) {
  const { c } = useTheme();
  return (
    <LinearGradient colors={colors ?? c.heroGradient} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={[styles.card, { padding: spacing.xl, borderWidth: 0 }, style]}>
      {children}
    </LinearGradient>
  );
}

// ---------------------------------------------------------------- Buttons
export function Button({
  title,
  onPress,
  variant = 'primary',
  icon,
  loading,
  disabled,
  style,
  small,
  accessibilityHint,
}: {
  title: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'accent' | 'glass';
  icon?: IconName;
  loading?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  small?: boolean;
  accessibilityHint?: string;
}) {
  const { c, t } = useTheme();
  const bg =
    variant === 'primary'
      ? c.primary
      : variant === 'accent'
        ? c.accent
        : variant === 'danger'
          ? c.danger
          : variant === 'secondary'
            ? c.primarySoft
            : variant === 'glass'
              ? 'rgba(255,255,255,0.2)'
              : 'transparent';
  const fg = variant === 'primary' || variant === 'accent' ? c.onPrimary : variant === 'danger' || variant === 'glass' ? '#fff' : c.primary;
  const off = disabled || loading;
  return (
    <Pressable
      onPress={off ? undefined : onPress}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: !!off, busy: !!loading }}
      style={({ pressed }) => [
        styles.button,
        small && styles.buttonSmall,
        { backgroundColor: bg, opacity: off ? 0.5 : pressed ? 0.85 : 1 },
        variant === 'ghost' && { borderWidth: 1, borderColor: c.border },
        style,
      ]}
    >
      {loading ? <ActivityIndicator color={fg} /> : icon ? <Icon name={icon} size={small ? 16 : 18} color={fg} /> : null}
      <Text style={[small ? t.small : t.bodyStrong, { color: fg, fontWeight: '700' }]} maxFontSizeMultiplier={1.4} numberOfLines={1}>
        {title}
      </Text>
    </Pressable>
  );
}

export function IconButton({ icon, onPress, label, color, size = 22, badge, style }: { icon: IconName; onPress: () => void; label: string; color?: string; size?: number; badge?: number; style?: StyleProp<ViewStyle> }) {
  const { c } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={8}
      style={({ pressed }) => [styles.iconBtn, { backgroundColor: pressed ? c.primarySoft : c.glass, borderColor: c.glassBorder }, style]}
    >
      <Icon name={icon} size={size} color={color ?? c.text} />
      {badge ? (
        <View style={[styles.badge, { backgroundColor: c.danger }]}>
          <Text style={{ color: '#fff', fontSize: 10, fontWeight: '800' }}>{badge > 99 ? '99+' : badge}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

export function Fab({ onPress, icon = 'add', label }: { onPress: () => void; icon?: IconName; label: string }) {
  const { c } = useTheme();
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} style={({ pressed }) => [styles.fab, { opacity: pressed ? 0.9 : 1 }]}>
      <LinearGradient colors={[c.primary, c.accent]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.fabInner}>
        <Icon name={icon} size={28} color="#fff" />
      </LinearGradient>
    </Pressable>
  );
}

// ---------------------------------------------------------------- Chips & segmented
export function Chip({ label, active, onPress, icon, color }: { label: string; active?: boolean; onPress?: () => void; icon?: IconName | string; color?: string }) {
  const { c, t } = useTheme();
  const tint = color ?? c.primary;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: !!active }}
      accessibilityLabel={label}
      style={[styles.chip, { backgroundColor: active ? tint + '26' : c.glass, borderColor: active ? tint : c.glassBorder }]}
    >
      {icon ? <Icon name={icon} size={14} color={active ? tint : c.textDim} /> : null}
      <Text style={[t.small, { color: active ? tint : c.textDim, fontWeight: active ? '700' : '500' }]} maxFontSizeMultiplier={1.4}>
        {label}
      </Text>
    </Pressable>
  );
}

export function ChipScroller({ children }: { children: React.ReactNode }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingVertical: 2, paddingRight: 16 }}>
      {children}
    </ScrollView>
  );
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  const { c, t } = useTheme();
  return (
    <View style={[styles.segment, { backgroundColor: c.inputBg, borderColor: c.border }]} accessibilityRole="tablist">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <Pressable
            key={o.value}
            onPress={() => onChange(o.value)}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            style={[styles.segmentItem, active && { backgroundColor: c.primary }]}
          >
            <Text style={[t.small, { color: active ? c.onPrimary : c.textDim, fontWeight: '700' }]} numberOfLines={1} maxFontSizeMultiplier={1.3}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// ---------------------------------------------------------------- Rows
export function ListRow({
  title,
  subtitle,
  right,
  rightSub,
  icon,
  iconColor,
  onPress,
  rightColor,
  chevron,
  accessibilityLabel,
  badge,
}: {
  title: string;
  subtitle?: string;
  right?: string;
  rightSub?: string;
  icon?: IconName | string;
  iconColor?: string;
  onPress?: () => void;
  rightColor?: string;
  chevron?: boolean;
  accessibilityLabel?: string;
  badge?: string;
}) {
  const { c } = useTheme();
  const content = (
    <>
      {icon ? (
        <View style={[styles.rowIcon, { backgroundColor: (iconColor ?? c.primary) + '22' }]}>
          <Icon name={icon} size={19} color={iconColor ?? c.primary} />
        </View>
      ) : null}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Row gap={6}>
          <Txt v="bodyStrong" numberOfLines={1} style={{ flexShrink: 1 }}>
            {title}
          </Txt>
          {badge ? <Badge label={badge} /> : null}
        </Row>
        {subtitle ? (
          <Txt v="small" dim numberOfLines={1}>
            {subtitle}
          </Txt>
        ) : null}
      </View>
      {right ? (
        <View style={{ alignItems: 'flex-end', maxWidth: '45%' }}>
          <Txt v="bodyStrong" color={rightColor} numberOfLines={1} style={{ fontVariant: ['tabular-nums'] }}>
            {right}
          </Txt>
          {rightSub ? (
            <Txt v="caption" faint numberOfLines={1}>
              {rightSub}
            </Txt>
          ) : null}
        </View>
      ) : null}
      {chevron ? <Icon name="chevron-forward" size={18} color={c.textFaint} /> : null}
    </>
  );
  if (!onPress) return <View style={styles.listRow}>{content}</View>;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? [title, subtitle, right].filter(Boolean).join(', ')}
      android_ripple={{ color: c.primarySoft }}
      style={({ pressed }) => [styles.listRow, pressed && { opacity: 0.7 }]}
    >
      {content}
    </Pressable>
  );
}

export function Badge({ label, color }: { label: string; color?: string }) {
  const { c } = useTheme();
  const col = color ?? c.warning;
  return (
    <View style={{ paddingHorizontal: 6, paddingVertical: 1, borderRadius: 6, backgroundColor: col + '26' }}>
      <Text style={{ color: col, fontSize: 10, fontWeight: '800', letterSpacing: 0.4 }} maxFontSizeMultiplier={1.3}>
        {label.toUpperCase()}
      </Text>
    </View>
  );
}

export function SectionHeader({ title, action, onAction }: { title: string; action?: string; onAction?: () => void }) {
  const { c } = useTheme();
  return (
    <Row justify="space-between" style={{ marginTop: spacing.xl, marginBottom: spacing.sm }}>
      <Txt v="label" dim accessibilityRole="header">
        {title}
      </Txt>
      {action && onAction ? (
        <Pressable onPress={onAction} hitSlop={10} accessibilityRole="button" accessibilityLabel={action}>
          <Txt v="small" color={c.primary} style={{ fontWeight: '700' }}>
            {action}
          </Txt>
        </Pressable>
      ) : null}
    </Row>
  );
}

export function Divider() {
  const { c } = useTheme();
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: c.border, marginVertical: 4 }} />;
}

// ---------------------------------------------------------------- Progress
export function ProgressBar({ value, color, height = 8, track }: { value: number; color?: string; height?: number; track?: string }) {
  const { c } = useTheme();
  const v = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  return (
    <View
      style={{ height, borderRadius: height, backgroundColor: track ?? c.inputBg, overflow: 'hidden' }}
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(v * 100) }}
    >
      <View style={{ width: `${v * 100}%`, height, borderRadius: height, backgroundColor: color ?? c.primary }} />
    </View>
  );
}

// ---------------------------------------------------------------- Animated numbers
/** Counts up to a value in ~600 ms using a single JS-driven animation. */
export function useAnimatedNumber(target: number, duration = 650): number {
  const [value, setValue] = useState(target);
  const from = useRef(target);
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const start = from.current;
    if (start === target) return;
    anim.setValue(0);
    const id = anim.addListener(({ value: p }) => setValue(Math.round(start + (target - start) * p)));
    Animated.timing(anim, { toValue: 1, duration, easing: Easing.out(Easing.cubic), useNativeDriver: false }).start(() => {
      from.current = target;
      setValue(target);
    });
    return () => {
      anim.removeListener(id);
      anim.stopAnimation();
      from.current = target;
    };
  }, [target, duration, anim]);
  return value;
}

export function AnimatedMoney({ minor, currency, v = 'display', color, compact, signed }: { minor: number; currency: string; v?: TypeVariant; color?: string; compact?: boolean; signed?: boolean }) {
  const value = useAnimatedNumber(minor);
  return (
    <Txt v={v} color={color} numberOfLines={1} adjustsFontSizeToFit accessibilityLabel={formatMoney(minor, currency)}>
      {formatMoney(value, currency, { compact, signed })}
    </Txt>
  );
}

export function Money({ minor, currency, v = 'bodyStrong', color, compact, signed, tone }: { minor: number; currency: string; v?: TypeVariant; color?: string; compact?: boolean; signed?: boolean; tone?: boolean }) {
  const { c } = useTheme();
  const col = color ?? (tone ? (minor > 0 ? c.success : minor < 0 ? c.danger : c.text) : undefined);
  return (
    <Txt v={v} color={col} numberOfLines={1} style={{ fontVariant: ['tabular-nums'] }}>
      {formatMoney(minor, currency, { compact, signed })}
    </Txt>
  );
}

// ---------------------------------------------------------------- Loading & empty
export function Skeleton({ height = 16, width = '100%', style }: { height?: number; width?: number | `${number}%`; style?: StyleProp<ViewStyle> }) {
  const { c } = useTheme();
  const pulse = useRef(new Animated.Value(0.4)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.9, duration: 700, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.4, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);
  return <Animated.View style={[{ height, width, borderRadius: 8, backgroundColor: c.surfaceAlt, opacity: pulse }, style]} />;
}

export function LoadingBlock({ lines = 3 }: { lines?: number }) {
  return (
    <View style={{ gap: 12 }} accessibilityLabel="Loading" accessible>
      <Skeleton height={120} style={{ borderRadius: radius.lg }} />
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} height={56} style={{ borderRadius: radius.md }} />
      ))}
    </View>
  );
}

export function EmptyState({ icon, title, message, action, onAction }: { icon: IconName; title: string; message: string; action?: string; onAction?: () => void }) {
  const { c } = useTheme();
  return (
    <View style={styles.empty}>
      <View style={[styles.emptyIcon, { backgroundColor: c.primarySoft }]}>
        <Icon name={icon} size={30} color={c.primary} />
      </View>
      <Txt v="h3" center>
        {title}
      </Txt>
      <Txt v="small" dim center style={{ maxWidth: 300 }}>
        {message}
      </Txt>
      {action && onAction ? <Button title={action} onPress={onAction} small style={{ marginTop: 8 }} /> : null}
    </View>
  );
}

export function ErrorBlock({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return <EmptyState icon="alert-circle" title="Something went wrong" message={message} action={onRetry ? 'Try again' : undefined} onAction={onRetry} />;
}

export function StatPill({ label, value, color, icon }: { label: string; value: string; color?: string; icon?: IconName }) {
  const { c } = useTheme();
  return (
    <View style={[styles.statPill, { backgroundColor: c.inputBg, borderColor: c.border }]}>
      <Row gap={6}>
        {icon ? <Icon name={icon} size={14} color={color ?? c.textDim} /> : null}
        <Txt v="caption" dim numberOfLines={1}>
          {label}
        </Txt>
      </Row>
      <Txt v="bodyStrong" color={color} numberOfLines={1} adjustsFontSizeToFit style={{ fontVariant: ['tabular-nums'], marginTop: 2 }}>
        {value}
      </Txt>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.lg, paddingBottom: spacing.md, gap: 8 },
  padded: { paddingHorizontal: spacing.lg },
  footer: { paddingHorizontal: spacing.lg, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth },
  card: { borderRadius: radius.lg, borderWidth: 1, overflow: 'hidden' },
  lightShadow: { elevation: 2, shadowColor: '#1b2559', shadowOpacity: 0.06, shadowRadius: 12, shadowOffset: { width: 0, height: 4 } },
  button: { minHeight: 50, borderRadius: radius.md, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 18 },
  buttonSmall: { minHeight: 38, paddingHorizontal: 14, borderRadius: radius.sm },
  iconBtn: { width: 42, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  badge: { position: 'absolute', top: -4, right: -4, minWidth: 18, height: 18, borderRadius: 9, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
  fab: { position: 'absolute', right: 20, bottom: 24, borderRadius: 30, elevation: 6, shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 10, shadowOffset: { width: 0, height: 6 } },
  fabInner: { width: 60, height: 60, borderRadius: 30, alignItems: 'center', justifyContent: 'center' },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, minHeight: 36, borderRadius: radius.pill, borderWidth: 1 },
  segment: { flexDirection: 'row', borderRadius: radius.md, padding: 4, borderWidth: 1 },
  segmentItem: { flex: 1, minHeight: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 10, paddingHorizontal: 6 },
  listRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, minHeight: 56 },
  rowIcon: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  empty: { alignItems: 'center', justifyContent: 'center', paddingVertical: 36, gap: 8 },
  emptyIcon: { width: 64, height: 64, borderRadius: 22, alignItems: 'center', justifyContent: 'center', marginBottom: 6 },
  statPill: { flex: 1, borderRadius: radius.md, padding: 12, borderWidth: 1, minWidth: 0 },
});
