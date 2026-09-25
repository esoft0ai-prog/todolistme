import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNavigationContainerRef, DarkTheme, DefaultTheme, NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import React from 'react';
import { Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { DashboardScreen } from '../screens/DashboardScreen';
import { MoreScreen } from '../screens/MoreScreen';
import { TransactionFormScreen } from '../screens/TransactionFormScreen';
import { TransactionsScreen } from '../screens/TransactionsScreen';
import { DebtDetailScreen } from '../screens/debts/DebtDetailScreen';
import { DebtFormScreen } from '../screens/debts/DebtFormScreen';
import { DebtsScreen } from '../screens/debts/DebtsScreen';
import { RepaymentFormScreen } from '../screens/debts/RepaymentFormScreen';
import { AssistantScreen } from '../screens/insights/AssistantScreen';
import { HealthScreen } from '../screens/insights/HealthScreen';
import { NotificationsScreen } from '../screens/insights/NotificationsScreen';
import { ReportsScreen } from '../screens/insights/ReportsScreen';
import { SearchScreen } from '../screens/insights/SearchScreen';
import { BudgetDetailScreen, BudgetFormScreen } from '../screens/plan/BudgetScreens';
import { GoalContributionScreen, GoalDetailScreen, GoalFormScreen } from '../screens/plan/GoalScreens';
import { PlanScreen } from '../screens/plan/PlanScreen';
import { CalendarScreen, EventFormScreen, ReminderFormScreen, RemindersScreen } from '../screens/planning/CalendarScreens';
import { RecurringFormScreen, RecurringScreen } from '../screens/planning/RecurringScreens';
import { AccountFormScreen, AccountsScreen, CategoriesScreen } from '../screens/settings/AccountScreens';
import { BackupScreen } from '../screens/settings/BackupScreen';
import { AboutScreen, AuditLogScreen, CurrencySettingsScreen, NotificationSettingsScreen, SecuritySettingsScreen, SettingsScreen } from '../screens/settings/SettingsScreens';
import { Icon } from '../ui/components/primitives';
import { useTheme } from '../ui/theme';
import type { RootStackParamList, TabParamList } from './types';

export const navigationRef = createNavigationContainerRef<RootStackParamList>();

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator<TabParamList>();

const TAB_ICONS: Record<keyof TabParamList, [string, string]> = {
  Home: ['home', 'home-outline'],
  Activity: ['swap-vertical', 'swap-vertical-outline'],
  Plan: ['pie-chart', 'pie-chart-outline'],
  Debts: ['card', 'card-outline'],
  More: ['grid', 'grid-outline'],
};

function Tabs() {
  const { c, scale } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        lazy: true,
        tabBarActiveTintColor: c.primary,
        tabBarInactiveTintColor: c.textFaint,
        tabBarStyle: {
          backgroundColor: c.tabBar,
          borderTopColor: c.border,
          height: 62 + insets.bottom,
          paddingBottom: Math.max(insets.bottom, 8),
          paddingTop: 6,
        },
        tabBarLabelStyle: { fontSize: 11 * scale, fontWeight: '700' },
        tabBarIcon: ({ focused, color }) => <Icon name={TAB_ICONS[route.name][focused ? 0 : 1]} size={23} color={color} />,
        tabBarAllowFontScaling: true,
      })}
    >
      <Tab.Screen name="Home" component={DashboardScreen} options={{ tabBarAccessibilityLabel: 'Home dashboard' }} />
      <Tab.Screen name="Activity" component={TransactionsScreen} options={{ tabBarAccessibilityLabel: 'Transactions' }} />
      <Tab.Screen name="Plan" component={PlanScreen} options={{ tabBarAccessibilityLabel: 'Budgets and savings goals' }} />
      <Tab.Screen name="Debts" component={DebtsScreen} options={{ tabBarAccessibilityLabel: 'Debts and loans' }} />
      <Tab.Screen name="More" component={MoreScreen} />
    </Tab.Navigator>
  );
}

export function RootNavigator() {
  const { c } = useTheme();
  const base = c.mode === 'dark' ? DarkTheme : DefaultTheme;
  const navTheme = { ...base, colors: { ...base.colors, background: c.bg, card: c.surface, text: c.text, border: c.border, primary: c.primary, notification: c.danger } };
  return (
    <NavigationContainer ref={navigationRef} theme={navTheme}>
      <Stack.Navigator screenOptions={{ headerShown: false, animation: Platform.OS === 'android' ? 'slide_from_right' : 'default', contentStyle: { backgroundColor: c.bg } }}>
        <Stack.Screen name="Tabs" component={Tabs} />
        <Stack.Screen name="TransactionForm" component={TransactionFormScreen} options={{ animation: 'slide_from_bottom' }} />
        <Stack.Screen name="DebtForm" component={DebtFormScreen} options={{ animation: 'slide_from_bottom' }} />
        <Stack.Screen name="DebtDetail" component={DebtDetailScreen} />
        <Stack.Screen name="RepaymentForm" component={RepaymentFormScreen} options={{ animation: 'slide_from_bottom' }} />
        <Stack.Screen name="BudgetForm" component={BudgetFormScreen} options={{ animation: 'slide_from_bottom' }} />
        <Stack.Screen name="BudgetDetail" component={BudgetDetailScreen} />
        <Stack.Screen name="GoalForm" component={GoalFormScreen} options={{ animation: 'slide_from_bottom' }} />
        <Stack.Screen name="GoalDetail" component={GoalDetailScreen} />
        <Stack.Screen name="GoalContribution" component={GoalContributionScreen} options={{ animation: 'slide_from_bottom' }} />
        <Stack.Screen name="Accounts" component={AccountsScreen} />
        <Stack.Screen name="AccountForm" component={AccountFormScreen} options={{ animation: 'slide_from_bottom' }} />
        <Stack.Screen name="Categories" component={CategoriesScreen} />
        <Stack.Screen name="Recurring" component={RecurringScreen} />
        <Stack.Screen name="RecurringForm" component={RecurringFormScreen} options={{ animation: 'slide_from_bottom' }} />
        <Stack.Screen name="Calendar" component={CalendarScreen} />
        <Stack.Screen name="EventForm" component={EventFormScreen} options={{ animation: 'slide_from_bottom' }} />
        <Stack.Screen name="Reminders" component={RemindersScreen} />
        <Stack.Screen name="ReminderForm" component={ReminderFormScreen} options={{ animation: 'slide_from_bottom' }} />
        <Stack.Screen name="Reports" component={ReportsScreen} />
        <Stack.Screen name="Assistant" component={AssistantScreen} />
        <Stack.Screen name="Notifications" component={NotificationsScreen} />
        <Stack.Screen name="Settings" component={SettingsScreen} />
        <Stack.Screen name="SecuritySettings" component={SecuritySettingsScreen} />
        <Stack.Screen name="NotificationSettings" component={NotificationSettingsScreen} />
        <Stack.Screen name="CurrencySettings" component={CurrencySettingsScreen} />
        <Stack.Screen name="Backup" component={BackupScreen} />
        <Stack.Screen name="Search" component={SearchScreen} />
        <Stack.Screen name="Health" component={HealthScreen} />
        <Stack.Screen name="AuditLog" component={AuditLogScreen} />
        <Stack.Screen name="About" component={AboutScreen} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
