import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';

import { miniRoute } from '../mini';
import { openFresh, shown } from './shown';

/**
 * 页面装修 v2 from both ends: the operator's side through the admin API (the same routes F2's
 * editor calls), the shopper's side as the 微页面 (`packages/page/index`) of the mini-program.
 */

const style = { marginY: 'none', paddingX: 'none', radius: 'none' } as const;
const visibility = { audience: 'all', platforms: [] } as const;

export interface DecorBlock {
  id: string;
  type: string;
  v: number;
  props: Record<string, unknown>;
}

/** A page document (schemaVersion 2) holding `blocks`, titled `title`. */
export function decorDocument(title: string, blocks: DecorBlock[]) {
  return {
    schemaVersion: 2 as const,
    root: { props: { title, background: '#f5f5f5', shareEnabled: true, shareTitle: '' } },
    blocks,
  };
}

/** A block of `type` with the frame defaults every stored block carries. */
export function block(id: string, type: string, props: Record<string, unknown>, v = 1): DecorBlock {
  return { id, type, v, props: { ...props, style, visibility } };
}

export interface DecorDraft {
  id: string;
  draftVersion: string;
}

/** 新建页面 (a 微页面, or a `home` page) with `document` as its draft; not published. */
export async function createDecorPage(
  adminApi: APIRequestContext,
  name: string,
  document: ReturnType<typeof decorDocument>,
  kind: 'custom' | 'home' = 'custom',
): Promise<DecorDraft> {
  const response = await adminApi.post('/admin-api/decor/documents', {
    data: { kind, name, document },
  });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()) as DecorDraft;
}

/** 保存 a new draft over the one at `version`; answers the new draft version. */
export async function saveDecorDraft(
  adminApi: APIRequestContext,
  draft: DecorDraft,
  document: ReturnType<typeof decorDocument>,
): Promise<DecorDraft> {
  const response = await adminApi.put(`/admin-api/decor/documents/${draft.id}/draft`, {
    data: { document, version: draft.draftVersion },
  });
  expect(response.status(), await response.text()).toBe(200);
  const saved = (await response.json()) as { version: string };
  return { id: draft.id, draftVersion: saved.version };
}

/** 发布 the saved draft; answers the revision number shoppers now see. */
export async function publishDecorPage(
  adminApi: APIRequestContext,
  draft: DecorDraft,
  note: string,
): Promise<number> {
  const response = await adminApi.post(`/admin-api/decor/documents/${draft.id}/publish`, {
    data: { version: draft.draftVersion, note },
  });
  expect(response.status(), await response.text()).toBe(200);
  const body = (await response.json()) as { revision: { number: number } };
  return body.revision.number;
}

/** 预览: a token that shows the draft (F2's editor frames the page with it). */
export async function decorPreviewToken(
  adminApi: APIRequestContext,
  draft: DecorDraft,
): Promise<string> {
  const response = await adminApi.post(`/admin-api/decor/documents/${draft.id}/preview-token`);
  expect(response.status(), await response.text()).toBe(201);
  return ((await response.json()) as { previewToken: string }).previewToken;
}

/** 设为首页: `documentId` (a published `home` page) becomes the shop's 首页. */
export async function designateDecorHome(
  adminApi: APIRequestContext,
  documentId: string | number,
): Promise<void> {
  const response = await adminApi.put('/admin-api/decor/designations/home', {
    data: { documentId: String(documentId) },
  });
  expect(response.status(), await response.text()).toBe(200);
}

/** 新建优惠券: a hand-claimed, shop-wide ¥`amount` coupon, one per shopper, 30 days. */
export async function createClaimableCoupon(
  adminApi: APIRequestContext,
  name: string,
  amount: string,
): Promise<string> {
  const response = await adminApi.post('/admin-api/coupons', {
    data: {
      name,
      scope: 'all_products',
      claimMode: 'manual',
      status: 'active',
      discountAmount: amount,
      minSpend: '0.00',
      validityMode: 'days_after_claim',
      validDays: 30,
      isUnlimitedSupply: true,
      perUserLimit: 1,
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

/** Saves some values of a 系统设置 group; the rest of the group keeps what it had. */
export async function saveConfig(
  adminApi: APIRequestContext,
  group: string,
  values: Record<string, unknown>,
): Promise<void> {
  const response = await adminApi.put(`/admin-api/system/config/${group}`, { data: { values } });
  expect(response.status(), await response.text()).toBe(200);
}

/** 微页面 (`packages/page/index`), a published page or, with a token, its draft. */
export class MicroPage {
  constructor(private readonly page: Page) {}

  async open(id: string, previewToken?: string): Promise<void> {
    await openFresh(
      this.page,
      miniRoute('packages/page/index', { id, ...(previewToken ? { previewToken } : {}) }),
    );
  }

  /** Every rendered block, in page order, by its `data-block` (BlockFrame). */
  blocks(): Locator {
    return shown(this.page).locator('[data-block]');
  }

  block(type: string): Locator {
    return shown(this.page).locator(`[data-block="${type}"]`);
  }

  previewBanner(): Locator {
    return shown(this.page).locator('#decor-preview-banner');
  }

  /** The `data-block` types on the page, top to bottom. */
  async blockTypes(): Promise<string[]> {
    return this.blocks().evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('data-block') ?? ''),
    );
  }
}

/** 首页 (tab `home`), drawn from whatever page is designated. */
export class DecorHomePage {
  constructor(private readonly page: Page) {}

  async open(): Promise<void> {
    await openFresh(this.page, miniRoute('pages/index/index'));
  }

  block(type: string): Locator {
    return shown(this.page).locator(`[data-block="${type}"]`);
  }

  /** One ticket of an 优惠券 block; `data-action` says what it offers (claim / again / use / gone). */
  couponTicket(templateId: string): Locator {
    return shown(this.page).locator(`[data-coupon="${templateId}"]`);
  }
}
