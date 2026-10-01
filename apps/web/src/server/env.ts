import { z } from 'zod';

/**
 * Process configuration.
 *
 * Only the things that must exist before the database is reachable live here —
 * connection strings, the deployment mode, the uploads root. *Everything else*
 * is typed application configuration in `config_values`, read through
 * `ctx.config.get(group)`. If you are tempted to add a business knob
 * to this file, it belongs in a config group instead.
 */

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),

  /** Absolute path of the uploads root the edge serves at `/uploads/`. */
  UPLOADS_DIR: z.string().default('/data/uploads'),
  UPLOADS_PUBLIC_PREFIX: z.string().default('/uploads'),

  /** Site origin, used for the CSRF `Origin` check and for absolute URLs. */
  APP_ORIGIN: z.string().default('http://localhost:3000'),
  /** Extra origins allowed to send cookie-auth mutations (a staging domain). */
  EXTRA_ALLOWED_ORIGINS: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean),
    ),

  LOG_LEVEL: z.string().default('info'),
  LOG_PRETTY: z.stringbool().default(false),

  /**
   * Validate every response against its contract before sending it. On in
   * dev/test (and in CI), off in production where it would cost latency for a
   * check the merge gate already performed.
   */
  VALIDATE_RESPONSES: z.stringbool().default(false),

  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  QUEUE_NAME: z.string().default('shop'),
  /** Commit sha, surfaced by `/api/v1/health`. */
  APP_VERSION: z.string().default('dev'),

  /**
   * The storefront H5 build's page for previewing a decor draft, as a URL
   * template: `{id}`, `{previewToken}` and `{kind}` are filled in. Set on a
   * dev or e2e stack that serves the Taro H5 build, e.g.
   * `http://localhost:10086/#/packages/page/index?id={id}&previewToken={previewToken}`.
   * Unset or empty (production): the editor's preview explains the
   * mini-program 体验版 instead of framing a page.
   */
  DECOR_PREVIEW_URL: z.string().optional(),

  /**
   * `'1'` swaps the SMS provider for the in-memory `fakeSmsSender()`:
   * a verification code is minted and stored in Redis exactly as usual, and is
   * never delivered. It exists for an out-of-process test server — the
   * storefront e2e suite reads the code back out of Redis — which cannot call
   * `registerSmsSender()` from inside the test the way an integration test does.
   *
   * An environment variable and not an `sms.provider` value on purpose: a shop
   * must never be able to pick "fake" from the console. Nothing under
   * `deploy/` may set it (`env.test.ts` checks), and the process logs a
   * `warn` at boot whenever it is on. Unset, `''` and `'0'` are off; anything
   * but those and `'1'` refuses to boot, rather than guessing what `true` meant.
   */
  SHOP_FAKE_SMS: z.enum(['', '0', '1']).optional(),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

/**
 * Parses and caches `process.env`. Throws a readable list of what is missing,
 * because a container that starts with half its configuration is worse than
 * one that refuses to start.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`环境变量配置有误：\n${problems}`);
  }
  cached = parsed.data;
  return cached;
}

/** Test helper. */
export function resetEnv(): void {
  cached = undefined;
}

export function isProduction(env: Env = loadEnv()): boolean {
  return env.NODE_ENV === 'production';
}
