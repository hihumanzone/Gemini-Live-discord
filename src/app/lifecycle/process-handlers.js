/**
 * @param {{
 *   gracefulShutdown: (reason: string, exitCode?: number) => Promise<void>,
 *   logFatal: (error: Error, context?: Record<string, unknown>) => void,
 * }} deps
 */
export function registerProcessHandlers({ gracefulShutdown, logFatal }) {
  process.on('SIGINT', async () => {
    await gracefulShutdown('SIGINT', 0);
  });

  process.on('SIGTERM', async () => {
    await gracefulShutdown('SIGTERM', 0);
  });

  process.on('unhandledRejection', async (reason) => {
    logFatal(reason instanceof Error ? reason : new Error(String(reason)), {
      event: 'unhandledRejection',
    });
    await gracefulShutdown('unhandledRejection', 1);
  });

  process.on('uncaughtException', async (error) => {
    logFatal(error, { event: 'uncaughtException' });
    await gracefulShutdown('uncaughtException', 1);
  });
}
