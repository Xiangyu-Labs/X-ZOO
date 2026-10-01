import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { routeQueryOptions, useApiClient } from '@shop/api-client/react';
import { useDisplay } from '@/app-config';

/**
 * The reads 商品详情 makes besides the product itself, each keyed by the product id alone. The
 * page's sections and `usePrefetchProductReads` build their inputs here, so a prefetch lands
 * in the cache entry the section reads.
 */

/** 拼团 / 预售 lists change rarely; one card per kind is enough for the entry bar. */
export const ACTIVITY_STALE_TIME = 5 * 60_000;
export const activityListInput = (productId: string) => ({ query: { productId, pageSize: 1 } });

/** 领券: the coupons this product counts towards. */
export const claimableInput = (productId: string) => ({ query: { productId, pageSize: 20 } });

/** 评价: the first two reviews under the summary. */
export const firstReviewsInput = (id: string) => ({ params: { id }, query: { pageSize: 2 } });

/** 为你推荐: not tied to the product (one more than shown, as the product may be in it). */
export const RECOMMENDED_STALE_TIME = 5 * 60_000;
export const RECOMMENDED_INPUT = { query: { feature: 'recommended' as const, pageSize: 7 } };

/**
 * Starts 商品详情's secondary reads together with `catalog.productDetail`, from the id in the
 * route, instead of after the product has answered and the page below it has mounted: one
 * round trip sooner for the 拼团 / 预售 bars, 领券, 评价 and 为你推荐.
 *
 * A prefetch never throws. A read that fails here is asked again by its section when it mounts
 * (and shows nothing, as before, if it fails again); a product that is gone (404) still shows
 * 「商品已下架」, whatever these answered. 评价 is asked for even when the product turns out to
 * have none: one small request, against a round trip for every product that has some.
 */
export function usePrefetchProductReads(productId: string): void {
  const queryClient = useQueryClient();
  const api = useApiClient();
  const display = useDisplay();
  const reviews = display.productReviews;
  const recommended = display.productRecommendations;
  useEffect(() => {
    if (!productId) return;
    const stale = { staleTime: ACTIVITY_STALE_TIME };
    const input = activityListInput(productId);
    void queryClient.prefetchQuery(routeQueryOptions(api, 'groupbuy.list', input, stale));
    void queryClient.prefetchQuery(routeQueryOptions(api, 'presale.list', input, stale));
    void queryClient.prefetchQuery(
      routeQueryOptions(api, 'coupon.claimableList', claimableInput(productId)),
    );
    if (reviews) {
      void queryClient.prefetchQuery(
        routeQueryOptions(api, 'catalog.productReviews', firstReviewsInput(productId)),
      );
    }
    if (recommended) {
      void queryClient.prefetchQuery(
        routeQueryOptions(api, 'catalog.productList', RECOMMENDED_INPUT, {
          staleTime: RECOMMENDED_STALE_TIME,
        }),
      );
    }
  }, [productId, reviews, recommended, queryClient, api]);
}
