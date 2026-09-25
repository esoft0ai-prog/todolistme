import React, { useState } from 'react';
import { View } from 'react-native';
import { parseBackup, totalRecords, type BackupFile, type BackupSummary } from '../../domain/backup';
import { buildHtmlReport } from '../../domain/exporters';
import { periodRange } from '../../domain/dates';
import { LATEST_SCHEMA_VERSION } from '../../db/schema';
import type { RootScreenProps } from '../../navigation/types';
import { listSafetySnapshots, pickTextFile, saveToUserFolder, shareFile, timestampedName, writeSafetySnapshot, writeTempFile } from '../../platform/files';
import { createBackup, restoreBackup, type RestoreStats } from '../../services/backup';
import { buildReportData, exportTransactionsCSV } from '../../services/reports';
import { friendlyError, mutate, runNotificationSync } from '../../state/actions';
import { useAppStore, useCtx } from '../../state/appStore';
import { alertDialog, chooseDialog, confirmDialog } from '../../ui/components/feedback';
import { Badge, Button, Card, Icon, ListRow, Row, Screen, SectionHeader, Segmented, Spacer, Txt } from '../../ui/components/primitives';
import { useTheme } from '../../ui/theme';
import { APP_VERSION } from './SettingsScreens';
import { loadPreferences } from '../../services/preferences';

const TABLE_LABEL: Record<string, string> = {
  accounts: 'Accounts',
  categories: 'Categories',
  transactions: 'Transactions',
  debts: 'Debts',
  debt_payments: 'Debt payments',
  savings_goals: 'Savings goals',
  budgets: 'Budgets',
  recurring_transactions: 'Recurring',
  reminders: 'Reminders',
  financial_events: 'Calendar events',
  tags: 'Tags',
};

