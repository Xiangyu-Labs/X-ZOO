import { z } from 'zod';

/** Worker process configuration. Business knobs live in `config_values`. */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  QUEUE_NAME: z.string().default('shop'),
  UPLOADS_DIR: z.string().default('/data/uploads'),
  UPLOADS_PUBLIC_PREFIX: z.string().default('/uploads'),
  LOG_LEVEL: z.string().default('info'),
  LOG_PRETTY: z.stringbool().default(false),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(50).default(5),
  /** Default per-job concurrency when a job does not set its own. */
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
  /** How often the liveness key is refreshed, and its TTL multiplier. */
  HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(1000).default(15_000),
  /** Seconds a shutdown waits for in-flight jobs before giving up. */
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1000).default(25_000),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`worker 环境变量配置有误：\n${problems}`);
  }
  return parsed.data;
}

export const HEARTBEAT_KEY = 'worker:heartbeat';
