import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { createLogger, format, transports } from 'winston';
import type { Logger } from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import debugFactory from 'debug';

export interface LoggerOptions {
  serviceName?: string;
  level?: string;
  logDirectory?: string;
}

export interface LoggerBundle {
  logger: Logger;
  debug: debugFactory.Debugger;
}

export function initializeLogger(options: LoggerOptions = {}): LoggerBundle {
  const serviceName = options.serviceName ?? 'aiembodied';
  const logDirectory = ensureLogDirectory(options.logDirectory ?? resolveDefaultLogDirectory(serviceName));

  const logger = createLogger({
    level: options.level ?? (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
    format: format.combine(format.timestamp(), format.errors({ stack: true }), format.json()),
    defaultMeta: { service: serviceName },
    transports: [
      new transports.Console({
        format: format.combine(
          format.colorize(),
          format.printf(({ level, message, timestamp, stack, ...meta }) => {
            const ts = typeof timestamp === 'string' ? timestamp : String(timestamp ?? '');
            const msg = typeof message === 'string' ? message : String(message ?? '');
            const base = `${ts} [${level}] ${msg}`;
            const metaString = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
            if (typeof stack === 'string') {
              return `${base}\n${stack}`;
            }
            return `${base}${metaString}`;
          }),
        ),
      }),
      new DailyRotateFile({
        dirname: logDirectory,
        filename: '%DATE%.log',
        maxFiles: '14d',
        maxSize: '20m',
        zippedArchive: true,
      }),
    ],
    exceptionHandlers: [
      new transports.Console(),
      new DailyRotateFile({
        dirname: logDirectory,
        filename: '%DATE%.exceptions.log',
        maxFiles: '30d',
        zippedArchive: true,
      }),
    ],
    rejectionHandlers: [
      new transports.Console(),
      new DailyRotateFile({
        dirname: logDirectory,
        filename: '%DATE%.rejections.log',
        maxFiles: '30d',
        zippedArchive: true,
      }),
    ],
  });

  const debug = debugFactory(`${serviceName}:main`);
  debug.log = (...args: unknown[]) => {
    const first = args[0];
    const message = typeof first === 'string' ? first : String(first ?? '');
    const rest = args.slice(1);
    logger.debug(message, ...rest);
  };

  return { logger, debug };
}

function resolveDefaultLogDirectory(serviceName: string): string {
  try {
    if (app.isReady()) {
      return path.join(app.getPath('logs'), serviceName);
    }

    return path.join(app.getPath('userData'), 'logs', serviceName);
  } catch {
    return path.join(process.cwd(), 'logs', serviceName);
  }
}

function ensureLogDirectory(directory: string): string {
  try {
    fs.mkdirSync(directory, { recursive: true });
  } catch {
    // ignore directory creation errors and rely on transport defaults
  }
  return directory;
}
