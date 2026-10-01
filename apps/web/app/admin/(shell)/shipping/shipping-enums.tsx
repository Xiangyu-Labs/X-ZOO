'use client';

import type { ShippingChargeMode } from '@shop/contracts/shipping/schemas';

import type { StatusMap } from '@/admin/kit/status-tag';

/**
 * The shipping enums, in one file next to the pages.
 *
 * The key is the contract's own union, so dropping a charge mode from the
 * contract is a compile error here rather than a blank cell in production.
 */

export const SHIPPING_CHARGE_MODE: StatusMap<ShippingChargeMode> = {
  quantity: { label: '按件数', color: 'blue' },
  weight: { label: '按重量', color: 'cyan' },
  volume: { label: '按体积', color: 'geekblue' },
};

/** The unit each mode counts in, shown beside the 首/续 inputs. */
export const SHIPPING_CHARGE_UNIT: Record<ShippingChargeMode, string> = {
  quantity: '件',
  weight: 'kg',
  volume: 'm³',
};
