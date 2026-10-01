import { Text, View } from '@tarojs/components';
import type { RefundListItem } from '@shop/contracts/refund/schemas';
import { formatSpec } from '@/lib/spec';
import { navigate } from '@/platform';
import { Button } from '@/ui/button';
import { Image } from '@/ui/image';
import { Price } from '@/ui/price';
import { Pressable } from '@/ui/pressable';
import { Tag } from '@/ui/tag';
import type { RefundActionKey } from './actions';
import { awaitsReturn, canCancel, canHide, KIND_TEXT, refundStatusText } from './refund';
import './refund-card.scss';

/** The buttons a request offers, left to right; the last is the primary one where there is one. */
export function refundActions(
  refund: Pick<RefundListItem, 'status' | 'kind' | 'returnStage' | 'isAutomatic'>,
): Array<{ key: RefundActionKey; label: string; primary: boolean }> {
  const out: Array<{ key: RefundActionKey; label: string; primary: boolean }> = [];
  if (canHide(refund)) out.push({ key: 'hide', label: '删除记录', primary: false });
  if (canCancel(refund)) out.push({ key: 'cancel', label: '撤销申请', primary: false });
  if (awaitsReturn(refund)) {
    out.push({ key: 'returnShipment', label: '填写退货物流', primary: true });
  }
  return out;
}

/** A request in 我的售后: number, where it stands, the lines, the amount and its buttons. */
export function RefundCard({
  refund,
  onAction,
  busy,
}: {
  refund: RefundListItem;
  onAction: (key: RefundActionKey) => void;
  busy?: RefundActionKey | undefined;
}) {
  const actions = refundActions(refund);
  const status = refundStatusText(refund);
  return (
    <View className="refund-card">
      <Pressable
        role="link"
        label={`售后单 ${refund.refundNo}，${status}`}
        onClick={() => navigate({ route: 'refund', params: { id: refund.id } })}
      >
        <View className="refund-card__head">
          <View className="refund-card__head-left">
            <Tag tone="neutral">{KIND_TEXT[refund.kind]}</Tag>
            <Text className="refund-card__no">售后单号 {refund.refundNo}</Text>
          </View>
          <Text className="refund-card__status">{status}</Text>
        </View>
        {refund.items.map((item) => (
          <View key={item.orderItemId} className="refund-card__row">
            <View className="refund-card__thumb">
              <Image src={item.productImageUrl} radius="sm" size="small" />
            </View>
            <View className="refund-card__info">
              <Text className="refund-card__name">{item.productName}</Text>
              {item.specText ? (
                <Text className="refund-card__spec">{formatSpec(item.specText)}</Text>
              ) : null}
            </View>
            <Text className="refund-card__qty">×{item.quantity}</Text>
          </View>
        ))}
        <View className="refund-card__total">
          <Text className="refund-card__label">
            {refund.status === 'succeeded' ? '已退款' : '退款金额'}
          </Text>
          <Price
            value={refund.status === 'succeeded' ? refund.refundedAmount : refund.amount}
            size="md"
            tone="text"
          />
        </View>
      </Pressable>
      {actions.length > 0 ? (
        <View className="refund-card__actions">
          {actions.map((action) => (
            <Button
              key={action.key}
              size="sm"
              variant={action.primary ? 'primary' : 'outline'}
              loading={busy === action.key}
              onClick={() => onAction(action.key)}
            >
              {action.label}
            </Button>
          ))}
        </View>
      ) : null}
    </View>
  );
}
