import type { ResponseOf } from '@shop/api-client';
import { formatSpec } from '@/lib/spec';

/**
 * Choosing a variant (SkuSheet, design.md §4.4), as plain functions over the product's specs
 * and SKUs: which values can still be picked, which SKU the picks name, how many may be bought.
 */

export type SkuMatrix = Pick<ResponseOf<'catalog.productSkus'>, 'specs' | 'skus'>;
export type Sku = SkuMatrix['skus'][number];

/** Spec name → the picked value. */
export type SkuSelection = Readonly<Record<string, string>>;

export type ValueState = 'selected' | 'available' | 'sold-out';

/** The specs a shopper actually chooses between (a single-SKU product has none). */
export function specsOf(matrix: SkuMatrix): SkuMatrix['specs'] {
  return matrix.skus.length > 1 ? matrix.specs.filter((spec) => spec.values.length > 0) : [];
}

function matches(sku: Sku, selection: SkuSelection): boolean {
  return Object.entries(selection).every(([name, value]) => sku.specValues[name] === value);
}

/**
 * The first picks: every spec with a single value, and for a single-SKU product that SKU; or
 * the picks of `skuId` (a cart row being changed) when it is in stock.
 */
export function initialSelection(matrix: SkuMatrix, skuId?: string): SkuSelection {
  const preferred = skuId ? matrix.skus.find((sku) => sku.id === skuId && sku.stock > 0) : null;
  if (preferred) return { ...preferred.specValues };
  const out: Record<string, string> = {};
  for (const spec of specsOf(matrix)) {
    const only = spec.values.length === 1 ? spec.values[0] : undefined;
    if (only) out[spec.name] = only.value;
  }
  return out;
}

/** A value is sold out when no SKU in stock has it together with the other picks. */
export function valueState(
  matrix: SkuMatrix,
  selection: SkuSelection,
  specName: string,
  value: string,
): ValueState {
  if (selection[specName] === value) return 'selected';
  const others = { ...selection, [specName]: value };
  return matrix.skus.some((sku) => sku.stock > 0 && matches(sku, others))
    ? 'available'
    : 'sold-out';
}

/** Picks `value` for `specName`, or unpicks it when it was picked. */
export function toggleValue(
  selection: SkuSelection,
  specName: string,
  value: string,
): SkuSelection {
  if (selection[specName] === value) {
    const next = { ...selection };
    delete next[specName];
    return next;
  }
  return { ...selection, [specName]: value };
}

/** The specs still to pick, in order. */
export function missingSpecs(matrix: SkuMatrix, selection: SkuSelection): string[] {
  return specsOf(matrix)
    .map((spec) => spec.name)
    .filter((name) => selection[name] === undefined);
}

/** The SKU the picks name, once every spec is picked; a single-SKU product's only SKU. */
export function selectedSku(matrix: SkuMatrix, selection: SkuSelection): Sku | null {
  if (matrix.skus.length === 1) return matrix.skus[0] ?? null;
  if (missingSpecs(matrix, selection).length > 0) return null;
  return matrix.skus.find((sku) => matches(sku, selection)) ?? null;
}

export interface PurchaseRules {
  minPurchaseQuantity?: number | undefined;
  purchaseLimitMode?: 'none' | 'per_order' | 'lifetime' | undefined;
  purchaseLimitQuantity?: number | null | undefined;
}

/** Fewest and most one order may take of `sku`: stock, and the product's 限购. */
export function quantityBounds(
  sku: Sku | null,
  rules: PurchaseRules,
): { min: number; max: number } {
  const min = Math.max(1, rules.minPurchaseQuantity ?? 1);
  let max = sku ? sku.stock : Number.MAX_SAFE_INTEGER;
  if (
    rules.purchaseLimitMode &&
    rules.purchaseLimitMode !== 'none' &&
    rules.purchaseLimitQuantity
  ) {
    max = Math.min(max, rules.purchaseLimitQuantity);
  }
  return { min, max: Math.max(0, Math.min(max, 9999)) };
}

/** What the sheet's header says next to the price: the picks, or what is still missing. */
export function selectionText(matrix: SkuMatrix, selection: SkuSelection): string {
  const missing = missingSpecs(matrix, selection);
  if (missing.length > 0) return `请选择 ${missing.join(' ')}`;
  const sku = selectedSku(matrix, selection);
  return sku && sku.specText ? `已选 ${formatSpec(sku.specText)}` : '';
}
