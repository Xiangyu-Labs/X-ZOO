import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, it } from 'vitest';
import { boundariesPlugin } from '../eslint/boundaries.js';

/**
 * The import-boundary rules are the only mechanical enforcement of the
 * "Import boundaries" section of `docs/conventions.md`. Every package bumps
 * into them, so a false positive is expensive and a false negative lets the
 * architecture rot quietly. Both directions are tested.
 */

const tester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    ecmaVersion: 2023,
    sourceType: 'module',
  },
});

const CORE = '/repo/packages/core/src';

describe('boundaries/no-restricted-source', () => {
  it('denies and allows the right sources', () => {
    tester.run('no-restricted-source', boundariesPlugin.rules['no-restricted-source'], {
      valid: [
        // Nothing configured: the rule is inert.
        { code: "import x from 'react';", filename: `${CORE}/order/a.ts` },
        // A source that does not match the pattern.
        {
          code: "import x from 'drizzle-orm';",
          filename: `${CORE}/order/a.ts`,
          options: [{ deny: [{ source: '^react$', message: 'no react' }] }],
        },
        // `exceptFrom` exempts this file.
        {
          code: "import { orders } from '@shop/db/schema/order';",
          filename: `${CORE}/order/order.repo.ts`,
          options: [
            {
              deny: [
                { source: '^@shop/db/schema/', exceptFrom: '\\.repo\\.ts$', message: 'repo only' },
              ],
            },
          ],
        },
        // `from` scopes the rule to other files.
        {
          code: "import x from 'react';",
          filename: `${CORE}/order/a.ts`,
          options: [{ deny: [{ source: '^react$', from: '/apps/web/', message: 'not here' }] }],
        },
      ],
      invalid: [
        {
          code: "import x from 'react';",
          filename: `${CORE}/order/a.ts`,
          options: [{ deny: [{ source: '^(react|next)$', message: 'core 不得依赖 react' }] }],
          errors: [{ messageId: 'denied' }],
        },
        {
          code: "import { orders } from '@shop/db/schema/order';",
          filename: `${CORE}/order/order.service.ts`,
          options: [
            {
              deny: [
                { source: '^@shop/db/schema/', exceptFrom: '\\.repo\\.ts$', message: 'repo only' },
              ],
            },
          ],
          errors: 1,
        },
        // Re-exports and dynamic imports are import edges too.
        {
          code: "export { a } from 'react';",
          filename: `${CORE}/order/a.ts`,
          options: [{ deny: [{ source: '^react$', message: 'no' }] }],
          errors: 1,
        },
        {
          code: "export * from 'react';",
          filename: `${CORE}/order/a.ts`,
          options: [{ deny: [{ source: '^react$', message: 'no' }] }],
          errors: 1,
        },
        {
          code: "const x = await import('react');",
          filename: `${CORE}/order/a.ts`,
          options: [{ deny: [{ source: '^react$', message: 'no' }] }],
          errors: 1,
        },
      ],
    });
  });
});

describe('boundaries/core-cross-domain', () => {
  it('allows the index, ports and kernel, and refuses reaching in', () => {
    tester.run('core-cross-domain', boundariesPlugin.rules['core-cross-domain'], {
      valid: [
        // Inside your own domain, anything goes.
        { code: "import x from './order.repo';", filename: `${CORE}/order/order.service.ts` },
        { code: "import x from './pricing/apply';", filename: `${CORE}/order/order.service.ts` },
        // Another domain's public index.
        { code: "import x from '../catalog';", filename: `${CORE}/order/order.service.ts` },
        { code: "import x from '../catalog/index';", filename: `${CORE}/order/order.service.ts` },
        // The frozen cross-domain seam.
        { code: "import x from '../order/ports';", filename: `${CORE}/coupon/coupon.service.ts` },
        // The shared kernel.
        { code: "import x from '../kernel/money';", filename: `${CORE}/order/order.service.ts` },
        { code: "import x from '../effects';", filename: `${CORE}/order/order.service.ts` },
        // Package-name imports are governed by the other rule, not this one.
        { code: "import x from '@shop/db';", filename: `${CORE}/order/order.service.ts` },
        // Outside packages/core the rule does not apply.
        {
          code: "import x from '../catalog/catalog.repo';",
          filename: '/repo/next/apps/web/src/a.ts',
        },
      ],
      invalid: [
        {
          code: "import x from '../catalog/catalog.repo';",
          filename: `${CORE}/order/order.service.ts`,
          errors: [{ messageId: 'reachIn' }],
        },
        {
          code: "import x from '../catalog/product.service';",
          filename: `${CORE}/order/order.service.ts`,
          errors: 1,
        },
        // Deeper reach-in.
        {
          code: "import x from '../../core/src/catalog/catalog.repo';",
          filename: `${CORE}/order/nested/thing.ts`,
          errors: 1,
        },
        // `order/ports` is the seam; `order/order.repo` is not.
        {
          code: "import x from '../order/order.repo';",
          filename: `${CORE}/coupon/coupon.service.ts`,
          errors: 1,
        },
        {
          code: "export * from '../catalog/catalog.repo';",
          filename: `${CORE}/order/order.service.ts`,
          errors: 1,
        },
      ],
    });
  });
});
