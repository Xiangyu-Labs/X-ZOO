import { useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { routeQueryOptions, useApiClient, useRouteMutation } from '@shop/api-client/react';
import type { StorefrontRoute } from '@shop/api-client/routes';
import { SkuSheet } from '@/features/product/sku-sheet';
import { specsOf, type SkuMatrix } from '@/features/product/sku-select';
import { requireLogin } from '@/session/session';
import { toast } from '@/ui/feedback';
import type { ProductCardData } from '@/ui/product-card';
import { errorMessage } from '@/lib/error-message';

/** The product a list's 加购 button was tapped on. */
export type QuickAddProduct = Pick<ProductCardData, 'id' | 'name' | 'imageUrl' | 'price'>;

export interface QuickAdd {
  /** 加购 on a card: sign in if needed, then add at once (one SKU) or open the SkuSheet. */
  add: (product: QuickAddProduct) => Promise<void>;
  /** Render it once on the page. */
  sheet: ReactNode;
}

/**
 * 加购 from a product list (分类, 商品列表, 精品推荐, 购物车「为你推荐」). A product with one SKU
 * goes straight in; one with specs opens the SkuSheet on the list. Signing in comes first
 * (`requireLogin`): a shopper who must share a phone number lands on the login page, which
 * comes back to `redirect`.
 */
export function useQuickAdd(redirect: StorefrontRoute): QuickAdd {
  const api = useApiClient();
  const queryClient = useQueryClient();
  const addItem = useRouteMutation('cart.addItem', { invalidate: ['cart.list', 'cart.count'] });
  const [target, setTarget] = useState<QuickAddProduct | null>(null);
  const [matrix, setMatrix] = useState<SkuMatrix | undefined>(undefined);
  const [open, setOpen] = useState(false);

  function put(skuId: string, quantity: number, after?: () => void): Promise<void> {
    return addItem.mutateAsync({ body: { skuId, quantity } }).then(
      () => {
        toast.success('已加入购物车');
        after?.();
      },
      (error: unknown) => toast.text(errorMessage(error)),
    );
  }

  async function add(product: QuickAddProduct) {
    if (!(await requireLogin(redirect))) return;
    setTarget(product);
    setMatrix(undefined);
    let loaded: SkuMatrix;
    try {
      loaded = await queryClient.fetchQuery(
        routeQueryOptions(api, 'catalog.productSkus', { params: { id: product.id } }),
      );
    } catch (error) {
      toast.text(errorMessage(error, '商品信息加载失败'));
      return;
    }
    const only = loaded.skus.length === 1 ? loaded.skus[0] : undefined;
    if (only && specsOf(loaded).length === 0) {
      if (only.stock > 0) return put(only.id, 1);
      toast.text('商品已售罄');
      return;
    }
    setMatrix(loaded);
    setOpen(true);
  }

  const sheet = target ? (
    <SkuSheet
      visible={open}
      onClose={() => setOpen(false)}
      product={target}
      matrix={matrix}
      actions={['cart']}
      busy={addItem.isPending ? 'cart' : null}
      onConfirm={(_action, sku, quantity) => put(sku.id, quantity, () => setOpen(false))}
    />
  ) : null;

  return { add, sheet };
}
