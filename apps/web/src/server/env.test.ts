import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { envSchema, loadEnv, resetEnv } from './env';

/**
 * Process configuration: what `loadEnv()` accepts, and — for the one flag
 * that must never reach a shop — that no deploy template sets it.
 */

const REQUIRED = { DATABASE_URL: 'postgres://unused', REDIS_URL: 'redis://unused' };

afterEach(() => resetEnv());

describe('SHOP_FAKE_SMS', () => {
  it('is off unless set', () => {
    expect(envSchema.parse(REQUIRED).SHOP_FAKE_SMS).toBeUndefined();
  });

  it("accepts exactly '1', and '0' or empty as off", () => {
    expect(envSchema.parse({ ...REQUIRED, SHOP_FAKE_SMS: '1' }).SHOP_FAKE_SMS).toBe('1');
    expect(envSchema.parse({ ...REQUIRED, SHOP_FAKE_SMS: '0' }).SHOP_FAKE_SMS).toBe('0');
    // `SHOP_FAKE_SMS=` in a compose file, or `${SHOP_FAKE_SMS:-}`, is off.
    expect(envSchema.parse({ ...REQUIRED, SHOP_FAKE_SMS: '' }).SHOP_FAKE_SMS).toBe('');
  });

  it('refuses to boot on anything else, naming the variable', () => {
    // `true` / `yes` would read as "on" to a person and as "off" to a
    // `=== '1'` check; a process that cannot tell must not start.
    for (const value of ['true', 'yes', 'on', ' 1', '2']) {
      expect(envSchema.safeParse({ ...REQUIRED, SHOP_FAKE_SMS: value }).success).toBe(false);
    }
    expect(() => loadEnv({ ...REQUIRED, NODE_ENV: 'test', SHOP_FAKE_SMS: 'true' })).toThrow(
      /SHOP_FAKE_SMS/,
    );
  });
});

/**
 * The fake sender mints codes and never delivers them. On a real shop that is
 * an outage of every SMS sign-in, so the deploy bundle an operator copies must
 * not carry the switch at all — not even commented out, since uncommenting it
 * is one keystroke. The Dockerfiles are checked too: an `ENV` baked into the
 * image would be the same mistake one layer further down.
 */
describe('deploy templates never set SHOP_FAKE_SMS', () => {
  const repoRoot = path.resolve(import.meta.dirname, '../../../..');
  const roots = [path.join(repoRoot, 'deploy'), path.join(repoRoot, 'docker')];

  function filesUnder(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? filesUnder(full) : [full];
    });
  }

  const files = roots.flatMap(filesUnder);

  it('walks the real deploy bundle', () => {
    // A path mistake would make the next test vacuously green.
    const names = files.map((file) => path.relative(repoRoot, file));
    expect(names).toContain('deploy/compose.yml');
    expect(names).toContain('deploy/deployment.env.example');
    expect(names).toContain('docker/web.Dockerfile');
  });

  it('mentions the variable nowhere', () => {
    const offenders = files
      .filter((file) => fs.readFileSync(file, 'utf8').includes('SHOP_FAKE_SMS'))
      .map((file) => path.relative(repoRoot, file));
    expect(offenders).toEqual([]);
  });
});
