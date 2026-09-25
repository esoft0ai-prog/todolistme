import React, { useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import Svg, { Circle, Defs, G, Line, LinearGradient, Path, Rect, Stop, Text as SvgText } from 'react-native-svg';
import { formatMoney } from '../../domain/money';
import { useTheme } from '../theme';
import { Row, Txt } from './primitives';

/**
 * Hand-rolled SVG charts: tiny, dependency-free (only react-native-svg), fast
 * on low-end devices, and every chart has a text alternative for screen readers.
 */

function describeArc(cx: number, cy: number, r: number, start: number, end: number): string {
  const s = { x: cx + r * Math.cos(start), y: cy + r * Math.sin(start) };
  const e = { x: cx + r * Math.cos(end), y: cy + r * Math.sin(end) };
  const large = end - start > Math.PI ? 1 : 0;
  return `M ${s.x} ${s.y} A ${r} ${r} 0 ${large} 1 ${e.x} ${e.y}`;
}

export interface DonutSlice {
  label: string;
  value: number;
  color: string;
}

export function DonutChart({ data, size = 170, currency, centerLabel, centerValue }: { data: DonutSlice[]; size?: number; currency: string; centerLabel?: string; centerValue?: string }) {
  const { c } = useTheme();
  const total = data.reduce((s, d) => s + Math.max(0, d.value), 0);
  const stroke = size * 0.13;
  const r = size / 2 - stroke / 2;
  const cx = size / 2;
  let angle = -Math.PI / 2;
  const gap = data.length > 1 ? 0.025 : 0;
  const desc = data.map((d) => `${d.label} ${total ? Math.round((d.value / total) * 100) : 0}%`).join(', ');
  return (
    <View accessible accessibilityLabel={`Donut chart. ${desc}`} style={{ width: size, height: size }}>
      <Svg width={size} height={size}>
        <Circle cx={cx} cy={cx} r={r} stroke={c.inputBg} strokeWidth={stroke} fill="none" />
        {total > 0 &&
          data.map((d, i) => {
            const sweep = (d.value / total) * Math.PI * 2;
            const start = angle + gap / 2;
            const end = angle + sweep - gap / 2;
            angle += sweep;
            if (sweep >= Math.PI * 2 - 0.001) return <Circle key={i} cx={cx} cy={cx} r={r} stroke={d.color} strokeWidth={stroke} fill="none" />;
            if (end <= start) return null;
            return <Path key={i} d={describeArc(cx, cx, r, start, end)} stroke={d.color} strokeWidth={stroke} fill="none" strokeLinecap="round" />;
          })}
      </Svg>
      <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', padding: stroke + 6 }}>
        <Txt v="caption" dim numberOfLines={1}>
          {centerLabel ?? 'Total'}
        </Txt>
        <Txt v="h3" numberOfLines={1} adjustsFontSizeToFit>
          {centerValue ?? formatMoney(total, currency, { compact: true })}
        </Txt>
      </View>
    </View>
  );
}

export function Legend({ data, currency, max = 6 }: { data: DonutSlice[]; currency: string; max?: number }) {
  const total = data.reduce((s, d) => s + d.value, 0);
  return (
    <View style={{ gap: 8, flex: 1 }}>
      {data.slice(0, max).map((d) => (
        <Row key={d.label} gap={8}>
          <View style={{ width: 10, height: 10, borderRadius: 3, backgroundColor: d.color }} />
          <Txt v="small" style={{ flex: 1 }} numberOfLines={1}>
            {d.label}
          </Txt>
          <Txt v="caption" dim>
            {total ? Math.round((d.value / total) * 100) : 0}%
          </Txt>
          <Txt v="small" style={{ fontWeight: '700', minWidth: 58, textAlign: 'right' }} numberOfLines={1}>
            {formatMoney(d.value, currency, { compact: true })}
          </Txt>
        </Row>
      ))}
    </View>
  );
}

export interface BarDatum {
  label: string;
  values: number[]; // one per series
}

/** Grouped bar chart (e.g. income vs expenses). Tap a group to see its values. */
export function BarChart({ data, colors, seriesLabels, height = 180, currency }: { data: BarDatum[]; colors: string[]; seriesLabels: string[]; height?: number; currency: string }) {
  const { c } = useTheme();
  const [width, setWidth] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const max = Math.max(1, ...data.flatMap((d) => d.values));
  const padBottom = 22;
  const chartH = height - padBottom;
  const n = data.length || 1;
  const groupW = width / n;
  const series = data[0]?.values.length ?? 1;
  const barW = Math.max(3, Math.min(18, (groupW * 0.7) / series));
  const labelEvery = Math.ceil(n / 7);
  const desc = data.map((d) => `${d.label}: ${d.values.map((v, i) => `${seriesLabels[i]} ${formatMoney(v, currency, { compact: true })}`).join(', ')}`).join('; ');
  return (
    <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)} accessible accessibilityLabel={`Bar chart. ${desc}`}>
      {width > 0 && (
        <Svg width={width} height={height}>
          {[0.25, 0.5, 0.75, 1].map((f) => (
            <Line key={f} x1={0} x2={width} y1={chartH - chartH * f} y2={chartH - chartH * f} stroke={c.border} strokeWidth={1} strokeDasharray="3,5" />
          ))}
          {data.map((d, gi) => {
            const gx = gi * groupW + (groupW - barW * series - 2 * (series - 1)) / 2;
            return (
              <G key={gi} opacity={selected == null || selected === gi ? 1 : 0.35}>
                {d.values.map((v, si) => {
                  const h = Math.max(v > 0 ? 2 : 0, (v / max) * (chartH - 8));
                  return <Rect key={si} x={gx + si * (barW + 2)} y={chartH - h} width={barW} height={h} rx={Math.min(4, barW / 2)} fill={colors[si]} />;
                })}
                {gi % labelEvery === 0 ? (
                  <SvgText x={gi * groupW + groupW / 2} y={height - 6} fontSize={10} fill={c.textFaint} textAnchor="middle">
                    {d.label}
                  </SvgText>
                ) : null}
              </G>
            );
          })}
        </Svg>
      )}
      {width > 0 && (
        <View style={{ position: 'absolute', top: 0, left: 0, width, height: chartH, flexDirection: 'row' }}>
          {data.map((_, gi) => (
            <Pressable key={gi} style={{ flex: 1 }} onPress={() => setSelected(selected === gi ? null : gi)} accessibilityLabel={`Show ${data[gi].label}`} />
          ))}
        </View>
      )}
      <Row gap={14} style={{ marginTop: 8, flexWrap: 'wrap' }}>
        {seriesLabels.map((s, i) => (
          <Row key={s} gap={6}>
            <View style={{ width: 10, height: 10, borderRadius: 3, backgroundColor: colors[i] }} />
            <Txt v="caption" dim>
              {s}
              {selected != null ? `: ${formatMoney(data[selected].values[i], currency, { compact: true })}` : ''}
            </Txt>
          </Row>
        ))}
        {selected != null ? (
          <Txt v="caption" faint>
            ({data[selected].label})
          </Txt>
        ) : null}
      </Row>
    </View>
  );
}

