import {
  createCtx,
  fixedClock,
  memoryQueue,
  memoryStorage,
  silentLogger,
  systemActor,
  type Ctx,
} from '../kernel/index';
import { describe, expect, it, beforeEach } from 'vitest';
import { allConfigGroups, getConfigGroup } from '../kernel/config-registry';
import { isKnownPermission } from '../auth/permissions';
import { permissionTree } from './role.service';
import { describeGroup } from './config.service';
import { isTrustedHost, publicOrigin, siteConfig } from './site.config';
import type { z } from 'zod';
import {
  countTile,
  dashboardHeader,
  registerDashboardContributor,
  resetDashboardContributors,
} from './dashboard';
// The gen'd domain bucket, which is what `handle.ts` imports: it registers
// every permission atom, config group and dashboard contributor there is, as a
// side effect. Importing `./index` alone would quietly test a half-loaded
// registry — and these sweeps are only worth anything over the whole of it.
import '../domains.gen';

/**
 * The parts of `system` that are pure: the descriptor a settings screen is
 * built from, the permission tree the role editor renders, and the dashboard
 * registry's failure behaviour. Everything that touches the database is in
 * `system.int.test.ts`.
 */

/** A `Ctx` for code that only reads the clock, the logger and the actor. */
function pureCtx(overrides: Partial<Ctx> = {}): Ctx {
  return createCtx({
    db: null as unknown as Ctx['db'],
    redis: null as unknown as Ctx['redis'],
    clock: fixedClock('2026-09-22T00:00:00.000Z'),
    config: null as unknown as Ctx['config'],
    logger: silentLogger(),
    queue: memoryQueue(),
    storage: memoryStorage(),
    actor: systemActor,
    platform: null,
    requestId: 'test',
    ...overrides,
  });
}

type SiteConfig = z.input<typeof siteConfig.schema>;

/** A `Ctx` whose `config.get` answers with one fixed `site` group. */
function siteCtx(values: Partial<SiteConfig>): Ctx {
  const site = siteConfig.schema.parse(values);
  return pureCtx({
    config: {
      async get() {
        return site as never;
      },
      async getIn() {
        return site as never;
      },
      async getRaw() {
        return { ...site };
      },
      async set() {
        throw new Error('not used');
      },
      async invalidate() {},
    },
  });
}

describe('the public origin', () => {
  /**
   * Both fields are present in the descriptor and `readOnly`, because hiding
   * them would be the worse half of the trade: an operator whose WeChat links
   * point at `http://localhost` has to be able to see which host the shop
   * thinks it is before they can go and fix the variable that says so. "Not an
   * operator setting" is carried by the flag and by `configSave` refusing the
   * key (`CONFIG_FIELD_READ_ONLY`, covered in `system.int.test.ts`), not by the
   * field being invisible.
   */
  it('is shown but not editable, and says where its value comes from', () => {
    const descriptor = describeGroup(getConfigGroup('site')!);
    const byKey = new Map(descriptor.fields.map((field) => [field.key, field]));

    expect(byKey.get('publicOrigin')?.readOnly).toBe(true);
    expect(byKey.get('publicOrigin')?.help).toContain('env:PUBLIC_ORIGIN');
    expect(byKey.get('extraOrigins')?.readOnly).toBe(true);
    expect(byKey.get('extraOrigins')?.help).toContain('env:EXTRA_ALLOWED_ORIGINS');
    // The rest of the group is still an operator's to change.
    expect(byKey.get('siteName')?.readOnly).toBeUndefined();
  });

  it('comes from the environment, with no trailing slash', async () => {
    expect(await publicOrigin(siteCtx({ publicOrigin: 'https://shop.example.com/' }))).toBe(
      'https://shop.example.com',
    );
  });

  it('is empty when nobody told the deployment its own address', async () => {
    expect(await publicOrigin(siteCtx({}))).toBe('');
  });
});

