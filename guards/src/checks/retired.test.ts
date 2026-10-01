import { describe, expect, it } from 'vitest';
import { retiredFeatures } from './retired';

/**
 * CORE-002 in `docs/invariants.md`.
 *
 * A URL with no route file answers 404 by construction, so the 404 is not the
 * property worth testing — what can go wrong is a feature the shop does not
 * have arriving anyway: an identifier or a URL token that brings in 砍价, 秒杀,
 * 分销, 积分 or the rest. That is what this asserts, on every commit, over the
 * application source and the mini-program (with api-client and storefront-blocks).
 */

const findings = (await retiredFeatures.run()).findings;

describe('the retired blacklist', () => {
  it('finds no retired identifier in the workspace or the mini-program', () => {
    const failures = findings.filter((f) => f.level === 'fail');
    expect(failures.map((f) => `${f.where}: ${f.message}`).join('\n')).toBe('');
  });
});
