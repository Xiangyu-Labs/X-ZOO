import { decorBlocks } from '@shop/contracts/decor/all-blocks';
import type { DocumentKind } from '@shop/contracts/decor/constants';
import {
  USER_CENTER_DEFAULT_DOCUMENT,
  USER_CENTER_DEFAULT_VERSION,
} from '@shop/contracts/decor/defaults';
import {
  pageRootProps,
  type PageRootProps,
  type StoredDocument,
} from '@shop/contracts/decor/document';
import {
  compareVersions,
  migrateBlockProps,
  type BlockRegistry,
} from '@shop/contracts/decor/registry';
import type { ResolvedPage } from '@shop/contracts/decor/schemas';
import type { BlockVisibility } from '@shop/contracts/decor/base';
import type {
  DataNeed,
  DataNeedKind,
  HeldCoupon,
  OrderEntryCounts,
  PersonalNeed,
  PersonalSlot,
  UserSummary,
} from '@shop/contracts/decor/sources';
import { DECOR_LIMITS } from '@shop/contracts/decor/constants';

import { anonymousActor, type Ctx } from '../kernel/context';
import { DomainError } from '../kernel/errors';
import { readCachedPage, writeCachedPage } from './decor.cache';
import { assertPreviewToken } from './decor.preview';
import {
  couponStatesFor,
  defaultResolvers,
  heldNewcomerCouponsFor,
  orderEntryCountsFor,
  userSummaryFor,
  type DataResolvers,
} from './decor.resolvers';
import * as repo from './decor.repo';

/**
 * The storefront page resolver (plan §2.1).
 *
 * One request returns a page ready to render: the live revision's blocks, each
 * with its data resolved on the server. In three layers:
 *
 * 1. **Public, cached** (DECOR-014). The revision's blocks — migrated to the
 *    current block versions, parsed, unknown or unparseable ones dropped — and
 *    their data, resolved as an anonymous shopper. Identical for everybody, so
 *    cached per revision for `DECOR_CACHE_SECONDS`.
 * 2. **Per request** (DECOR-016). Blocks are filtered for this caller:
 *    `visibility.audience` against the session, `visibility.platforms`
 *    against `X-Client-Platform`, and each type's `minClient` against
 *    `X-Client-Version`.
 * 3. **Per shopper, never cached** (DECOR-015). With a session, the shopper's
 *    own state for what the page shows (coupons claimed / claimable), and
 *    what the blocks declare with `personal` (订单入口 counts, 用户卡片
 *    profile and totals, the 新人券 still held), in `personal`.
 *
 * A resolver that fails costs its slot (`null`), never the page.
 */

/** A block of the public layer, with what the per-request layers need. */
interface PublicBlock {
  id: string;
  type: string;
  v: number;
  props: Record<string, unknown>;
  data: Record<string, unknown[] | null>;
  /** slot → need kind, for the personal layer. Stripped from the response. */
  kinds: Record<string, DataNeedKind>;
  /**
   * slot → per-shopper need, from the block's `personal` (config only: what
   * to fetch, never the answer). Stripped from the response. Absent in an
   * entry an older build cached (for at most `DECOR_CACHE_SECONDS` across a
   * deploy): that page then simply has no declared personal state.
   */
  personalNeeds?: Record<string, PersonalNeed> | undefined;
}

interface PublicPage {
  id: string | null;
  kind: DocumentKind;
  revision: number | null;
  preview: boolean;
  root: { props: PageRootProps };
  blocks: PublicBlock[];
  version: string;
  resolvedAt: string;
}

export interface ResolveOptions {
  /** Injected in tests; the contracts registry otherwise. */
  registry?: BlockRegistry | undefined;
  resolvers?: Partial<DataResolvers> | undefined;
}

export interface ResolveInput {
  /** `X-Client-Version` as sent, or `null`. */
  clientVersion: string | null;
}

async function resolveNeed(
  ctx: Ctx,
  need: DataNeed,
  resolvers: DataResolvers,
): Promise<unknown[] | null> {
  try {
    const resolver = resolvers[need.kind] as (ctx: Ctx, need: DataNeed) => Promise<unknown[]>;
    return await resolver(ctx, need);
  } catch (error) {
    ctx.logger.warn({ err: error, need: need.kind }, 'decor: block data could not be resolved');
    return null;
  }
}

