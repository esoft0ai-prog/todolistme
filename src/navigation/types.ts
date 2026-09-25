import type { NavigatorScreenParams } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { TransactionType } from '../domain/types';

export type TabParamList = {
  Home: undefined;
  Activity: { accountId?: string; categoryId?: string; type?: TransactionType } | undefined;
  Plan: { tab?: 'budgets' | 'goals' } | undefined;
  Debts: undefined;
  More: undefined;
};

export type RootStackParamList = {
  Tabs: NavigatorScreenParams<TabParamList> | undefined;
  TransactionForm: { id?: string; type?: TransactionType; accountId?: string; debtId?: string; goalId?: string; duplicateOf?: string } | undefined;
  DebtForm: { id?: string } | undefined;
  DebtDetail: { id: string };
  RepaymentForm: { debtId: string };
  BudgetForm: { id?: string } | undefined;
  BudgetDetail: { id: string };
  GoalForm: { id?: string } | undefined;
  GoalDetail: { id: string };
  GoalContribution: { goalId: string; kind: 'deposit' | 'withdraw' };
  Accounts: undefined;
  AccountForm: { id?: string } | undefined;
  Categories: undefined;
  Recurring: undefined;
  RecurringForm: { id?: string } | undefined;
  Calendar: undefined;
  EventForm: { id?: string; date?: string } | undefined;
  Reminders: undefined;
  ReminderForm: { id?: string } | undefined;
  Reports: undefined;
  Assistant: { q?: string } | undefined;
  Notifications: undefined;
  Settings: undefined;
  SecuritySettings: undefined;
  NotificationSettings: undefined;
  CurrencySettings: undefined;
  Backup: undefined;
  Search: undefined;
  Health: undefined;
  AuditLog: undefined;
  About: undefined;
};

export type RootScreenProps<T extends keyof RootStackParamList> = NativeStackScreenProps<RootStackParamList, T>;
