import { useEffect, useRef, useState } from 'react';
import { Text, View } from '@tarojs/components';
import type { ResponseOf } from '@shop/api-client';
import type { StorefrontRoute } from '@shop/api-client/routes';
import { useRouteQuery } from '@shop/api-client/react';
import { claimFailureText, useClaimCoupon } from '@/features/coupon/use-claim';
import { requireLogin, useSignedIn } from '@/session/session';
import { Cell } from '@/ui/cell';
import { CouponCard, couponValidity, type CouponCardState } from '@/ui/coupon-card';
import { toast } from '@/ui/feedback';
import { Sheet } from '@/ui/sheet';
import { Tag } from '@/ui/tag';
import { claimableInput } from './secondary-reads';
import './product-coupons.scss';

type Claimable = ResponseOf<'coupon.claimableList'>['items'][number];

const yuan = (money: string) => money.replace(/\.00$/, '');

/** 「满99减10」, 「无门槛减5」: the short form on the 领券 row. */
export function couponShort(coupon: Pick<Claimable, 'minSpend' | 'discountAmount'>): string {
  const off = `减${yuan(coupon.discountAmount)}`;
  return Number(coupon.minSpend) > 0 ? `满${yuan(coupon.minSpend)}${off}` : `无门槛${off}`;
}

export function claimState(coupon: Claimable): CouponCardState {
  if (coupon.canClaim === false) return coupon.claimedCount ? 'claimed' : 'sold-out';
  if (coupon.remainingCount === 0) return 'sold-out';
  return 'claimable';
}

/**
 * 领券 on 商品详情: the coupons one can claim that this product counts towards, as a row that
 * opens a sheet of `CouponCard`s with 领取. The server narrows the list (`productId`, H4): the
 * shop-wide ones, those naming the product, and those naming a category it is filed under
 * (COUPON-009).
 */
export function ProductCoupons({
  productId,
  redirect,
}: {
  productId: string;
  redirect: StorefrontRoute;
}) {
  const signedIn = useSignedIn();
  const list = useRouteQuery('coupon.claimableList', claimableInput(productId));
  const claim = useClaimCoupon();
  const [open, setOpen] = useState(false);
  const [claiming, setClaiming] = useState<string | null>(null);
  const inFlight = useRef(false);

  // A sign-in changes `canClaim` from null to an answer.
  const lastSignedIn = useRef(signedIn);
  const { refetch } = list;
  useEffect(() => {
    if (lastSignedIn.current === signedIn) return;
    lastSignedIn.current = signedIn;
    void refetch();
  }, [signedIn, refetch]);

  const coupons = list.data?.items ?? [];
  if (coupons.length === 0) return null;

  const take = async (coupon: Claimable) => {
    // Set before the login check is awaited: `claiming` state lands a render later, so a quick
    // second tap would otherwise claim twice. One claim at a time, as the decor host does.
    if (inFlight.current) return;
    inFlight.current = true;
    if (!(await requireLogin(redirect).catch(() => false))) {
      inFlight.current = false;
      return;
    }
    setClaiming(coupon.templateId);
    claim.mutate(
      { params: { id: coupon.templateId } },
      {
        onSuccess: () => toast.success('领取成功'),
        onError: (error) => toast.text(claimFailureText(error)),
        onSettled: () => {
          inFlight.current = false;
          setClaiming(null);
        },
      },
    );
  };

  return (
    <>
      <Cell
        title="领券"
        label="领取优惠券"
        onClick={() => setOpen(true)}
        value={
          <View className="product-coupons__tags">
            {coupons.slice(0, 2).map((coupon) => (
              <Tag key={coupon.templateId} variant="outline">
                {couponShort(coupon)}
              </Tag>
            ))}
          </View>
        }
      />
      <Sheet visible={open} onClose={() => setOpen(false)} title="优惠券" height="tall">
        <Text className="product-coupons__hint">领取后结算时自动使用最优惠的券</Text>
        <View className="product-coupons__list" id="product-coupons">
          {coupons.map((coupon) => {
            const state = claimState(coupon);
            return (
              <CouponCard
                key={coupon.templateId}
                title={coupon.name}
                amount={coupon.discountAmount}
                minSpend={coupon.minSpend}
                scope={coupon.scope}
                validity={couponValidity(coupon)}
                state={state}
                busy={claiming === coupon.templateId}
                onAction={state === 'claimable' ? () => take(coupon) : undefined}
              />
            );
          })}
        </View>
      </Sheet>
    </>
  );
}
