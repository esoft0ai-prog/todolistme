import { createContext, useContext } from 'react';
import type { TextStyle } from 'react-native';

export interface Palette {
  mode: 'dark' | 'light';
  bg: string;
  bgGradient: [string, string, string];
  surface: string;
  surfaceAlt: string;
  glass: string;
  glassBorder: string;
  border: string;
  text: string;
  textDim: string;
  textFaint: string;
  primary: string;
  primarySoft: string;
  onPrimary: string;
  accent: string;
  accentSoft: string;
  success: string;
  successSoft: string;
  warning: string;
  warningSoft: string;
  danger: string;
  dangerSoft: string;
  info: string;
  heroGradient: [string, string];
  chart: string[];
  overlay: string;
  tabBar: string;
  inputBg: string;
}

export const dark: Palette = {
  mode: 'dark',
  bg: '#070A14',
  bgGradient: ['#0B1024', '#070A14', '#05070E'],
  surface: '#101629',
  surfaceAlt: '#161E36',
  glass: 'rgba(255,255,255,0.045)',
  glassBorder: 'rgba(255,255,255,0.09)',
  border: 'rgba(255,255,255,0.08)',
  text: '#EEF1FF',
  textDim: '#A3ACCB',
  textFaint: '#6B7497',
  primary: '#7C8CFF',
  primarySoft: 'rgba(124,140,255,0.16)',
  onPrimary: '#0A0E1F',
  accent: '#22D3A6',
  accentSoft: 'rgba(34,211,166,0.14)',
  success: '#2EE59D',
  successSoft: 'rgba(46,229,157,0.14)',
  warning: '#FFB547',
  warningSoft: 'rgba(255,181,71,0.15)',
  danger: '#FF5C7A',
  dangerSoft: 'rgba(255,92,122,0.15)',
  info: '#38BDF8',
  heroGradient: ['#4F5BD5', '#22D3A6'],
  chart: ['#7C8CFF', '#22D3A6', '#FFB547', '#FF5C7A', '#38BDF8', '#C084FC', '#F472B6', '#A3E635', '#FB923C', '#94A3B8'],
  overlay: 'rgba(3,5,12,0.72)',
  tabBar: 'rgba(12,17,34,0.96)',
  inputBg: 'rgba(255,255,255,0.05)',
};

export const light: Palette = {
  mode: 'light',
  bg: '#F4F6FC',
  bgGradient: ['#EEF1FF', '#F4F6FC', '#F7F9FD'],
  surface: '#FFFFFF',
  surfaceAlt: '#EEF1F8',
  glass: 'rgba(255,255,255,0.85)',
  glassBorder: 'rgba(20,30,70,0.08)',
  border: 'rgba(20,30,70,0.10)',
  text: '#0E1430',
  textDim: '#4A5378',
  textFaint: '#7A83A6',
  primary: '#4F5BD5',
  primarySoft: 'rgba(79,91,213,0.10)',
  onPrimary: '#FFFFFF',
  accent: '#0EA886',
  accentSoft: 'rgba(14,168,134,0.10)',
  success: '#0E9F6E',
  successSoft: 'rgba(14,159,110,0.10)',
  warning: '#C27803',
  warningSoft: 'rgba(194,120,3,0.10)',
  danger: '#D6284B',
  dangerSoft: 'rgba(214,40,75,0.09)',
  info: '#0284C7',
  heroGradient: ['#4F5BD5', '#0EA886'],
  chart: ['#4F5BD5', '#0EA886', '#D97706', '#D6284B', '#0284C7', '#9333EA', '#DB2777', '#65A30D', '#EA580C', '#64748B'],
  overlay: 'rgba(10,14,31,0.45)',
  tabBar: 'rgba(255,255,255,0.97)',
  inputBg: 'rgba(14,20,48,0.04)',
};

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 28 };
export const radius = { sm: 10, md: 14, lg: 20, xl: 26, pill: 999 };

export type TypeVariant = 'display' | 'h1' | 'h2' | 'h3' | 'body' | 'bodyStrong' | 'small' | 'caption' | 'label' | 'number';

export function typography(scale: number): Record<TypeVariant, TextStyle> {
  const s = (n: number) => Math.round(n * scale);
  return {
    display: { fontSize: s(34), fontWeight: '800', letterSpacing: -0.8, fontVariant: ['tabular-nums'] },
    h1: { fontSize: s(26), fontWeight: '800', letterSpacing: -0.5 },
    h2: { fontSize: s(20), fontWeight: '700', letterSpacing: -0.3 },
    h3: { fontSize: s(16), fontWeight: '700' },
    body: { fontSize: s(15), fontWeight: '400', lineHeight: s(21) },
    bodyStrong: { fontSize: s(15), fontWeight: '600', lineHeight: s(21) },
    small: { fontSize: s(13), fontWeight: '400', lineHeight: s(18) },
    caption: { fontSize: s(12), fontWeight: '500', lineHeight: s(16) },
    label: { fontSize: s(11), fontWeight: '700', letterSpacing: 0.8, textTransform: 'uppercase' },
    number: { fontSize: s(17), fontWeight: '700', fontVariant: ['tabular-nums'] },
  };
}

export interface Theme {
  c: Palette;
  t: Record<TypeVariant, TextStyle>;
  scale: number;
}

export function makeTheme(mode: 'dark' | 'light', largeText: boolean): Theme {
  const scale = largeText ? 1.15 : 1;
  return { c: mode === 'dark' ? dark : light, t: typography(scale), scale };
}

export const ThemeContext = createContext<Theme>(makeTheme('dark', false));

export function useTheme(): Theme {
  return useContext(ThemeContext);
}

export function toneColor(c: Palette, tone: 'good' | 'warn' | 'bad' | 'neutral' | 'info'): string {
  return tone === 'good' ? c.success : tone === 'warn' ? c.warning : tone === 'bad' ? c.danger : tone === 'info' ? c.info : c.textDim;
}
