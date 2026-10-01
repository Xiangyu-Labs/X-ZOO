import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { allConfigGroups } from './kernel/config-registry';
import { getEffectHandler } from './effects';
import { peekCatalogPort } from './order';
import { getOrderFacts, getOrderStateMachine, getPaymentPort, getStockPort } from './order/ports';
import { CONFIG_GROUP_FILES } from './config-groups.gen';
import { DOMAIN_NAMES, registerAllDomains } from './domains.gen';

/**
 * The two gen'd buckets, against the directory they are generated from.
 *
 * Both exist because registration is a side effect of a module being imported,
 * which fails in the direction nobody checks: forget an import and the config
 * group is simply not on the settings index, or the port is simply not
 * registered, with no error anywhere — a new domain's config group or registrar
 * would simply be missing.
 *
 * So these tests read `src/` itself rather than trusting the generated lists.
 * A stale bucket is a failing test, not a missing screen.
 */

const srcDir = import.meta.dirname;

async function domainDirs(): Promise<string[]> {
  const entries = await readdir(srcDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

async function configFilesOnDisk(): Promise<string[]> {
  const found: string[] = [];
  for (const dir of await domainDirs()) {
    for (const file of await readdir(path.join(srcDir, dir))) {
      if (file.endsWith('.config.ts')) found.push(`${dir}/${file}`);
    }
  }
  return found.sort();
}

describe('config-groups.gen.ts', () => {
  it('lists every *.config.ts under src/<domain>/', async () => {
    expect([...CONFIG_GROUP_FILES]).toEqual(await configFilesOnDisk());
  });

  it('registers every one of them', async () => {
    // Importing the bucket is what fills the registry, so by this point every
    // group must be there. The count is checked too: a file that declares no
    // group would pass a "contains" check and still be dead.
    const registered = new Set(allConfigGroups().map((group) => group.group));
    const files = await configFilesOnDisk();
    const missing: string[] = [];
    for (const file of files) {
      const source = await readFile(path.join(srcDir, file), 'utf8');
      for (const [, group] of source.matchAll(/\bgroup:\s*'([a-z][a-z0-9-]{1,31})'/g)) {
        if (!registered.has(group!)) missing.push(`${file} → ${group}`);
      }
    }
    expect(missing).toEqual([]);
    expect(registered.size).toBeGreaterThanOrEqual(files.length);
  });

  it('never lets two files declare the same group name', async () => {
    // `defineConfigGroup` throws on a duplicate but only names the group; the
    // useful half is which two files are fighting over it, so this says both.
    // `pnpm gen` refuses for the same reason, before anything is typechecked.
    const declaredBy = new Map<string, string>();
    const clashes: string[] = [];
    for (const file of await configFilesOnDisk()) {
      const source = await readFile(path.join(srcDir, file), 'utf8');
      for (const [, group] of source.matchAll(/\bgroup:\s*'([a-z][a-z0-9-]{1,31})'/g)) {
        const first = declaredBy.get(group!);
        if (first !== undefined) clashes.push(`config group "${group}": ${first} 与 ${file}`);
        else declaredBy.set(group!, file);
      }
    }
    expect(clashes).toEqual([]);
  });
});

describe('domains.gen.ts', () => {
  it('lists every src/<domain>/ that has an index.ts, except the kernel', async () => {
    const expected: string[] = [];
    for (const dir of await domainDirs()) {
      if (dir === 'kernel') continue;
      const files = await readdir(path.join(srcDir, dir));
      if (files.includes('index.ts')) expected.push(dir);
    }
    expect([...DOMAIN_NAMES]).toEqual(expected);
  });

  it('calls every exported register<Name>Domain()', async () => {
    const expected: string[] = [];
    for (const name of DOMAIN_NAMES) {
      const source = await readFile(path.join(srcDir, name, 'index.ts'), 'utf8');
      for (const [, fn] of source.matchAll(/^export function (register[A-Z]\w*Domain)\s*\(/gm)) {
        expected.push(`${name}.${fn}`);
      }
    }
    const generated = await readFile(path.join(srcDir, 'domains.gen.ts'), 'utf8');
    const imported = new Map<string, string>();
    for (const [, fns, name] of generated.matchAll(
      /^import \{ ([^}]+) \} from '\.\/([\w-]+)\/index';$/gm,
    )) {
      for (const fn of fns!.split(',')) imported.set(fn.trim(), name!);
    }
    const called = [...generated.matchAll(/^ {2}(register\w+Domain)\(\);$/gm)].map(
      ([, fn]) => `${imported.get(fn!) ?? '?'}.${fn}`,
    );
    expect(called.sort()).toEqual(expected.sort());
  });

  it('imports every domain for its side effects with a bare import', async () => {
    // A namespace import that is never read is elided by esbuild / tsx, which
    // silently dropped every domain that registers on import (found by J).
    const generated = await readFile(path.join(srcDir, 'domains.gen.ts'), 'utf8');
    for (const name of DOMAIN_NAMES) {
      expect(generated).toContain(`import './${name}/index';`);
    }
    expect(generated).not.toMatch(/^import \* as /m);
  });

  it('installs the ports importing one domain would not', () => {
    // A Next route imports only the domain it serves, so without the bucket the
    // checkout would find no catalog port and `refund.execute` would be parked
    // as `unknown` by the first dispatcher pass after boot.
    expect(peekCatalogPort()).toBeDefined();
    expect(() => getStockPort()).not.toThrow();
    expect(() => getPaymentPort()).not.toThrow();
    expect(() => getOrderFacts()).not.toThrow();
    expect(() => getOrderStateMachine()).not.toThrow();
  });

  it('installs the effect handlers the dispatcher would otherwise park', () => {
    // `dispatchEffectsOnce` settles an effect it has no handler for as
    // `unknown`, permanently, and there is no un-park. `refund.execute` is the
    // one that moves money.
    expect(getEffectHandler('refund', 'refund.execute')).toBeDefined();
    expect(getEffectHandler('payment', 'payment.exception.refund')).toBeDefined();
  });

  it('is idempotent, so calling it twice is harmless', () => {
    expect(() => {
      registerAllDomains();
      registerAllDomains();
    }).not.toThrow();
    expect(() => getPaymentPort()).not.toThrow();
  });
});