/** Smooth area/line chart for trends (cash flow, debt balance, health history). */
export function LineChart({ points, color, height = 150, currency, allowNegative, formatValue }: { points: { label: string; value: number }[]; color?: string; height?: number; currency?: string; allowNegative?: boolean; formatValue?: (v: number) => string }) {
  const { c } = useTheme();
  const [width, setWidth] = useState(0);
  const stroke = color ?? c.primary;
  const fmt = formatValue ?? ((v: number) => (currency ? formatMoney(v, currency, { compact: true }) : String(v)));
  const { path, area, coords, zeroY } = useMemo(() => {
    if (!width || points.length === 0) return { path: '', area: '', coords: [] as { x: number; y: number }[], zeroY: 0 };
    const vals = points.map((p) => p.value);
    const maxV = Math.max(...vals, allowNegative ? 0 : 1);
    const minV = allowNegative ? Math.min(...vals, 0) : 0;
    const span = maxV - minV || 1;
    const padT = 12;
    const h = height - 26 - padT;
    const step = points.length > 1 ? width / (points.length - 1) : width;
    const pts = points.map((p, i) => ({ x: points.length > 1 ? i * step : width / 2, y: padT + h - ((p.value - minV) / span) * h }));
    let d = `M ${pts[0].x} ${pts[0].y}`;
    for (let i = 1; i < pts.length; i++) {
      const p0 = pts[i - 1];
      const p1 = pts[i];
      const cx = (p0.x + p1.x) / 2;
      d += ` C ${cx} ${p0.y}, ${cx} ${p1.y}, ${p1.x} ${p1.y}`;
    }
    const zy = padT + h - ((0 - minV) / span) * h;
    return { path: d, area: `${d} L ${pts[pts.length - 1].x} ${padT + h} L ${pts[0].x} ${padT + h} Z`, coords: pts, zeroY: zy };
  }, [width, points, height, allowNegative]);
  const last = points[points.length - 1];
  const labelEvery = Math.ceil(points.length / 6);
  return (
    <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)} accessible accessibilityLabel={`Trend chart. ${points.map((p) => `${p.label} ${fmt(p.value)}`).join(', ')}`}>
      {width > 0 && points.length > 0 && (
        <Svg width={width} height={height}>
          <Defs>
            <LinearGradient id="lg" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={stroke} stopOpacity={0.35} />
              <Stop offset="1" stopColor={stroke} stopOpacity={0} />
            </LinearGradient>
          </Defs>
          {allowNegative ? <Line x1={0} x2={width} y1={zeroY} y2={zeroY} stroke={c.border} strokeDasharray="4,4" /> : null}
          <Path d={area} fill="url(#lg)" />
          <Path d={path} stroke={stroke} strokeWidth={2.5} fill="none" />
          {coords.length ? <Circle cx={coords[coords.length - 1].x} cy={coords[coords.length - 1].y} r={4.5} fill={stroke} stroke={c.bg} strokeWidth={2} /> : null}
          {points.map((p, i) =>
            i % labelEvery === 0 || i === points.length - 1 ? (
              <SvgText key={i} x={Math.min(width - 14, Math.max(14, coords[i]?.x ?? 0))} y={height - 6} fontSize={10} fill={c.textFaint} textAnchor="middle">
                {p.label}
              </SvgText>
            ) : null,
          )}
        </Svg>
      )}
      {last ? (
        <Txt v="caption" dim style={{ position: 'absolute', right: 0, top: 0 }}>
          {fmt(last.value)}
        </Txt>
      ) : null}
    </View>
  );
}

/** Circular progress ring with centred content. */
export function ProgressRing({ value, size = 64, stroke = 7, color, children, label }: { value: number; size?: number; stroke?: number; color?: string; children?: React.ReactNode; label?: string }) {
  const { c } = useTheme();
  const v = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  return (
    <View style={{ width: size, height: size }} accessible accessibilityRole="progressbar" accessibilityLabel={label} accessibilityValue={{ min: 0, max: 100, now: Math.round(v * 100) }}>
      <Svg width={size} height={size} style={{ transform: [{ rotate: '-90deg' }] }}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={c.inputBg} strokeWidth={stroke} fill="none" />
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={color ?? c.primary} strokeWidth={stroke} fill="none" strokeDasharray={`${circ} ${circ}`} strokeDashoffset={circ * (1 - v)} strokeLinecap="round" />
      </Svg>
      <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' }}>{children}</View>
    </View>
  );
}

export function healthColor(c: { success: string; warning: string; danger: string; accent: string }, score: number): string {
  return score >= 70 ? c.success : score >= 50 ? c.warning : c.danger;
}
