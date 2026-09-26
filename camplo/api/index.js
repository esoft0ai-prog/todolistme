// Vercel serverless entry: every non-static request (API, SSE, hosted /sites/*) is handled by the Express app.
// The server is compiled to dist/ by `npm run vercel-build` (tsc) before this function is bundled.
import { createApp } from '../dist/server/app.js';

export default createApp();
