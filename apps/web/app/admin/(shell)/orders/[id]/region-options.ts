import { cityTreePublic } from '@shop/contracts/shipping/shipping.city.contract';

import { callRoute } from '@/admin/api';
import type { CascaderOption } from '@/admin/kit/form/select-fields';

interface Node {
  name: string;
  children?: Node[] | undefined;
}

function toOption(node: Node): CascaderOption {
  const children = node.children?.length ? node.children.map(toOption) : undefined;
  return { label: node.name, value: node.name, ...(children ? { children } : {}) };
}

export const REGION_CACHE_KEY = 'shipping.cityTree.names';

/**
 * 省市区 by name — an order keeps the names, not ids. The shopper's address form
 * picks from this same tree, so a name typed here matches what they would pick.
 * The public read: whoever may change an address needs no 运费模板 permission.
 */
export async function loadRegionOptions(): Promise<CascaderOption[]> {
  const tree = await callRoute(cityTreePublic);
  return tree.items.map(toOption);
}
