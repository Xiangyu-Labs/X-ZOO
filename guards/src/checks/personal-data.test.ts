import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { judge, personalData, sensitiveFields } from './personal-data';

/** A whole-tree scan: seconds on a CI runner, far past the 5 s unit default. */
const WHOLE_TREE_MS = 60_000;

/** The `personal-data` walk and verdict over small contracts, then over the tree. */

const route = (id: string, auth: string, response: z.ZodType) => ({ id, auth, response });

const verdict = (routes: ReturnType<typeof route>[]) =>
  judge(sensitiveFields(routes)).findings.map((f) => `${f.where}: ${f.message.split(' — ')[0]}`);

describe('personal data in responses', () => {
  it('GUARD-004 — fails a credential in any response, admin included', () => {
    expect(
      verdict([
        route('system.adminDetail', 'admin', z.object({ passwordHash: z.string() })),
        route('user.getProfile', 'user', z.object({ wx: z.object({ openid: z.string() }) })),
      ]),
    ).toEqual([
      'system.adminDetail: response.passwordHash carries passwordHash as text',
      'user.getProfile: response.wx.openid carries openid as text',
    ]);
  });

  it('GUARD-004 — fails somebody else’s phone on a storefront route', () => {
    const team = z.object({
      members: z.array(z.object({ nickname: z.string(), phone: z.string().nullable() })),
    });
    expect(verdict([route('groupbuy.teamDetail', 'user-optional', team)])).toEqual([
      "groupbuy.teamDetail: response.members.[].phone is personal data (phone) on a 'user-optional' route that is not the shopper’s own record or the shop’s",
    ]);
  });

  it('passes staff reading personal data, the shopper’s own record and boolean flags', () => {
    expect(
      verdict([
        route('user.adminDetail', 'admin', z.object({ phone: z.string(), realName: z.string() })),
        route('user.getProfile', 'user', z.object({ phone: z.string().nullable() })),
        route('user.updateProfile', 'user', z.object({ hasPassword: z.boolean() })),
      ]),
    ).toEqual([]);
  });
});

describe('personal-data over the tree', () => {
  it(
    'GUARD-004 — no response carries a credential or another person’s data unexplained',
    { timeout: WHOLE_TREE_MS },
    async () => {
      const failures = (await personalData.run()).findings.filter((f) => f.level === 'fail');
      expect(failures.map((f) => `${f.where}: ${f.message}`).join('\n')).toBe('');
    },
  );
});
