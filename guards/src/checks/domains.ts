import fs from 'node:fs';
import path from 'node:path';
import { DOMAIN_NAMES } from '@shop/core/domains';
import { defineCheck, fail, result, type Finding } from '../framework';
import { INSTALLED_DOMAINS } from '../lib/install-domains';
import { repoRoot } from '../lib/paths';

/**
 * A domain registers itself at import time, and `domains.gen.ts` is the one
 * place that imports every domain. This check keeps that true when a bundler
 * disagrees.
 *
 * esbuild removes a namespace import whose binding is never read
 * (`import * as cms from './cms/index'`), so under tsx and in the worker's tsup
 * bundle such a domain would silently not be installed — while Vitest (oxc) and
 * Next (SWC) keep it, so every test passes and the bundle is still wrong. The
 * generator therefore emits a bare side-effect import for every domain, and the
 * guards import each domain by name as well (`lib/install-domains.ts`), so they
 * never run on a half-installed system.
 *
 * Two assertions: the guards' own list covers exactly the declared domains, and
 * no domain in `domains.gen.ts` is reached only through an unused namespace
 * import.
 */

export const domains = defineCheck(
  'domains',
  'every domain in the generated bucket is really installed',
  () => {
    const findings: Finding[] = [];
    const declared = [...DOMAIN_NAMES].sort();
    const installed = [...INSTALLED_DOMAINS].sort();

    for (const name of declared) {
      if (!installed.includes(name)) {
        findings.push(
          fail(
            'guards/src/lib/install-domains.ts',
            `does not import @shop/core/${name}, which domains.gen.ts declares — the guards would run on a half-installed system`,
          ),
        );
      }
    }
    for (const name of installed) {
      if (!declared.includes(name)) {
        findings.push(
          fail(
            'guards/src/lib/install-domains.ts',
            `imports @shop/core/${name}, which is not a domain any more`,
          ),
        );
      }
    }

    const genFile = path.join(repoRoot, 'packages/core/src/domains.gen.ts');
    const gen = fs.existsSync(genFile) ? fs.readFileSync(genFile, 'utf8') : '';
    const namespaceOnly = [...gen.matchAll(/import \* as (\w+) from '\.\/(\w+)\/index';/g)]
      .map((m) => ({ binding: m[1] ?? '', domain: m[2] ?? '' }))
      .filter((entry) => !new RegExp(`\\b${entry.binding}\\.`).test(gen));

    for (const entry of namespaceOnly) {
      findings.push(
        fail(
          'packages/core/src/domains.gen.ts',
          `installs ${entry.domain} only through the unused namespace import \`${entry.binding}\`, which esbuild elides — the generator must emit a bare \`import './${entry.domain}/index';\` as well`,
        ),
      );
    }

    return result(
      'domains',
      'domain installation',
      `${declared.length} declared domains, ${installed.length} imported by name`,
      findings,
    );
  },
);