/**
 * Builds the public layer from a stored document: migrate, parse, drop what
 * cannot be served, cap the data blocks, resolve their data in parallel.
 */
async function buildPublicPage(
  ctx: Ctx,
  source: {
    id: string | null;
    kind: DocumentKind;
    revision: number | null;
    preview: boolean;
    version: string;
  },
  document: StoredDocument,
  options: ResolveOptions,
): Promise<PublicPage> {
  const registry = options.registry ?? decorBlocks;
  const resolvers = { ...defaultResolvers, ...options.resolvers };
  const anonymous = ctx.as(anonymousActor);

  const root = pageRootProps.safeParse(document.root.props);
  let dataBlocks = 0;
  const pending: Promise<PublicBlock>[] = [];
  for (const block of document.blocks.slice(0, DECOR_LIMITS.blocks)) {
    const definition = registry.get(block.type);
    if (!definition) continue; // unknown type: skipped (DECOR-016)
    const migrated = migrateBlockProps(definition, block.v, block.props);
    if (!migrated.ok) continue;
    const parsed = definition.props.safeParse(migrated.props);
    if (!parsed.success) continue; // only a preview can hold one; never served broken
    const props = parsed.data as Record<string, unknown>;
    let needs: Record<string, DataNeed> = {};
    if (definition.data) {
      dataBlocks += 1;
      if (dataBlocks > DECOR_LIMITS.dataBlocks) continue;
      needs = (definition.data as (props: unknown) => Record<string, DataNeed>)(props);
    }
    const personalNeeds = definition.personal
      ? (definition.personal as (props: unknown) => Record<string, PersonalNeed>)(props)
      : {};
    pending.push(
      (async () => {
        const entries = await Promise.all(
          Object.entries(needs).map(
            async ([slot, need]) => [slot, await resolveNeed(anonymous, need, resolvers)] as const,
          ),
        );
        return {
          id: block.id,
          type: block.type,
          v: definition.v,
          props,
          data: Object.fromEntries(entries),
          kinds: Object.fromEntries(Object.entries(needs).map(([slot, need]) => [slot, need.kind])),
          personalNeeds,
        };
      })(),
    );
  }
  return {
    ...source,
    root: { props: root.success ? root.data : pageRootProps.parse({}) },
    blocks: await Promise.all(pending),
    resolvedAt: ctx.clock.now().toISOString(),
  };
}

function isSignedIn(ctx: Ctx): boolean {
  return ctx.actor.kind === 'user' && ctx.actor.id !== null;
}

/** DECOR-016: may this caller see this block? */
export function blockVisibleTo(
  block: { type: string; props: Record<string, unknown> },
  caller: { signedIn: boolean; platform: string | null; clientVersion: string | null },
  registry: BlockRegistry = decorBlocks,
): boolean {
  const visibility = block.props.visibility as BlockVisibility | undefined;
  if (visibility) {
    if (visibility.audience === 'guest' && caller.signedIn) return false;
    if (visibility.audience === 'member' && !caller.signedIn) return false;
    if (
      visibility.platforms.length > 0 &&
      caller.platform !== null &&
      !(visibility.platforms as readonly string[]).includes(caller.platform)
    ) {
      return false;
    }
  }
  const minClient = registry.get(block.type)?.meta.minClient;
  if (minClient && caller.clientVersion !== null) {
    const order = compareVersions(caller.clientVersion, minClient);
    if (order !== null && order < 0) return false;
  }
  return true;
}

type PersonalByBlock = Record<string, Record<string, PersonalSlot>>;

