/**
 * BullMQ worker process (Docker / DokPloy deployments with DRAGONFLY_URL or REDIS_URL set).
 * One Worker per ADL queue, plus the periodic cron sweeps every minute.
 */
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { getDatabase } from './db/client.js';
import { config } from './lib/config.js';
import { bindDatabase, QUEUES, runJob, runSweeps, type JobName } from './jobs/scheduler.js';

if (!config.redisUrl) {
  console.error('DRAGONFLY_URL (or REDIS_URL) is required for the worker process.');
  process.exit(1);
}

const { db } = await getDatabase();
bindDatabase(db);
const connection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });

/** Heavy or rate-limited queues run with low concurrency; notification/timer queues fan out. */
const CONCURRENCY: Partial<Record<JobName, number>> = {
  'retrospective-generation': 1, 'deployment-processing': 2, 'ai-intelligence': 2, 'cross-tool-sla-check': 1,
  'sla-timers': 8, 'telegram-notifications': 8,
};

for (const name of QUEUES) {
  const w = new Worker(name, async (job) => runJob(db, name, job.data), { connection, concurrency: CONCURRENCY[name] ?? 4 });
  w.on('failed', (job, err) => console.error(`[worker] ${name} job ${job?.id} failed:`, err.message));
}
setInterval(() => void runSweeps(db), 60_000);
void runSweeps(db);
console.info(`[worker] Camplo worker running ${QUEUES.length} queues`);
