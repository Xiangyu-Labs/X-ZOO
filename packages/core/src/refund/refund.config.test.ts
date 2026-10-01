import { describe, expect, it } from 'vitest';
import type { Ctx } from '../kernel/context';
import { isKnownPermission } from '../auth/permissions';
import { refundPermissions } from './permissions';
import { refundConfig, returnAddress, type RefundConfig } from './refund.config';

/**
 * The `refund` config group.
 *
 * The same two rules the `payment` and `wechat` groups are held to — no
 * transport-security switch, and every secret declared — restated here because
 * the boundary rule keeps each domain's tests inside its own domain, and
 * because "this group has no secrets" is a claim worth failing on the day
 * somebody adds one.
 */

const FORBIDDEN = /verif|ssl|tls|certificate_?authority|ca_?bundle|ca_?path|insecure|allow_?self/i;

describe('TLS-001 — no verification switch in `refund`', () => {
  it('has none in the schema', () => {
    expect(Object.keys(refundConfig.schema.shape).filter((key) => FORBIDDEN.test(key))).toEqual([]);
  });

  it('has none on the form', () => {
    expect(Object.keys(refundConfig.ui ?? {}).filter((key) => FORBIDDEN.test(key))).toEqual([]);
  });
});

describe('the 售后设置 group has atoms of its own', () => {
  it('is read with refund:config:read, so the config service derives refund:config:write', () => {
    // A `:write` atom here would collapse reading and writing onto one grant;
    // the request atoms (review, execute, the remark) must not rewrite the
    // address buyers post their returns to.
    expect(refundConfig.permission).toBe(refundPermissions['config:read']);
    expect(refundConfig.permission).toBe('refund:config:read');
    expect(isKnownPermission('refund:config:write')).toBe(true);
    expect(Object.values(refundPermissions)).toContain('refund:config:write');
  });

  it('shares no atom with the after-sale requests', () => {
    const requestAtoms = Object.values(refundPermissions).filter((atom) =>
      atom.startsWith('refund:request:'),
    );
    expect(requestAtoms).not.toContain(refundConfig.permission);
    expect(requestAtoms).not.toContain('refund:config:write');
  });
});

describe('secret fields', () => {
  it('declares none, because the group holds none', () => {
    // A return address is printed to the buyer; there is nothing here to hide.
    // If a future field *is* a secret it must be declared, and this test is
    // where that omission surfaces.
    const ui = (refundConfig.ui ?? {}) as Record<string, { secret?: boolean } | undefined>;
    expect(Object.keys(ui).filter((key) => ui[key]?.secret === true)).toEqual([]);
  });
});

/**
 * The jsonb round trip, from the refund side. A return phone is the field a
 * double parse would bite first — all digits, so it would come back as a number
 * and the whole return address would silently fall back to empty. `@shop/db`
 * parses once; the round trip is asserted against a real database in
 * `refund.int.test.ts`.
 */
describe('the schema is plain strings', () => {
  it('takes a return phone as the string it is', () => {
    expect(refundConfig.schema.parse({ returnPhone: '13800000000' }).returnPhone).toBe(
      '13800000000',
    );
  });

  it('still answers the defaults for an unconfigured shop', () => {
    const parsed = refundConfig.schema.parse({});
    expect(parsed.returnName).toBe('');
    expect(parsed.afterSaleDays).toBe(0);
  });
});

describe('returnAddress', () => {
  const ctxWith = (config: Partial<RefundConfig>): Ctx =>
    ({
      config: { get: async () => refundConfig.schema.parse(config) },
    }) as unknown as Ctx;

  const complete = {
    returnName: '售后部',
    returnPhone: '13800000000',
    returnAddress: '浙江省杭州市西湖区文一西路 1 号',
  };

  it('hands back the address once every part is configured', async () => {
    await expect(returnAddress(ctxWith(complete))).resolves.toEqual({
      name: complete.returnName,
      phone: complete.returnPhone,
      address: complete.returnAddress,
    });
  });

  it('is null — never half an address — when a part is missing', async () => {
    // A return label with a name and no street sends the parcel nowhere; an
    // empty panel at least tells the buyer to ask support.
    await expect(returnAddress(ctxWith({}))).resolves.toBeNull();
    await expect(returnAddress(ctxWith({ ...complete, returnAddress: '' }))).resolves.toBeNull();
    await expect(returnAddress(ctxWith({ ...complete, returnPhone: '' }))).resolves.toBeNull();
    await expect(returnAddress(ctxWith({ ...complete, returnName: '' }))).resolves.toBeNull();
  });
});
