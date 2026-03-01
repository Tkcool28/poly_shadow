import winston from 'winston';
import path from 'path';
import { config } from '../config/env';

const logDir = path.resolve(process.cwd(), 'logs');

export const logger = winston.createLogger({
  level: config.LOG_LEVEL,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'polymarket-copytrade' },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message, service, job, ...rest }) => {
          const jobTag = job ? `[${job}]` : '';
          const extra = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : '';
          return `${timestamp} ${level} ${jobTag} ${message}${extra}`;
        })
      ),
    }),
    new winston.transports.File({
      filename: path.join(logDir, 'error.log'),
      level: 'error',
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 5,
    }),
    new winston.transports.File({
      filename: path.join(logDir, 'combined.log'),
      maxsize: 10 * 1024 * 1024,
      maxFiles: 10,
    }),
  ],
});

export function createJobLogger(jobName: string) {
  return logger.child({ job: jobName });
}
