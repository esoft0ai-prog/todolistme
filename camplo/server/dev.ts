/** Local server: `npm run dev`. Uses DATABASE_URL, or embedded PGlite (PGLITE_DIR to persist). */
import { createApp } from './app.js';
import { getDatabase } from './db/client.js';

const port = Number(process.env.PORT ?? 4173);
const { kind } = await getDatabase();
createApp().listen(port, () => console.info(`Camplo on http://localhost:${port} (database: ${kind})`));
