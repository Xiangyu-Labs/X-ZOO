import type { PageQuery } from '@shop/contracts/conventions';
import type {
  ProductLabel,
  ProductLabelCategory,
  ProductLabelCategoryForm,
  ProductLabelForm,
  ProductParamTemplate,
  ProductParamTemplateForm,
  ProductProtection,
  ProductProtectionForm,
} from '@shop/contracts/catalog/schemas';

import { DomainError } from '../kernel/errors';
import type { Ctx } from '../kernel/context';
import * as repo from './catalog.repo';
import { orNull, pageBounds } from './catalog.service';

/**
 * The four small taxonomies a product is decorated with: label groupings,
 * labels, parameter templates and 服务保障 badges.
 *
 * They are four copies of the same CRUD shape on purpose. Factoring them into
 * one generic would save fifty lines and cost the thing that matters here —
 * each has its own error code, its own uniqueness rule and its own delete
 * guard, and a generic would either lose those or grow an options object with
 * four branches in it.
 *
 * Protections get their own permission atoms (`catalog:protection:*`). Filed
 * under the 商品参数 permission group, granting a colleague the right to edit
 * parameter templates would also let them rewrite the guarantee badges shown on
 * every product page.
 */

// ---------------------------------------------------------------------------
// label categories
// ---------------------------------------------------------------------------