export function BackupScreen({ navigation }: RootScreenProps<'Backup'>) {
  const { c } = useTheme();
  const ctx = useCtx();
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, setPending] = useState<{ backup: BackupFile; summary: BackupSummary; warnings: string[]; fileName: string } | null>(null);
  const [mode, setMode] = useState<'merge' | 'replace'>('merge');
  const [result, setResult] = useState<RestoreStats | null>(null);
  const snapshots = listSafetySnapshots();

  const deliver = async (name: string, content: string, mime: string) => {
    const how = await chooseDialog('Save or share?', 'Keep a copy somewhere safe — off this phone is best (email, Google Drive, memory card, computer).', [
      { text: 'Share (WhatsApp, Telegram, email, Drive…)', value: 'share', variant: 'primary' },
      { text: 'Save to a folder on this phone', value: 'save', variant: 'secondary' },
      { text: 'Cancel', value: 'cancel', variant: 'ghost' },
    ]);
    if (how === 'share') await shareFile(writeTempFile(name, content), mime, 'Share Finora file');
    else if (how === 'save') {
      if (await saveToUserFolder(name, content, mime)) useAppStore.getState().showToast(`Saved ${name}`);
    }
  };

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      await alertDialog('Something went wrong', friendlyError(e), 'danger');
    } finally {
      setBusy(null);
    }
  };

  const exportJson = () =>
    run('json', async () => {
      const backup = await createBackup(ctx, APP_VERSION);
      await deliver(timestampedName('finora-backup', 'json'), JSON.stringify(backup), 'application/json');
    });

  const exportCsv = () =>
    run('csv', async () => {
      const { csv, count } = await exportTransactionsCSV(ctx, {});
      if (!count) return alertDialog('Nothing to export', 'You have no transactions yet.');
      await deliver(timestampedName('finora-transactions', 'csv'), csv, 'text/csv');
    });

  const exportReport = () =>
    run('report', async () => {
      const prefs = await loadPreferences(ctx.db);
      const html = buildHtmlReport(await buildReportData(ctx, periodRange('this_year', undefined, prefs.weekStartsOn)));
      await deliver(timestampedName('finora-report', 'html'), html, 'text/html');
    });

  const pickBackup = () =>
    run('import', async () => {
      setResult(null);
      const file = await pickTextFile();
      if (!file) return;
      const parsed = parseBackup(file.text, { maxSchemaVersion: LATEST_SCHEMA_VERSION });
      if (!parsed.ok) {
        await alertDialog('This backup cannot be used', parsed.errors.slice(0, 5).join('\n'), 'danger');
        return;
      }
      setPending({ backup: parsed.backup, summary: parsed.summary, warnings: parsed.warnings, fileName: file.name });
    });

  const restore = async () => {
    if (!pending) return;
    if (!pending.summary.checksumValid) {
      const go = await confirmDialog({ title: 'Backup may be modified', message: 'The file’s integrity check failed. It may have been edited or damaged. Only continue if you trust this file.', confirmText: 'Continue anyway', destructive: true });
      if (!go) return;
    }
    const ok = await confirmDialog({
      title: mode === 'replace' ? 'Replace all data?' : 'Merge this backup?',
      message:
        mode === 'replace'
          ? 'Everything currently in Finora will be deleted and replaced with the backup. A safety copy of your current data is saved first.'
          : 'Records from the backup will be added. Duplicates are skipped and newer edits win. A safety copy of your current data is saved first.',
      confirmText: mode === 'replace' ? 'Replace my data' : 'Merge',
      destructive: mode === 'replace',
    });
    if (!ok) return;
    await run('restore', async () => {
      // Safety snapshot of the current data before touching anything.
      const current = await createBackup(ctx, APP_VERSION);
      if (totalRecords(current.counts) > 0) writeSafetySnapshot(JSON.stringify(current));
      const res = await mutate((cx) => restoreBackup(cx, pending.backup, mode), { silent: true });
      if (!res.ok) {
        await alertDialog('Restore failed — nothing was changed', res.error, 'danger');
        return;
      }
      const prefs = await loadPreferences(ctx.db);
      useAppStore.getState().setPrefs(prefs);
      await runNotificationSync();
      setResult(res.value);
      setPending(null);
      useAppStore.getState().showToast('Backup restored');
    });
  };

  const restoreSnapshot = async (name: string) => {
    const snap = snapshots.find((s) => s.name === name);
    if (!snap) return;
    const text = await snap.file.text();
    const parsed = parseBackup(text, { maxSchemaVersion: LATEST_SCHEMA_VERSION });
    if (parsed.ok) {
      setMode('replace');
      setPending({ backup: parsed.backup, summary: parsed.summary, warnings: parsed.warnings, fileName: name });
    } else await alertDialog('Snapshot unreadable', parsed.errors[0], 'danger');
  };

  return (
    <Screen title="Backup & restore" onBack={() => navigation.goBack()}>
      <Card tone="warning">
        <Row gap={10} align="flex-start">
          <Icon name="information-circle" size={20} color={c.warning} />
          <Txt v="small" style={{ flex: 1 }}>
            Finora keeps your data only on this phone. If the phone is lost or the app is uninstalled, your data is gone — unless you have a backup. Export one regularly.
          </Txt>
        </Row>
      </Card>

      <SectionHeader title="Export" />
      <Card padded={false} style={{ paddingHorizontal: 14 }}>
        <ListRow icon="archive" iconColor={c.primary} title="Full backup (JSON)" subtitle="Everything: accounts, transactions, debts, goals, budgets, settings" chevron onPress={exportJson} />
        <ListRow icon="grid" iconColor={c.accent} title="Transactions (CSV)" subtitle="Open in Excel or Google Sheets" chevron onPress={exportCsv} />
        <ListRow icon="document-text" iconColor={c.info} title="Financial report (HTML)" subtitle="Readable summary for this year — printable" chevron onPress={exportReport} />
      </Card>
      {busy === 'json' || busy === 'csv' || busy === 'report' ? (
        <Txt v="caption" dim style={{ marginTop: 6 }}>
          Preparing export…
        </Txt>
      ) : null}

      <SectionHeader title="Restore" />
      <Card>
        <Txt v="small" dim>
          Choose a Finora backup file (.json). It is checked for errors before anything changes, and you will see what it contains first.
        </Txt>
        <Spacer h={10} />
        <Button title="Choose backup file" icon="folder-open" onPress={pickBackup} loading={busy === 'import'} />
      </Card>

      {pending ? (
        <>
          <SectionHeader title="Backup contents" />
          <Card tone={pending.summary.checksumValid ? 'primary' : 'danger'}>
            <Row justify="space-between">
              <Txt v="bodyStrong" numberOfLines={1} style={{ flex: 1 }}>
                {pending.fileName}
              </Txt>
              {pending.summary.checksumValid ? <Badge label="Verified" color={c.success} /> : <Badge label="Modified?" color={c.danger} />}
            </Row>
            <Txt v="caption" dim>
              Created {new Date(pending.summary.createdAt).toLocaleString()} · Finora {pending.summary.appVersion} · {pending.summary.baseCurrency}
            </Txt>
            <Spacer h={10} />
            {Object.entries(pending.summary.counts)
              .filter(([k, n]) => TABLE_LABEL[k] && n > 0)
              .map(([k, n]) => (
                <Row key={k} justify="space-between">
                  <Txt v="small" dim>
                    {TABLE_LABEL[k]}
                  </Txt>
                  <Txt v="small" style={{ fontWeight: '700' }}>
                    {n}
                  </Txt>
                </Row>
              ))}
            {pending.warnings.length ? (
              <View style={{ marginTop: 10 }}>
                {pending.warnings.map((w) => (
                  <Txt key={w} v="caption" color={c.warning}>
                    • {w}
                  </Txt>
                ))}
              </View>
            ) : null}
            <Spacer h={12} />
            <Segmented value={mode} onChange={setMode} options={[{ value: 'merge', label: 'Merge with my data' }, { value: 'replace', label: 'Replace my data' }]} />
            <Txt v="caption" dim style={{ marginTop: 6 }}>
              {mode === 'merge' ? 'Adds new records, skips duplicates (same transaction entered on two phones), and keeps the most recently edited version of each record.' : 'Deletes all current data and restores exactly what is in the backup.'}
            </Txt>
            <Spacer h={12} />
            <Row gap={10}>
              <Button title="Cancel" variant="ghost" onPress={() => setPending(null)} style={{ flex: 1 }} />
              <Button title={mode === 'replace' ? 'Replace' : 'Merge'} variant={mode === 'replace' ? 'danger' : 'primary'} onPress={restore} loading={busy === 'restore'} style={{ flex: 1.3 }} />
            </Row>
          </Card>
        </>
      ) : null}

      {result ? (
        <Card tone="success" style={{ marginTop: 12 }}>
          <Txt v="bodyStrong">Restore complete</Txt>
          <Txt v="small" dim>
            {result.totalInserted} added · {result.totalUpdated} updated · {result.totalDuplicates} duplicates skipped. Reminders have been rescheduled.
          </Txt>
        </Card>
      ) : null}

      {snapshots.length ? (
        <>
          <SectionHeader title="Safety copies (made before each restore)" />
          <Card padded={false} style={{ paddingHorizontal: 14 }}>
            {snapshots.map((s) => (
              <ListRow key={s.name} icon="time" title={s.name} subtitle="Tap to restore this copy" onPress={() => restoreSnapshot(s.name)} />
            ))}
          </Card>
        </>
      ) : null}
    </Screen>
  );
}
