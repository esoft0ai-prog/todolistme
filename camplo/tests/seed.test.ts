import { describe, expect, it } from 'vitest';
import { createDatabase } from '../server/db/client.js';
import { seedIfEmpty } from '../server/db/seed.js';
import { deployments, leads, users } from '../server/db/schema.js';

describe('deterministic demo seed', () => {
  it('two fresh embedded databases get identical ids and tokens, so sessions work across instances', async () => {
    const snap = async () => {
      const d = await createDatabase({ pgliteDir: '' });
      await seedIfEmpty(d.db, { deterministic: true });
      const out = {
        users: (await d.db.select({ id: users.id }).from(users).orderBy(users.email)).map((r) => r.id),
        leads: (await d.db.select({ id: leads.id }).from(leads).orderBy(leads.sourceIdentifier)).map((r) => r.id),
        pages: (await d.db.select({ id: deployments.id, sub: deployments.subdomain }).from(deployments).orderBy(deployments.name)),
      };
      await d.close();
      return out;
    };
    const [a, b] = [await snap(), await snap()];
    expect(a.users.length).toBeGreaterThan(0);
    expect(b).toEqual(a);
    for (const id of a.users) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  }, 60_000);
});
