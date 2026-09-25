import { newId } from '../utils/id';
import type { Exec, ServiceContext } from './context';

export type AuditAction = 'create' | 'update' | 'delete' | 'restore' | 'import' | 'export' | 'security' | 'system';

/** Append-only local audit trail (never leaves the device except inside user-made backups). */
export async function audit(
  ctx: ServiceContext,
  exec: Exec,
  entityType: string,
  entityId: string | null,
  action: AuditAction,
  summary: string,
): Promise<void> {
  await exec.run('INSERT INTO audit_logs (id, entity_type, entity_id, action, summary, created_at) VALUES (?,?,?,?,?,?)', [
    newId(),
    entityType,
    entityId,
    action,
    summary.slice(0, 300),
    ctx.now().toISOString(),
  ]);
}

export async function listAudit(ctx: ServiceContext, limit = 200) {
  return ctx.db.all<{ id: string; entity_type: string; entity_id: string | null; action: string; summary: string; created_at: string }>(
    'SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ?',
    [limit],
  );
}

/** Keeps the audit log bounded on low-storage devices. */
export async function pruneAudit(ctx: ServiceContext, keep = 5000): Promise<void> {
  await ctx.db.run(
    'DELETE FROM audit_logs WHERE id IN (SELECT id FROM audit_logs ORDER BY created_at DESC LIMIT -1 OFFSET ?)',
    [keep],
  );
}
