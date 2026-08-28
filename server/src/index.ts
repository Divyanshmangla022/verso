import { createApp } from './app.ts';
import { config } from './config.ts';
import { closeDb, connectDb } from './db.ts';
import { geminiAvailable } from './ai/engine.ts';

async function main(): Promise<void> {
  await connectDb();
  const app = createApp();
  const server = app.listen(config.port, () => {
    console.log(`Verso API listening on http://localhost:${config.port}`);
  });
  console.log(`AI engine: ${(await geminiAvailable()) ? `gemini (${config.geminiModel})` : 'heuristic fallback (set GEMINI_API_KEY for full AI)'}`);

  const shutdown = async (signal: string) => {
    console.log(`${signal} received, shutting down`);
    server.close();
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
