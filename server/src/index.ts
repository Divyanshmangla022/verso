import { createApp } from './app.ts';
import { config } from './config.ts';
import { closeDb, connectDb } from './db.ts';
import { geminiAvailable } from './ai/engine.ts';

/** Time in-flight requests get to finish on SIGTERM (Render's default window is 30 s). */
const SHUTDOWN_GRACE_MS = 10_000;

async function main(): Promise<void> {
  await connectDb();
  const app = createApp();
  const server = app.listen(config.port, () => {
    console.log(`Verso API listening on http://localhost:${config.port}`);
  });
  console.log(`AI engine: ${(await geminiAvailable()) ? `gemini (${config.geminiModel})` : 'heuristic fallback (set GEMINI_API_KEY for full AI)'}`);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received, shutting down`);
    // Stop accepting work, then wait for in-flight requests to finish before
    // closing the database - a save that has committed must still be able to
    // write its history row. Long-lived AI streams are cut after the grace
    // period so shutdown always completes inside the platform's SIGTERM window.
    await new Promise<void>((resolve) => {
      const forceAfter = setTimeout(() => {
        console.warn('Shutdown grace period expired; closing remaining connections');
        server.closeAllConnections();
      }, SHUTDOWN_GRACE_MS);
      server.close(() => {
        clearTimeout(forceAfter);
        resolve();
      });
    });
    await closeDb();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
