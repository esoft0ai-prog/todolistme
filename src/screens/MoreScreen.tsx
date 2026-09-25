import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import React from 'react';
import { Pressable, View } from 'react-native';
import type { RootStackParamList } from '../navigation/types';
import { useAppStore } from '../state/appStore';
import { Card, Icon, Row, Screen, SectionHeader, Txt, type IconName } from '../ui/components/primitives';
import { useTheme } from '../ui/theme';

type Nav = NativeStackNavigationProp<RootStackParamList>;

interface Tile {
  route: keyof RootStackParamList;
  label: string;
  desc: string;
  icon: IconName;
  color: (c: ReturnType<typeof useTheme>['c']) => string;
}

const GROUPS: { title: string; tiles: Tile[] }[] = [
  {
    title: 'Insights',
    tiles: [
      { route: 'Assistant', label: 'Assistant', desc: 'Ask about your money', icon: 'sparkles', color: (c) => c.primary },
      { route: 'Reports', label: 'Reports', desc: 'Charts & analytics', icon: 'stats-chart', color: (c) => c.accent },
      { route: 'Health', label: 'Health score', desc: 'Why your score is what it is', icon: 'pulse', color: (c) => c.success },
      { route: 'Calendar', label: 'Calendar', desc: 'Payments & events', icon: 'calendar', color: (c) => c.info },
    ],
  },
  {
    title: 'Money',
    tiles: [
      { route: 'Accounts', label: 'Accounts', desc: 'Cash, bank, wallets', icon: 'wallet', color: (c) => c.primary },
      { route: 'Recurring', label: 'Recurring', desc: 'Bills & salary', icon: 'repeat', color: (c) => c.warning },
      { route: 'Categories', label: 'Categories', desc: 'Organise spending', icon: 'pricetags', color: (c) => c.accent },
      { route: 'Search', label: 'Search', desc: 'Find anything', icon: 'search', color: (c) => c.info },
    ],
  },
  {
    title: 'Stay on track',
    tiles: [
      { route: 'Notifications', label: 'Notifications', desc: 'History & scheduled', icon: 'notifications', color: (c) => c.warning },
      { route: 'Reminders', label: 'Reminders', desc: 'Custom reminders', icon: 'alarm', color: (c) => c.danger },
    ],
  },
  {
    title: 'Data & privacy',
    tiles: [
      { route: 'Backup', label: 'Backup & restore', desc: 'Export, import, CSV', icon: 'cloud-download', color: (c) => c.accent },
      { route: 'Settings', label: 'Settings', desc: 'Currency, theme, security', icon: 'settings', color: (c) => c.textDim },
    ],
  },
];

export function MoreScreen() {
  const nav = useNavigation<Nav>();
  const { c } = useTheme();
  const unread = useAppStore((s) => s.unread);
  return (
    <Screen title="More" subtitle="Everything works offline">
      {GROUPS.map((g) => (
        <View key={g.title}>
          <SectionHeader title={g.title} />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
            {g.tiles.map((t) => (
              <Pressable
                key={t.route}
                onPress={() => nav.navigate(t.route as never)}
                accessibilityRole="button"
                accessibilityLabel={`${t.label}. ${t.desc}`}
                style={({ pressed }) => [{ width: '48.5%', opacity: pressed ? 0.8 : 1 }]}
              >
                <Card style={{ minHeight: 104 }}>
                  <Row justify="space-between" align="flex-start">
                    <View style={{ width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: t.color(c) + '22' }}>
                      <Icon name={t.icon} size={20} color={t.color(c)} />
                    </View>
                    {t.route === 'Notifications' && unread ? (
                      <View style={{ backgroundColor: c.danger, borderRadius: 9, minWidth: 18, paddingHorizontal: 5, height: 18, alignItems: 'center', justifyContent: 'center' }}>
                        <Txt v="caption" color="#fff" style={{ fontSize: 10, fontWeight: '800' }}>
                          {unread}
                        </Txt>
                      </View>
                    ) : null}
                  </Row>
                  <Txt v="bodyStrong" style={{ marginTop: 10 }} numberOfLines={1}>
                    {t.label}
                  </Txt>
                  <Txt v="caption" dim numberOfLines={2}>
                    {t.desc}
                  </Txt>
                </Card>
              </Pressable>
            ))}
          </View>
        </View>
      ))}
      <Txt v="caption" faint center style={{ marginTop: 24 }}>
        Finora · Personal Finance & Debt Intelligence{'\n'}Your data never leaves this phone.
      </Txt>
    </Screen>
  );
}
