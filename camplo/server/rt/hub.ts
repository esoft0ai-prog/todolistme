/**
 * Real-time hub for the 8 SSE channels (Build Spec "Real-Time Subscriptions").
 * In-process EventEmitter; when REDIS_URL is set, events are bridged through
 * Redis pub/sub so every server instance (and the BullMQ worker) sees them.
 *
 * Channel names (always tenant-scoped internally):
 *   workspace:leads · workspace:sla · workspace:insights · workspace:overdue-count
 *   lead:<id>:status · lead:<id>:timer · page:<id>:webhook · campaign:<id>:health
 */
import { EventEmitter } from 'node:events';
import { config } from '../lib/config.js';

type Payload = Record<string, unknown>;
const bus = new EventEmitter();
bus.setMaxListeners(0);

let pub: { publish(ch: string, msg: string): unknown } | null = null;
let bridged = false;

async function bridge() {
  if (bridged || !config.redisUrl) return;
  bridged = true;
  const { Redis } = await import('ioredis');
  pub = new Redis(config.redisUrl);
  const sub = new Redis(config.redisUrl);
  await sub.subscribe('camplo:rt');
  sub.on('message', (_ch, msg) => {
    const { key, payload } = JSON.parse(msg) as { key: string; payload: Payload };
    bus.emit(key, payload);
  });
}

const keyOf = (tenantId: string, channel: string) => `${tenantId}|${channel}`;

export function emit(tenantId: string, channel: string, payload: Payload = {}): void {
  const key = keyOf(tenantId, channel);
  if (config.redisUrl) {
    void bridge().then(() => pub?.publish('camplo:rt', JSON.stringify({ key, payload })));
  } else {
    bus.emit(key, payload);
  }
}

export function subscribe(tenantId: string, channel: string, fn: (p: Payload) => void): () => void {
  void bridge();
  const key = keyOf(tenantId, channel);
  bus.on(key, fn);
  return () => { bus.off(key, fn); };
}
