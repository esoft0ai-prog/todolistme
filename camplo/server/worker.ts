/**
 * BullMQ worker process (Docker/DokPloy deployments with REDIS_URL set).
 * Processes queued jobs and runs the periodic sweeps every minute.
 */
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { getDatabase } from './db/client.js';
import { config } from './lib/config.js';
import { bindDatabase, runJob, runSweeps, type JobName } from './jobs/scheduler.js';

if (!config.redisUrl) {
  console.error('REDIS_URL is required for the worker process.');
  process.exit(1);
}

const { db } = await getDatabase();
bindDatabase(db);
const connection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });

new Worker('camplo', async (job) => runJob(db, job.name as JobName, job.data), { connection, concurrency: 4 });
setInterval(() => void runSweeps(db), 60_000);
void runSweeps(db);
console.info('[worker] Camplo worker running');
