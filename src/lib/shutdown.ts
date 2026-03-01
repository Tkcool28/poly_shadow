import { prisma } from './prisma';
import { logger } from './logger';

let shuttingDown = false;

export function isShuttingDown(): boolean {
  return shuttingDown;
}

export function setupGracefulShutdown(jobName: string): void {
  const handler = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal}, shutting down gracefully...`, { job: jobName });
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGTERM', () => handler('SIGTERM'));
  process.on('SIGINT', () => handler('SIGINT'));
}

export function setupJobTimeout(jobName: string, timeoutMs: number): void {
  setTimeout(() => {
    logger.warn(`Job ${jobName} exceeded max runtime of ${timeoutMs}ms, forcing exit`, {
      job: jobName,
    });
    process.exit(1);
  }, timeoutMs).unref();
}
