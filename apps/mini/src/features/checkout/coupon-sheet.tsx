import { Text, View } from '@tarojs/components';
import { Radio } from '@/ui/choice';
import { CouponCard, couponValidity } from '@/ui/coupon-card';
import { Sheet } from '@/ui/sheet';
import { couponReason, type ApplicableCoupons } from './checkout-view';
import './checkout-sheets.scss';

export interface CouponSheetProps {
  visible: boolean;
  onClose: () => void;
  coupons: ApplicableCoupons | undefined;
  /** The coupon priced with now; `null` for none. */
  selectedId: string | null;
  onPick: (id: string | null) => void;
}

/**
 * 选择优惠券 at checkout: the shopper's coupons for these lines, usable first (the server's
 * order), the unusable greyed with their reason; 不使用优惠券 on top.
 */
export function CouponSheet({ visible, onClose, coupons, selectedId, onPick }: CouponSheetProps) {
  const rows = coupons?.items ?? [];
  return (
    <Sheet visible={visible} onClose={onClose} title="选择优惠券" height="tall">
      <View className="checkout-sheet__list" id="coupon-sheet">
        <Radio
          label="不使用优惠券"
          checked={selectedId === null}
          onChange={() => onPick(null)}
          className="checkout-sheet__none"
        />
        {rows.length === 0 ? (
          <Text className="checkout-sheet__empty">暂无可用的优惠券</Text>
        ) : (
          rows.map((row) => (
            <CouponCard
              key={row.coupon.id}
              title={row.coupon.title}
              amount={row.coupon.discountAmount}
              minSpend={row.coupon.minSpend}
              scope={row.coupon.scope}
              validity={couponValidity(row.coupon)}
              state={row.usable ? 'usable' : 'unusable'}
              reason={couponReason(row.reason)}
              selected={row.coupon.id === selectedId}
              onAction={row.usable ? () => onPick(row.coupon.id) : undefined}
            />
          ))
        )}
      </View>
    </Sheet>
  );
}