describe('isTrustedHost', () => {
  const ctx = siteCtx({
    publicOrigin: 'https://shop.example.com',
    extraOrigins: 'h5.example.com, https://staging.example.com ,',
  });

  it('trusts the deployment’s own host and the extras, written either way', async () => {
    expect(await isTrustedHost(ctx, 'shop.example.com')).toBe(true);
    expect(await isTrustedHost(ctx, 'h5.example.com')).toBe(true);
    expect(await isTrustedHost(ctx, 'staging.example.com')).toBe(true);
    expect(await isTrustedHost(ctx, 'SHOP.EXAMPLE.COM')).toBe(true);
  });

  it('compares the whole host, so a suffix cannot borrow the shop’s name', async () => {
    expect(await isTrustedHost(ctx, 'shop.example.com.attacker.test')).toBe(false);
    expect(await isTrustedHost(ctx, 'notshop.example.com')).toBe(false);
  });

  it('trusts nothing when nothing is configured, and nothing empty or malformed', async () => {
    expect(await isTrustedHost(siteCtx({}), 'shop.example.com')).toBe(false);
    expect(await isTrustedHost(ctx, '')).toBe(false);
    expect(await isTrustedHost(ctx, '  ')).toBe(false);
  });

  it('does not let a misconfigured entry become “trust everything”', async () => {
    const broken = siteCtx({ publicOrigin: 'not a url', extraOrigins: ':::,' });
    expect(await isTrustedHost(broken, 'shop.example.com')).toBe(false);
    expect(await isTrustedHost(broken, 'not a url')).toBe(false);
  });
});

describe('describeGroup', () => {
  it('never describes a secret field as anything a browser would render as text', () => {
    const wechat = getConfigGroup('wechat-oa');
    expect(wechat).toBeDefined();
    const descriptor = describeGroup(wechat!);
    // The group's secret is the EncodingAESKey; the app credentials live in the
    // `wechat` group.
    const aesKey = descriptor.fields.find((f) => f.key === 'encodingAesKey');
    expect(aesKey).toMatchObject({ secret: true, kind: 'password' });
  });

  it('marks every credential in every registered group as secret', () => {
    // A credential that is not flagged is a credential `configGet` would return
    // to a browser, so this sweeps the whole registry rather than one group.
    //
    // The *identifier* half of a key pair is deliberately not matched here:
    // `AccessKeyId` and Tencent's `SecretId` are public names shown in every
    // vendor console, and hiding them would leave an operator unable to tell
    // which account is configured. The half that grants access must be secret,
    // and that is what this pattern matches. `token` is in the pattern because
    // `wechat-oa.token` authenticates every 明文-mode OA callback.
    const suspicious = /(secret|password|appcode|serverkey|privatekey|aeskey|apikey|token)$/i;
    const leaks: string[] = [];
    for (const group of allConfigGroups()) {
      for (const field of describeGroup(group).fields) {
        if (suspicious.test(field.key) && field.secret !== true) {
          leaks.push(`${group.group}.${field.key}`);
        }
      }
    }
    expect(leaks).toEqual([]);
  });

  it('carries conditional visibility through to the descriptor', () => {
    // The storage screen must not show seven S3 boxes on local disk.
    const storage = getConfigGroup('storage');
    const s3Bucket = describeGroup(storage!).fields.find((f) => f.key === 's3Bucket');
    expect(s3Bucket?.visibleWhen).toEqual({ key: 'driver', equals: 's3' });

    const sms = describeGroup(getConfigGroup('sms')!);
    expect(sms.fields.find((f) => f.key === 'aliyunSignName')?.visibleWhen).toEqual({
      key: 'provider',
      equals: 'aliyun',
    });
    // The provider switch itself is never conditional: hiding it would strand
    // whoever picked the wrong provider.
    expect(sms.fields.find((f) => f.key === 'provider')?.visibleWhen).toBeUndefined();
  });

  it('only lets a field depend on another field of its own group', () => {
    // `defineConfigGroup` rejects a dangling key; this sweeps what is actually
    // registered rather than restating the rule.
    for (const group of allConfigGroups()) {
      const keys = new Set(Object.keys(group.schema.shape));
      for (const field of describeGroup(group).fields) {
        if (!field.visibleWhen) continue;
        expect(keys, `${group.group}.${field.key}`).toContain(field.visibleWhen.key);
      }
    }
  });

  it('orders fields the way the group was written', () => {
    const site = describeGroup(getConfigGroup('site')!);
    expect(site.fields[0]?.key).toBe('siteName');
  });

  it('gives every group a readable title and a permission that exists', () => {
    // A group whose atom is not declared anywhere is a screen only a super
    // admin can open, and nobody finds out until a 客服 account tries. A verb
    // other than `:read` is allowed and means "the same atom guards the save":
    // a group holding a merchant private key (`payment`) gates reading behind
    // `:write`. `writePermissionFor` returns
    // such an atom unchanged rather than inventing one, so the only derived
    // atom is `:read` → `:write`, and that one must exist too.
    for (const group of allConfigGroups()) {
      const descriptor = describeGroup(group);
      expect(descriptor.title.length, group.group).toBeGreaterThan(0);
      expect(descriptor.permission, group.group).toMatch(/^[a-z-]+:[a-z-]+:[a-z]+$/);
      if (descriptor.permission.endsWith(':read')) {
        const write = descriptor.permission.replace(/:read$/, ':write');
        expect(isKnownPermission(write), write).toBe(true);
      }
      expect(isKnownPermission(descriptor.permission), descriptor.permission).toBe(true);
      expect(descriptor.fields.length, group.group).toBeGreaterThan(0);
    }
  });
});