/** Coupon state for the coupons the page shows. */
async function couponLayer(ctx: Ctx, blocks: readonly PublicBlock[]): Promise<PersonalByBlock> {
  const claimable: string[] = [];
  const newUser: string[] = [];
  for (const block of blocks) {
    for (const [slot, kind] of Object.entries(block.kinds)) {
      const ids = (block.data[slot] ?? []).map(
        (item) => (item as { templateId: string }).templateId,
      );
      if (kind === 'coupons') claimable.push(...ids);
      if (kind === 'newUserCoupons') newUser.push(...ids);
    }
  }
  if (claimable.length === 0 && newUser.length === 0) return {};
  let states;
  try {
    states = await couponStatesFor(ctx, { claimable, newUser });
  } catch (error) {
    ctx.logger.warn({ err: error }, 'decor: personal coupon state could not be resolved');
    return {};
  }
  const out: PersonalByBlock = {};
  for (const block of blocks) {
    for (const [slot, kind] of Object.entries(block.kinds)) {
      if (kind !== 'coupons' && kind !== 'newUserCoupons') continue;
      const items = (block.data[slot] ?? [])
        .map((item) => states.get((item as { templateId: string }).templateId))
        .filter((state) => state !== undefined);
      (out[block.id] ??= {})[slot] = { kind: 'coupons', items };
    }
  }
  return out;
}

/**
 * What the blocks declared with `personal`. Each kind is fetched at most once
 * per request, however many blocks ask; a kind that fails costs its slots
 * (left out), never the page.
 */
async function declaredLayer(ctx: Ctx, blocks: readonly PublicBlock[]): Promise<PersonalByBlock> {
  const wanted = blocks.flatMap((block) =>
    Object.entries(block.personalNeeds ?? {}).map(([slot, need]) => ({
      block: block.id,
      slot,
      need,
    })),
  );
  if (wanted.length === 0) return {};
  const guarded = async <T>(kind: string, load: () => Promise<T>): Promise<T | null> => {
    try {
      return await load();
    } catch (error) {
      ctx.logger.warn({ err: error, need: kind }, 'decor: personal state could not be resolved');
      return null;
    }
  };
  const needsStats = wanted.some(({ need }) => need.kind === 'userSummary' && need.stats);
  const heldLimit = Math.max(
    0,
    ...wanted.map(({ need }) => (need.kind === 'newcomerCoupons' ? need.limit : 0)),
  );
  const [counts, user, held] = await Promise.all([
    wanted.some(({ need }) => need.kind === 'orderCounts')
      ? guarded<OrderEntryCounts>('orderCounts', () => orderEntryCountsFor(ctx))
      : null,
    wanted.some(({ need }) => need.kind === 'userSummary')
      ? guarded<UserSummary>('userSummary', () => userSummaryFor(ctx, needsStats))
      : null,
    heldLimit > 0
      ? guarded<HeldCoupon[]>('newcomerCoupons', () =>
          heldNewcomerCouponsFor(ctx, Math.min(heldLimit, DECOR_LIMITS.records)),
        )
      : null,
  ]);
  const out: PersonalByBlock = {};
  for (const { block, slot, need } of wanted) {
    if (need.kind === 'orderCounts' && counts) {
      (out[block] ??= {})[slot] = { kind: 'orderCounts', counts };
    }
    if (need.kind === 'userSummary' && user) {
      (out[block] ??= {})[slot] = {
        kind: 'userSummary',
        user: need.stats ? user : { ...user, stats: null },
      };
    }
    if (need.kind === 'newcomerCoupons' && held) {
      (out[block] ??= {})[slot] = { kind: 'newcomerCoupons', coupons: held.slice(0, need.limit) };
    }
  }
  return out;
}

/** Layer 3: everything personal, only ever called with a session. */
async function personalLayer(ctx: Ctx, blocks: readonly PublicBlock[]): Promise<PersonalByBlock> {
  const [coupons, declared] = await Promise.all([
    couponLayer(ctx, blocks),
    declaredLayer(ctx, blocks),
  ]);
  const out: PersonalByBlock = { ...coupons };
  for (const [block, slots] of Object.entries(declared)) out[block] = { ...out[block], ...slots };
  return out;
}

