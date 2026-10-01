import type { Metadata } from 'next';

import { RequirePermission } from '@/admin/session/can';

import { VirtualCardsPage } from './virtual-cards';

export const metadata: Metadata = { title: '卡密库存' };

/**
 * The URL resolves to 商品列表's menu entry (catalog:product:read); the card
 * pool also needs its own atom, so a role without it gets the 403 page here
 * rather than a list that toasts 没有权限.
 */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <RequirePermission permission="catalog:card:read">
      <VirtualCardsPage productId={id} />
    </RequirePermission>
  );
}
