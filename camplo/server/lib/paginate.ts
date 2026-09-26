/**
 * Cursor-based pagination (ADL P-4) for every list endpoint:
 *   request  ?limit=50 (max 100) &cursor=<opaque>
 *   response { data: [...], next_cursor: string | null, has_more: boolean, ...endpoint extras }
 *
 * Large tables (leads, campaign logs) paginate in SQL on their sort key. Everything else is a bounded list that is
 * already sorted in the service; `paginate` pages it by item key, so a new row arriving between requests never shifts
 * the next page (unlike an offset).
 */
import { z } from 'zod';

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100;

/** Spread into a route's input object. */
export const pageIn = {
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
  cursor: z.string().max(500).optional(),
};
export const pageQuery = z.object(pageIn);
export type PageInput = { limit?: number; cursor?: string };
export interface Page<T> { data: T[]; next_cursor: string | null; has_more: boolean }

export const encodeCursor = (k: string) => Buffer.from(k, 'utf8').toString('base64url');
export const decodeCursor = (c: string | undefined) => {
  if (!c) return null;
  try { return Buffer.from(c, 'base64url').toString('utf8'); } catch { return null; }
};

type Keyed = { id?: unknown; recommendation_id?: unknown; integrationId?: unknown; provider?: unknown; at?: unknown; createdAt?: unknown; description?: unknown };
function defaultKey(x: unknown): string {
  const o = x as Keyed;
  const k = o.id ?? o.recommendation_id ?? o.integrationId ?? o.provider;
  if (k != null) return String(k);
  return JSON.stringify([o.at ?? o.createdAt ?? null, o.description ?? null]);
}

/**
 * Page an already-ordered list. `fromEnd` serves the newest items of an ascending list first (chat history):
 * each page is still returned in ascending order and the cursor walks backwards.
 */
export function paginate<T>(items: T[], input: PageInput = {}, opts: { key?: (t: T) => string; fromEnd?: boolean } = {}): Page<T> {
  const limit = Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const key = opts.key ?? defaultKey;
  const after = decodeCursor(input.cursor);
  if (opts.fromEnd) {
    let end = items.length;
    if (after != null) { const i = items.findIndex((t) => key(t) === after); end = i < 0 ? 0 : i; }
    const start = Math.max(0, end - limit);
    const data = items.slice(start, end);
    return { data, has_more: start > 0, next_cursor: start > 0 && data.length ? encodeCursor(key(data[0])) : null };
  }
  let start = 0;
  if (after != null) { const i = items.findIndex((t) => key(t) === after); start = i < 0 ? items.length : i + 1; }
  const data = items.slice(start, start + limit);
  const more = start + limit < items.length;
  return { data, has_more: more, next_cursor: more && data.length ? encodeCursor(key(data[data.length - 1])) : null };
}

/** Wrap a service result that already paginated in SQL ({ <field>: rows, has_more, next_cursor, ...extras }). */
export function envelope<K extends string, T, R extends { has_more: boolean; next_cursor: string | null } & Record<K, T[]>>(r: R, field: K): Page<T> & Omit<R, K> {
  const { [field]: data, ...rest } = r;
  return { ...(rest as Omit<R, K>), data: data as T[], has_more: r.has_more, next_cursor: r.next_cursor ? encodeCursor(r.next_cursor) : null };
}