describe('permissionTree', () => {
  it('groups atoms into sections and keeps them sorted', () => {
    const tree = permissionTree();
    const sections = tree.sections.map((s) => s.section);
    expect(sections).toContain('系统');
    expect(sections).toContain('素材');
    // Sorted, so the role editor does not reshuffle itself when an unrelated
    // module changes its import order.
    expect([...sections]).toEqual([...sections].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')));
    for (const section of tree.sections) {
      const atoms = section.items.map((i) => i.atom);
      expect([...atoms], section.section).toEqual([...atoms].sort((a, b) => a.localeCompare(b)));
    }
  });

  it('names the atoms every admin holds implicitly', () => {
    // An admin with zero grants can still read their own session, log out, and
    // read and edit their own profile, so the role editor must not offer those
    // as though they were choices.
    expect(permissionTree().implicit).toEqual([
      'auth:api-token:self',
      'auth:profile:read',
      'auth:profile:update',
      'auth:session:delete',
      'auth:session:read',
    ]);
  });

  it('includes the storage atoms the contracts reference', () => {
    const atoms = permissionTree()
      .sections.flatMap((s) => s.items)
      .map((n) => n.atom);
    for (const atom of [
      'storage:attachment:read',
      'storage:attachment:write',
      'storage:attachment:delete',
      'storage:category:read',
      'storage:category:write',
      'storage:category:delete',
    ]) {
      expect(atoms, atom).toContain(atom);
    }
  });
});

describe('dashboardHeader', () => {
  beforeEach(() => {
    resetDashboardContributors();
  });

  it('degrades one contributor rather than the page', async () => {
    registerDashboardContributor({
      key: 'good',
      async tiles() {
        return [countTile({ key: 'good.one', label: '好', value: 1 })];
      },
    });
    registerDashboardContributor({
      key: 'bad',
      async tiles() {
        throw new Error('the orders database is having a day');
      },
    });

    const header = await dashboardHeader(pureCtx());
    expect(header.tiles.map((t) => t.key)).toEqual(['good.one']);
    expect(header.degraded).toEqual(['bad']);
  });

  it('hides tiles the caller has no permission for', async () => {
    registerDashboardContributor({
      key: 'money',
      permission: 'order:order:read',
      async tiles() {
        return [countTile({ key: 'money.today', label: '今日', value: 999 })];
      },
    });

    const outsider = pureCtx({
      actor: { kind: 'admin', id: 7, permissions: [], isSuper: false },
    });
    const insider = pureCtx({
      actor: { kind: 'admin', id: 8, permissions: ['order:order:read'], isSuper: false },
    });

    expect((await dashboardHeader(outsider)).tiles).toEqual([]);
    expect((await dashboardHeader(insider)).tiles).toHaveLength(1);
  });

  it('contributes nothing at all for a domain that is not loaded', async () => {
    // No zero, no placeholder: the page shows what exists rather than inventing
    // a number for a domain that is not loaded.
    const header = await dashboardHeader(pureCtx());
    expect(header.tiles).toEqual([]);
    expect(header.degraded).toEqual([]);
  });

  it('orders contributors by `order`, then by registration', async () => {
    registerDashboardContributor({
      key: 'late',
      order: 900,
      async tiles() {
        return [countTile({ key: 'late', label: '后', value: 1 })];
      },
    });
    registerDashboardContributor({
      key: 'early',
      order: 100,
      async tiles() {
        return [countTile({ key: 'early', label: '前', value: 1 })];
      },
    });
    const header = await dashboardHeader(pureCtx());
    expect(header.tiles.map((t) => t.key)).toEqual(['early', 'late']);
  });
});
