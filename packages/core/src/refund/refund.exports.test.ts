import { describe, expect, it } from 'vitest';
import * as refund from './index';

/**
 * `detail` answers any after-sale by id with no ownership check; inside the
 * domain every caller checks first. Outside, the storefront has `myDetail` and
 * the admin `adminDetail`, so the unchecked one must not be on the public
 * surface for the next route to pick from.
 */
describe('the refund domain’s public surface', () => {
  it('does not export the unchecked detail read', () => {
    expect(Object.keys(refund)).not.toContain('detail');
    expect(Object.keys(refund)).toEqual(expect.arrayContaining(['myDetail', 'adminDetail']));
  });
});
