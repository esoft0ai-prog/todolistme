import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';

/**
 * File helpers built on Android's Storage Access Framework — no storage
 * permissions are needed. Exports are written to the app cache and then either
 * saved to a folder the user picks or handed to the Android share sheet
 * (WhatsApp, Drive, email, Bluetooth...).
 */

export const MAX_IMPORT_BYTES = 50 * 1024 * 1024;

function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100);
}

export function timestampedName(prefix: string, ext: string, d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return safeName(`${prefix}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.${ext}`);
}

/** Writes content to a temporary cache file (overwritten on each export). */
export function writeTempFile(name: string, content: string): File {
  const dir = new Directory(Paths.cache, 'exports');
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  const file = new File(dir, safeName(name));
  if (file.exists) file.delete();
  file.create();
  file.write(content);
  return file;
}

export async function shareFile(file: File, mimeType: string, dialogTitle: string): Promise<void> {
  if (Platform.OS === 'web') {
    downloadOnWeb(file.name, file.textSync(), mimeType);
    return;
  }
  if (!(await Sharing.isAvailableAsync())) throw new Error('Sharing is not available on this device');
  await Sharing.shareAsync(file.uri, { mimeType, dialogTitle, UTI: mimeType });
}

/** Lets the user pick a folder (e.g. Downloads, SD card) and saves the file there. Returns false if cancelled. */
export async function saveToUserFolder(name: string, content: string, mimeType: string): Promise<boolean> {
  if (Platform.OS === 'web') {
    downloadOnWeb(name, content, mimeType);
    return true;
  }
  let dir: Directory;
  try {
    dir = await Directory.pickDirectoryAsync();
  } catch {
    return false; // user cancelled
  }
  if (!dir) return false;
  const file = dir.createFile(safeName(name), mimeType);
  file.write(content);
  return true;
}

/** Opens the system file picker and returns the file's text content. */
export async function pickTextFile(mimeTypes: string[] = ['application/json', 'text/plain', '*/*']): Promise<{ name: string; text: string } | null> {
  if (Platform.OS === 'web') return pickOnWeb();
  const result = await File.pickFileAsync({ mimeTypes });
  if (!result || result.canceled || !result.result) return null;
  const file = result.result;
  const size = file.size ?? 0;
  if (size > MAX_IMPORT_BYTES) throw new Error('The selected file is too large to be a Finora backup (max 50 MB).');
  return { name: file.name, text: await file.text() };
}

/** Local safety snapshots kept in app-private storage (last 5). */
export function writeSafetySnapshot(content: string): string {
  const dir = new Directory(Paths.document, 'safety-backups');
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  const file = new File(dir, timestampedName('finora-before-restore', 'json'));
  if (file.exists) file.delete();
  file.create();
  file.write(content);
  const files = dir
    .list()
    .filter((f): f is File => f instanceof File)
    .sort((a, b) => (a.name < b.name ? 1 : -1));
  for (const old of files.slice(5)) old.delete();
  return file.name;
}

export function listSafetySnapshots(): { name: string; file: File }[] {
  if (Platform.OS === 'web') return [];
  const dir = new Directory(Paths.document, 'safety-backups');
  if (!dir.exists) return [];
  return dir
    .list()
    .filter((f): f is File => f instanceof File)
    .sort((a, b) => (a.name < b.name ? 1 : -1))
    .map((file) => ({ name: file.name, file }));
}

function downloadOnWeb(name: string, content: string, mimeType: string) {
  const g = globalThis as unknown as { document?: any; URL?: any; Blob?: any };
  if (!g.document || !g.Blob) return;
  const blob = new g.Blob([content], { type: mimeType });
  const url = g.URL.createObjectURL(blob);
  const a = g.document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  g.URL.revokeObjectURL(url);
}

function pickOnWeb(): Promise<{ name: string; text: string } | null> {
  const g = globalThis as unknown as { document?: any };
  return new Promise((resolve) => {
    if (!g.document) return resolve(null);
    const input = g.document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return resolve(null);
      resolve({ name: f.name, text: await f.text() });
    };
    input.click();
  });
}