/** Layers 2 and 3 over a public page. */
async function finish(
  ctx: Ctx,
  page: PublicPage,
  input: ResolveInput,
  options: ResolveOptions,
): Promise<ResolvedPage> {
  const signedIn = isSignedIn(ctx);
  const caller = { signedIn, platform: ctx.platform, clientVersion: input.clientVersion };
  const visible = page.blocks.filter((block) =>
    blockVisibleTo(block, caller, options.registry ?? decorBlocks),
  );
  return {
    id: page.id,
    kind: page.kind,
    revision: page.revision,
    preview: page.preview,
    root: page.root,
    blocks: visible.map(
      ({ kinds: _kinds, personalNeeds: _personal, ...block }) => block,
    ) as ResolvedPage['blocks'],
    personal: signedIn ? await personalLayer(ctx, visible) : null,
    version: page.version,
    resolvedAt: page.resolvedAt,
  };
}

/** A published revision, through the cache. */
async function servePublished(
  ctx: Ctx,
  row: repo.DocumentWithLive,
  input: ResolveInput,
  options: ResolveOptions,
): Promise<ResolvedPage> {
  const revisionId = row.document.publishedRevisionId;
  if (revisionId === null || row.live === null) throw new DomainError('DECOR_DOCUMENT_NOT_FOUND');
  const cacheable = options.registry === undefined && options.resolvers === undefined;
  let page = cacheable ? await readCachedPage<PublicPage>(ctx, revisionId) : null;
  if (!page) {
    const revision = await repo.findRevision(ctx.db, revisionId);
    if (!revision) throw new DomainError('DECOR_DOCUMENT_NOT_FOUND');
    page = await buildPublicPage(
      ctx,
      {
        id: String(row.document.id),
        kind: row.document.kind,
        revision: revision.number,
        preview: false,
        version: `rev-${revision.id}`,
      },
      revision.content as StoredDocument,
      options,
    );
    if (cacheable) await writeCachedPage(ctx, revisionId, page);
  }
  return finish(ctx, page, input, options);
}

/** `GET /api/v1/pages/home`: the designated home page. */
export async function resolveHome(
  ctx: Ctx,
  input: ResolveInput,
  options: ResolveOptions = {},
): Promise<ResolvedPage> {
  const row = await repo.findDesignated(ctx.db, 'home');
  if (!row) throw new DomainError('DECOR_HOME_NOT_SET');
  return servePublished(ctx, row, input, options);
}

/**
 * `GET /api/v1/pages/user-center`: the designated 个人中心, or the built-in one
 * (DECOR-005) — never a 404.
 */
export async function resolveUserCenter(
  ctx: Ctx,
  input: ResolveInput,
  options: ResolveOptions = {},
): Promise<ResolvedPage> {
  const row = await repo.findDesignated(ctx.db, 'user_center');
  if (row) return servePublished(ctx, row, input, options);
  const page = await buildPublicPage(
    ctx,
    {
      id: null,
      kind: 'user_center',
      revision: null,
      preview: false,
      version: USER_CENTER_DEFAULT_VERSION,
    },
    USER_CENTER_DEFAULT_DOCUMENT,
    options,
  );
  return finish(ctx, page, input, options);
}

/**
 * `GET /api/v1/pages/:id`: a published document; with `previewToken`, its
 * current draft instead (DECOR-012) — uncached, and only blocks that parse.
 */
export async function resolveDocument(
  ctx: Ctx,
  input: ResolveInput & { id: string; previewToken?: string | undefined },
  options: ResolveOptions = {},
): Promise<ResolvedPage> {
  const id = Number(input.id);
  if (input.previewToken !== undefined) {
    await assertPreviewToken(ctx, id, input.previewToken);
    const row = await repo.findDocument(ctx.db, id);
    if (!row) throw new DomainError('DECOR_DOCUMENT_NOT_FOUND');
    const page = await buildPublicPage(
      ctx,
      {
        id: String(id),
        kind: row.document.kind,
        revision: null,
        preview: true,
        version: `draft-${id}-${row.document.draftVersion}`,
      },
      row.document.draft as StoredDocument,
      options,
    );
    return finish(ctx, page, input, options);
  }
  const row = await repo.findDocument(ctx.db, id);
  if (!row || row.document.publishedRevisionId === null) {
    throw new DomainError('DECOR_DOCUMENT_NOT_FOUND');
  }
  return servePublished(ctx, row, input, options);
}