export async function adminLabelCategoryList(
  ctx: Ctx,
  query: {
    keyword?: string | undefined;
    sortBy?: 'id' | 'sortOrder' | 'name' | undefined;
    sortOrder?: 'asc' | 'desc' | undefined;
  } & PageQuery,
): Promise<{ items: ProductLabelCategory[]; total: number; page: number; pageSize: number }> {
  const { rows, total } = await repo.listLabelCategories(ctx.db, {
    keyword: query.keyword,
    sortBy: query.sortBy,
    sortOrder: query.sortOrder,
    ...pageBounds(query),
  });
  const counts = await repo.labelCategoryCounts(
    ctx.db,
    rows.map((r) => r.id),
  );
  return {
    items: rows.map((row) => ({
      id: String(row.id),
      name: row.name,
      sortOrder: row.sortOrder,
      labelCount: counts.get(row.id) ?? 0,
      createdAt: row.createdAt.toISOString(),
    })),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

export async function adminLabelCategoryCreate(
  ctx: Ctx,
  body: ProductLabelCategoryForm,
): Promise<ProductLabelCategory> {
  return ctx.withTx(async (tx) => {
    if ((await repo.labelCategoryNameTakenBy(tx, { name: body.name })) !== null) {
      throw new DomainError('CATALOG_NAME_TAKEN');
    }
    const now = ctx.clock.now();
    const row = await repo.insertLabelCategory(tx, {
      name: body.name,
      sortOrder: body.sortOrder,
      createdAt: now,
      updatedAt: now,
    });
    return {
      id: String(row.id),
      name: row.name,
      sortOrder: row.sortOrder,
      labelCount: 0,
      createdAt: row.createdAt.toISOString(),
    };
  });
}

export async function adminLabelCategoryUpdate(
  ctx: Ctx,
  input: { id: string },
  body: ProductLabelCategoryForm,
): Promise<ProductLabelCategory> {
  const id = Number(input.id);
  return ctx.withTx(async (tx) => {
    if ((await repo.labelCategoryNameTakenBy(tx, { name: body.name, exceptId: id })) !== null) {
      throw new DomainError('CATALOG_NAME_TAKEN');
    }
    const { won } = await repo.updateLabelCategory(tx, id, {
      name: body.name,
      sortOrder: body.sortOrder,
      updatedAt: ctx.clock.now(),
    });
    if (!won) throw new DomainError('CATALOG_LABEL_CATEGORY_NOT_FOUND');

    const row = await repo.findLabelCategory(tx, id);
    if (!row) throw new DomainError('CATALOG_LABEL_CATEGORY_NOT_FOUND');
    const counts = await repo.labelCategoryCounts(tx, [id]);
    return {
      id: String(row.id),
      name: row.name,
      sortOrder: row.sortOrder,
      labelCount: counts.get(id) ?? 0,
      createdAt: row.createdAt.toISOString(),
    };
  });
}

/**
 * Delete a grouping.
 *
 * Its labels survive and become ungrouped. Deleting a folder must not delete
 * what is in it — a cascade would let an operator tidying the label groups
 * silently remove every label from every product card.
 */
export async function adminLabelCategoryDelete(ctx: Ctx, input: { id: string }): Promise<void> {
  const id = Number(input.id);
  await ctx.withTx(async (tx) => {
    const now = ctx.clock.now();
    await repo.detachLabelsFromCategory(tx, id);
    const { won } = await repo.softDeleteLabelCategory(tx, { id, now });
    if (!won) throw new DomainError('CATALOG_LABEL_CATEGORY_NOT_FOUND');
  });
}

// ---------------------------------------------------------------------------
// labels
// ---------------------------------------------------------------------------

export async function adminLabelList(
  ctx: Ctx,
  query: {
    keyword?: string | undefined;
    categoryId?: string | undefined;
    isEnabled?: boolean | undefined;
    sortBy?: 'id' | 'sortOrder' | 'name' | 'createdAt' | undefined;
    sortOrder?: 'asc' | 'desc' | undefined;
  } & PageQuery,
): Promise<{ items: ProductLabel[]; total: number; page: number; pageSize: number }> {
  const { rows, total } = await repo.listLabels(ctx.db, {
    keyword: query.keyword,
    categoryId: query.categoryId === undefined ? undefined : Number(query.categoryId),
    isEnabled: query.isEnabled,
    sortBy: query.sortBy,
    sortOrder: query.sortOrder,
    ...pageBounds(query),
  });
  const counts = await repo.labelProductCounts(
    ctx.db,
    rows.map((r) => r.label.id),
  );
  return {
    items: rows.map(({ label, categoryName }) =>
      toLabel(label, categoryName, counts.get(label.id) ?? 0),
    ),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

export async function adminLabelCreate(ctx: Ctx, body: ProductLabelForm): Promise<ProductLabel> {
  return ctx.withTx(async (tx) => {
    if ((await repo.labelNameTakenBy(tx, { name: body.name })) !== null) {
      throw new DomainError('CATALOG_NAME_TAKEN');
    }
    await assertLabelCategory(ctx, body.categoryId);

    const now = ctx.clock.now();
    const row = await repo.insertLabel(tx, {
      ...labelValues(body),
      createdAt: now,
      updatedAt: now,
    });
    return toLabel(row, await categoryNameOf(ctx, body.categoryId), 0);
  });
}

export async function adminLabelUpdate(
  ctx: Ctx,
  input: { id: string },
  body: ProductLabelForm,
): Promise<ProductLabel> {
  const id = Number(input.id);
  return ctx.withTx(async (tx) => {
    if ((await repo.labelNameTakenBy(tx, { name: body.name, exceptId: id })) !== null) {
      throw new DomainError('CATALOG_NAME_TAKEN');
    }
    await assertLabelCategory(ctx, body.categoryId);

    const { won } = await repo.updateLabel(tx, id, {
      ...labelValues(body),
      updatedAt: ctx.clock.now(),
    });
    if (!won) throw new DomainError('CATALOG_LABEL_NOT_FOUND');

    const row = await repo.findLabel(tx, id);
    if (!row) throw new DomainError('CATALOG_LABEL_NOT_FOUND');
    const counts = await repo.labelProductCounts(tx, [id]);
    return toLabel(row, await categoryNameOf(ctx, body.categoryId), counts.get(id) ?? 0);
  });
}

/** The list's 启用 switch, guarded on the value it moves from. */
export async function adminLabelSetEnabled(
  ctx: Ctx,
  input: { id: string },
  body: { isEnabled: boolean },
): Promise<ProductLabel> {
  const id = Number(input.id);
  return ctx.withTx(async (tx) => {
    const row = await repo.findLabel(tx, id);
    if (!row) throw new DomainError('CATALOG_LABEL_NOT_FOUND');
    if (row.isEnabled !== body.isEnabled) {
      const { won } = await repo.setLabelEnabled(tx, {
        id,
        from: row.isEnabled,
        to: body.isEnabled,
        now: ctx.clock.now(),
      });
      if (!won) throw new DomainError('CATALOG_LABEL_NOT_FOUND');
    }
    const updated = await repo.findLabel(tx, id);
    if (!updated) throw new DomainError('CATALOG_LABEL_NOT_FOUND');
    const counts = await repo.labelProductCounts(tx, [id]);
    const category =
      updated.categoryId === null ? null : await repo.findLabelCategory(tx, updated.categoryId);
    return toLabel(updated, category?.name ?? null, counts.get(id) ?? 0);
  });
}

/**
 * Delete a label.
 *
 * Soft, and the `product_labels_map` rows go with it by cascade, so a card
 * stops showing a label the operator retired. Nothing refuses the delete: a
 * label is decoration, and blocking on "still used by 40 products" would mean
 * an operator can never retire one.
 */
export async function adminLabelDelete(ctx: Ctx, input: { id: string }): Promise<void> {
  const id = Number(input.id);
  await ctx.withTx(async (tx) => {
    const { won } = await repo.softDeleteLabel(tx, { id, now: ctx.clock.now() });
    if (!won) throw new DomainError('CATALOG_LABEL_NOT_FOUND');
  });
}

function labelValues(body: ProductLabelForm): repo.NewLabelValues {
  return {
    categoryId: body.categoryId === null ? null : Number(body.categoryId),
    name: body.name,
    style: body.style,
    fontColor: orNull(body.fontColor),
    backgroundColor: orNull(body.backgroundColor),
    borderColor: orNull(body.borderColor),
    imageUrl: orNull(body.imageUrl),
    isVisible: body.isVisible,
    isEnabled: body.isEnabled,
    sortOrder: body.sortOrder,
  };
}

async function assertLabelCategory(ctx: Ctx, categoryId: string | null): Promise<void> {
  if (categoryId === null) return;
  const row = await repo.findLabelCategory(ctx.db, Number(categoryId));
  if (!row) throw new DomainError('CATALOG_LABEL_CATEGORY_NOT_FOUND');
}

async function categoryNameOf(ctx: Ctx, categoryId: string | null): Promise<string | null> {
  if (categoryId === null) return null;
  const row = await repo.findLabelCategory(ctx.db, Number(categoryId));
  return row?.name ?? null;
}

function toLabel(
  row: repo.LabelRow,
  categoryName: string | null,
  productCount: number,
): ProductLabel {
  return {
    id: String(row.id),
    categoryId: row.categoryId === null ? null : String(row.categoryId),
    categoryName,
    name: row.name,
    style: row.style,
    fontColor: row.fontColor,
    backgroundColor: row.backgroundColor,
    borderColor: row.borderColor,
    imageUrl: row.imageUrl,
    isVisible: row.isVisible,
    isEnabled: row.isEnabled,
    sortOrder: row.sortOrder,
    productCount,
    createdAt: row.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// param templates
// ---------------------------------------------------------------------------

export async function adminParamTemplateList(
  ctx: Ctx,
  query: {
    keyword?: string | undefined;
    isEnabled?: boolean | undefined;
    sortBy?: 'id' | 'sortOrder' | 'name' | undefined;
    sortOrder?: 'asc' | 'desc' | undefined;
  } & PageQuery,
): Promise<{ items: ProductParamTemplate[]; total: number; page: number; pageSize: number }> {
  const { rows, total } = await repo.listParamTemplates(ctx.db, {
    keyword: query.keyword,
    isEnabled: query.isEnabled,
    sortBy: query.sortBy,
    sortOrder: query.sortOrder,
    ...pageBounds(query),
  });
  return {
    items: rows.map(toParamTemplate),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

export async function adminParamTemplateCreate(
  ctx: Ctx,
  body: ProductParamTemplateForm,
): Promise<ProductParamTemplate> {
  return ctx.withTx(async (tx) => {
    if ((await repo.paramTemplateNameTakenBy(tx, { name: body.name })) !== null) {
      throw new DomainError('CATALOG_NAME_TAKEN');
    }
    const now = ctx.clock.now();
    const row = await repo.insertParamTemplate(tx, {
      name: body.name,
      suggestedValues: orNull(body.suggestedValues),
      isEnabled: body.isEnabled,
      sortOrder: body.sortOrder,
      createdAt: now,
      updatedAt: now,
    });
    return toParamTemplate(row);
  });
}

export async function adminParamTemplateUpdate(
  ctx: Ctx,
  input: { id: string },
  body: ProductParamTemplateForm,
): Promise<ProductParamTemplate> {
  const id = Number(input.id);
  return ctx.withTx(async (tx) => {
    if ((await repo.paramTemplateNameTakenBy(tx, { name: body.name, exceptId: id })) !== null) {
      throw new DomainError('CATALOG_NAME_TAKEN');
    }
    const { won } = await repo.updateParamTemplate(tx, id, {
      name: body.name,
      suggestedValues: orNull(body.suggestedValues),
      isEnabled: body.isEnabled,
      sortOrder: body.sortOrder,
      updatedAt: ctx.clock.now(),
    });
    if (!won) throw new DomainError('CATALOG_PARAM_TEMPLATE_NOT_FOUND');
    const row = await repo.findParamTemplate(tx, id);
    if (!row) throw new DomainError('CATALOG_PARAM_TEMPLATE_NOT_FOUND');
    return toParamTemplate(row);
  });
}

export async function adminParamTemplateSetEnabled(
  ctx: Ctx,
  input: { id: string },
  body: { isEnabled: boolean },
): Promise<ProductParamTemplate> {
  const id = Number(input.id);
  return ctx.withTx(async (tx) => {
    const row = await repo.findParamTemplate(tx, id);
    if (!row) throw new DomainError('CATALOG_PARAM_TEMPLATE_NOT_FOUND');
    if (row.isEnabled !== body.isEnabled) {
      const { won } = await repo.setParamTemplateEnabled(tx, {
        id,
        from: row.isEnabled,
        to: body.isEnabled,
        now: ctx.clock.now(),
      });
      if (!won) throw new DomainError('CATALOG_PARAM_TEMPLATE_NOT_FOUND');
    }
    const updated = await repo.findParamTemplate(tx, id);
    if (!updated) throw new DomainError('CATALOG_PARAM_TEMPLATE_NOT_FOUND');
    return toParamTemplate(updated);
  });
}

/**
 * Delete a template.
 *
 * `product_params.template_id` is `ON DELETE SET NULL`, and this is a soft
 * delete anyway, so the parameters already copied onto products keep their
 * name and value. A template is a typing aid, not a source of truth.
 */
export async function adminParamTemplateDelete(ctx: Ctx, input: { id: string }): Promise<void> {
  const id = Number(input.id);
  await ctx.withTx(async (tx) => {
    const { won } = await repo.softDeleteParamTemplate(tx, { id, now: ctx.clock.now() });
    if (!won) throw new DomainError('CATALOG_PARAM_TEMPLATE_NOT_FOUND');
  });
}

function toParamTemplate(row: repo.ParamTemplateRow): ProductParamTemplate {
  return {
    id: String(row.id),
    name: row.name,
    suggestedValues: row.suggestedValues,
    isEnabled: row.isEnabled,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// protections (服务保障)
// ---------------------------------------------------------------------------

export async function adminProtectionList(
  ctx: Ctx,
  query: {
    keyword?: string | undefined;
    isEnabled?: boolean | undefined;
    sortBy?: 'id' | 'sortOrder' | 'title' | undefined;
    sortOrder?: 'asc' | 'desc' | undefined;
  } & PageQuery,
): Promise<{ items: ProductProtection[]; total: number; page: number; pageSize: number }> {
  const { rows, total } = await repo.listProtections(ctx.db, {
    keyword: query.keyword,
    isEnabled: query.isEnabled,
    sortBy: query.sortBy,
    sortOrder: query.sortOrder,
    ...pageBounds(query),
  });
  return { items: rows.map(toProtection), total, page: query.page, pageSize: query.pageSize };
}

export async function adminProtectionCreate(
  ctx: Ctx,
  body: ProductProtectionForm,
): Promise<ProductProtection> {
  return ctx.withTx(async (tx) => {
    if ((await repo.protectionTitleTakenBy(tx, { title: body.title })) !== null) {
      throw new DomainError('CATALOG_NAME_TAKEN');
    }
    const now = ctx.clock.now();
    const row = await repo.insertProtection(tx, {
      title: body.title,
      content: orNull(body.content),
      iconUrl: orNull(body.iconUrl),
      isEnabled: body.isEnabled,
      sortOrder: body.sortOrder,
      createdAt: now,
      updatedAt: now,
    });
    return toProtection(row);
  });
}

export async function adminProtectionUpdate(
  ctx: Ctx,
  input: { id: string },
  body: ProductProtectionForm,
): Promise<ProductProtection> {
  const id = Number(input.id);
  return ctx.withTx(async (tx) => {
    if ((await repo.protectionTitleTakenBy(tx, { title: body.title, exceptId: id })) !== null) {
      throw new DomainError('CATALOG_NAME_TAKEN');
    }
    const { won } = await repo.updateProtection(tx, id, {
      title: body.title,
      content: orNull(body.content),
      iconUrl: orNull(body.iconUrl),
      isEnabled: body.isEnabled,
      sortOrder: body.sortOrder,
      updatedAt: ctx.clock.now(),
    });
    if (!won) throw new DomainError('CATALOG_PROTECTION_NOT_FOUND');
    const row = await repo.findProtection(tx, id);
    if (!row) throw new DomainError('CATALOG_PROTECTION_NOT_FOUND');
    return toProtection(row);
  });
}

export async function adminProtectionSetEnabled(
  ctx: Ctx,
  input: { id: string },
  body: { isEnabled: boolean },
): Promise<ProductProtection> {
  const id = Number(input.id);
  return ctx.withTx(async (tx) => {
    const row = await repo.findProtection(tx, id);
    if (!row) throw new DomainError('CATALOG_PROTECTION_NOT_FOUND');
    if (row.isEnabled !== body.isEnabled) {
      const { won } = await repo.setProtectionEnabled(tx, {
        id,
        from: row.isEnabled,
        to: body.isEnabled,
        now: ctx.clock.now(),
      });
      if (!won) throw new DomainError('CATALOG_PROTECTION_NOT_FOUND');
    }
    const updated = await repo.findProtection(tx, id);
    if (!updated) throw new DomainError('CATALOG_PROTECTION_NOT_FOUND');
    return toProtection(updated);
  });
}

export async function adminProtectionDelete(ctx: Ctx, input: { id: string }): Promise<void> {
  const id = Number(input.id);
  await ctx.withTx(async (tx) => {
    const { won } = await repo.softDeleteProtection(tx, { id, now: ctx.clock.now() });
    if (!won) throw new DomainError('CATALOG_PROTECTION_NOT_FOUND');
  });
}

function toProtection(row: repo.ProtectionRow): ProductProtection {
  return {
    id: String(row.id),
    title: row.title,
    content: row.content,
    iconUrl: row.iconUrl,
    isEnabled: row.isEnabled,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt.toISOString(),
  };
}
