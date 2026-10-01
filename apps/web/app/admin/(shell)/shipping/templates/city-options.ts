import { cityTreeAdmin } from '@shop/contracts/shipping/shipping.city.contract';
import type { CityProvince } from '@shop/contracts/shipping/schemas';

import { callRoute } from '@/admin/api';

export interface TreeOption {
  title: string;
  value: string;
  children?: TreeOption[] | undefined;
}

type CityNode =
  | CityProvince
  | CityProvince['children'][number]
  | CityProvince['children'][number]['children'][number];

function toOption(node: CityNode): TreeOption {
  const children = 'children' in node ? (node.children as CityNode[]).map(toOption) : undefined;
  return { title: node.name, value: node.id, ...(children ? { children } : {}) };
}

/** The 省市区 tree, fetched once and shared by every picker on the page. */
export async function loadCityOptions(): Promise<TreeOption[]> {
  const tree = await callRoute(cityTreeAdmin);
  return tree.items.map(toOption);
}
