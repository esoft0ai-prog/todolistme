/**
 * Object storage for hosted page files. R2/S3 when S3_ENDPOINT + S3_BUCKET are
 * set (credentials via the standard AWS_* env vars); otherwise files are kept
 * in the `stored_files` table so the product works with just a database.
 */
import { eq, like } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { storedFiles } from '../db/schema.js';
import { config } from './config.js';

export interface Storage {
  put(path: string, data: Buffer, contentType: string): Promise<void>;
  get(path: string): Promise<{ data: Buffer; contentType: string } | null>;
  removePrefix(prefix: string): Promise<void>;
}

function dbStorage(db: DB): Storage {
  return {
    async put(path, data, contentType) {
      await db.insert(storedFiles).values({ path, contentType, dataBase64: data.toString('base64') })
        .onConflictDoUpdate({ target: storedFiles.path, set: { contentType, dataBase64: data.toString('base64') } });
    },
    async get(path) {
      const [row] = await db.select().from(storedFiles).where(eq(storedFiles.path, path));
      return row ? { data: Buffer.from(row.dataBase64, 'base64'), contentType: row.contentType } : null;
    },
    async removePrefix(prefix) {
      await db.delete(storedFiles).where(like(storedFiles.path, `${prefix.replace(/[%_]/g, '\\$&')}%`));
    },
  };
}

async function s3Storage(): Promise<Storage> {
  const s3 = await import('@aws-sdk/client-s3');
  const client = new s3.S3Client({
    endpoint: config.s3Endpoint, region: config.s3Region,
    ...(config.s3AccessKey ? { credentials: { accessKeyId: config.s3AccessKey, secretAccessKey: config.s3SecretKey } } : {}),
  });
  const Bucket = config.s3Bucket;
  return {
    async put(Key, Body, ContentType) { await client.send(new s3.PutObjectCommand({ Bucket, Key, Body, ContentType })); },
    async get(Key) {
      try {
        const r = await client.send(new s3.GetObjectCommand({ Bucket, Key }));
        const bytes = await r.Body!.transformToByteArray();
        return { data: Buffer.from(bytes), contentType: r.ContentType ?? 'application/octet-stream' };
      } catch { return null; }
    },
    async removePrefix(Prefix) {
      const list = await client.send(new s3.ListObjectsV2Command({ Bucket, Prefix }));
      const Objects = (list.Contents ?? []).map((o) => ({ Key: o.Key! }));
      if (Objects.length) await client.send(new s3.DeleteObjectsCommand({ Bucket, Delete: { Objects } }));
    },
  };
}

let s3: Promise<Storage> | null = null;
export function storageFor(db: DB): Promise<Storage> {
  if (config.s3Endpoint && config.s3Bucket) return (s3 ??= s3Storage());
  return Promise.resolve(dbStorage(db));
}

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8', json: 'application/json', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg',
  jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon', woff: 'font/woff',
  woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', txt: 'text/plain; charset=utf-8', xml: 'application/xml',
  webmanifest: 'application/manifest+json', mp4: 'video/mp4', webm: 'video/webm', pdf: 'application/pdf',
};
export const contentTypeFor = (file: string) => TYPES[file.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';
