import { pino, type Logger as PinoLogger } from 'pino';

/**
 * Structured logging. The redaction list is not optional decoration: a logged
 * request body carries whatever the client sent, and `docs/conventions.md`
 * forbids "logging secrets or tokens". Anything that smells like a credential
 * is replaced before it is serialised, at every nesting depth we actually
 * produce.
 */

export type Logger = PinoLogger;

const SECRET_KEYS = [
  'password',
  'passwordHash',
  'password_hash',
  'oldPassword',
  'newPassword',
  'token',
  'tokenHash',
  'accessToken',
  'refreshToken',
  'sessionToken',
  'authorization',
  'cookie',
  'setCookie',
  'apiKey',
  'appSecret',
  'mchKey',
  'privateKey',
  'apiV3Key',
  'secret',
  'captchaToken',
  'code',
];

/** `password`, `*.password`, `*.*.password`, plus the header spellings. */
const REDACT_PATHS = [
  ...SECRET_KEYS,
  ...SECRET_KEYS.map((k) => `*.${k}`),
  ...SECRET_KEYS.map((k) => `*.*.${k}`),
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
];

export interface LoggerOptions {
  level?: string;
  /** Human-readable output in dev; JSON everywhere else. */
  pretty?: boolean;
  base?: Record<string, unknown>;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const { level = process.env.LOG_LEVEL ?? 'info', pretty = false, base = {} } = options;
  return pino({
    level,
    base: { ...base },
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    formatters: { level: (label) => ({ level: label }) },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(pretty ? { transport: { target: 'pino-pretty', options: { colorize: true } } } : {}),
  });
}

/** Swallows everything. The default in unit tests. */
export function silentLogger(): Logger {
  return pino({ level: 'silent' });
}

/** The keys this module redacts, exported so a test can assert on the list. */
export const redactedKeys: readonly string[] = SECRET_KEYS;
