import { mapEvent, mapReminder } from '../db/mappers';
import { isValidISODate } from '../domain/dates';
import type { FinancialEvent, Reminder } from '../domain/types';
import { sanitizeText, validateReminder } from '../domain/validation';
import { newId } from '../utils/id';
import { audit } from './audit';
import { throwIfErrors, ValidationError, type Exec, type ServiceContext } from './context';

export async function listCustomReminders(db: Exec): Promise<Reminder[]> {
  return (await db.all("SELECT * FROM reminders WHERE kind = 'custom' ORDER BY date, time_of_day")).map(mapReminder);
}

export async function listDebtReminders(db: Exec): Promise<Reminder[]> {
  return (await db.all("SELECT * FROM reminders WHERE kind = 'debt'")).map(mapReminder);
}

export type CustomReminderInput = Pick<Reminder, 'title' | 'message' | 'date' | 'timeOfDay' | 'repeat' | 'enabled'> & { isDemo?: boolean };

export async function saveCustomReminder(ctx: ServiceContext, input: CustomReminderInput, id?: string, exec?: Exec): Promise<string> {
  const clean = { ...input, kind: 'custom' as const, title: sanitizeText(input.title, 80), message: sanitizeText(input.message, 300) };
  throwIfErrors(validateReminder(clean));
  const db = exec ?? ctx.db;
  const now = ctx.now().toISOString();
  const rid = id ?? newId();
  if (id) {
    const r = await db.run('UPDATE reminders SET title=?, message=?, date=?, time_of_day=?, repeat=?, enabled=?, updated_at=? WHERE id=? AND kind=\'custom\'', [
      clean.title, clean.message, clean.date, clean.timeOfDay, clean.repeat, clean.enabled ? 1 : 0, now, id,
    ]);
    if (!r.changes) throw new ValidationError('Reminder not found');
  } else {
    await db.run(
      "INSERT INTO reminders (id, kind, entity_id, title, message, offset_days, date, time_of_day, repeat, enabled, is_demo, created_at, updated_at) VALUES (?,'custom',NULL,?,?,NULL,?,?,?,?,?,?,?)",
      [rid, clean.title, clean.message, clean.date, clean.timeOfDay, clean.repeat, clean.enabled ? 1 : 0, input.isDemo ? 1 : 0, now, now],
    );
  }
  await audit(ctx, db, 'reminder', rid, id ? 'update' : 'create', `Saved reminder "${clean.title}"`);
  return rid;
}

export async function deleteReminder(ctx: ServiceContext, id: string): Promise<void> {
  await ctx.db.run('DELETE FROM reminders WHERE id = ?', [id]);
  await audit(ctx, ctx.db, 'reminder', id, 'delete', 'Deleted reminder');
}

// ---------------------------------------------------------------- Calendar events

export async function listEvents(db: Exec, from?: string, to?: string): Promise<FinancialEvent[]> {
  const rows = from && to ? await db.all('SELECT * FROM financial_events WHERE date BETWEEN ? AND ? ORDER BY date', [from, to]) : await db.all('SELECT * FROM financial_events ORDER BY date');
  return rows.map(mapEvent);
}

export type EventInput = Omit<FinancialEvent, 'id' | 'createdAt' | 'updatedAt' | 'isDemo'> & { isDemo?: boolean };

export async function saveEvent(ctx: ServiceContext, input: EventInput, id?: string, exec?: Exec): Promise<string> {
  const title = sanitizeText(input.title, 80);
  if (!title) throw new ValidationError('Title is required', 'title');
  if (!isValidISODate(input.date)) throw new ValidationError('Enter a valid date', 'date');
  if (input.amountMinor != null && !(input.amountMinor > 0)) throw new ValidationError('Amount must be greater than zero', 'amountMinor');
  const db = exec ?? ctx.db;
  const now = ctx.now().toISOString();
  const eid = id ?? newId();
  if (id) {
    await db.run('UPDATE financial_events SET title=?, date=?, kind=?, amount_minor=?, notes=?, remind=?, updated_at=? WHERE id=?', [
      title, input.date, input.kind, input.amountMinor, input.notes ? sanitizeText(input.notes, 500) : null, input.remind ? 1 : 0, now, id,
    ]);
  } else {
    await db.run(
      'INSERT INTO financial_events (id, title, date, kind, amount_minor, notes, remind, is_demo, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [eid, title, input.date, input.kind, input.amountMinor, input.notes ? sanitizeText(input.notes, 500) : null, input.remind ? 1 : 0, input.isDemo ? 1 : 0, now, now],
    );
  }
  await audit(ctx, db, 'event', eid, id ? 'update' : 'create', `Saved calendar event "${title}"`);
  return eid;
}

export async function deleteEvent(ctx: ServiceContext, id: string): Promise<void> {
  await ctx.db.run('DELETE FROM financial_events WHERE id = ?', [id]);
}
