import { Text } from '@tarojs/components';
import { hasPerOrderLimit } from '@shop/contracts/catalog/per-order';
import { Card } from '@/ui/card';
import { shipText } from './activity';
import './promo-rules.scss';

/** 拼团有效期 in words: 「24 小时」「2 天」「30 分钟」. */
export function ttlText(seconds: number): string {
  const day = 24 * 3600;
  if (seconds >= day && seconds % day === 0) return `${seconds / day} 天`;
  if (seconds >= 3600) {
    const hours = Math.round((seconds / 3600) * 10) / 10;
    return `${hours} 小时`;
  }
  return `${Math.max(1, Math.round(seconds / 60))} 分钟`;
}

function limitLine(perOrderQuantity: number): string[] {
  return hasPerOrderLimit(perOrderQuantity) ? [`每单限购 ${perOrderQuantity} 件`] : [];
}

function Rules({ title, id, lines }: { title: string; id: string; lines: string[] }) {
  return (
    <Card title={title} className="promo-rules" id={id}>
      {lines.map((line) => (
        <Text key={line} className="promo-rules__line">
          {line}
        </Text>
      ))}
    </Card>
  );
}

/**
 * 拼团规则 (商品详情): how many make a team and for how long it stays open, that a paid seat
 * holds a place, that an unfilled team is cancelled and refunded (虚拟成团 is off), and that a
 * shopper has one team at a time per activity.
 */
export function GroupbuyRules({
  seatsRequired,
  groupTtlSeconds,
  perOrderQuantity,
}: {
  seatsRequired: number;
  groupTtlSeconds: number;
  perOrderQuantity: number;
}) {
  return (
    <Rules
      title="拼团规则"
      id="groupbuy-rules"
      lines={[
        `${seatsRequired} 人成团，开团后 ${ttlText(groupTtlSeconds)}内有效`,
        '付款后即占一个名额，人满即成团，商家随后发货',
        '到时间未凑齐，拼团自动取消，已付款项原路退回',
        '同一活动每人同时只能有一个团在拼',
        ...limitLine(perOrderQuantity),
      ]}
    />
  );
}

/** 预售说明 (商品详情): full payment only, when it ships, and the per-order limit. */
export function PresaleRules({
  shipAfterDays,
  perOrderQuantity,
}: {
  shipAfterDays: number;
  perOrderQuantity: number;
}) {
  return (
    <Rules
      title="预售说明"
      id="presale-rules"
      lines={[
        `全款预订，${shipText(shipAfterDays)}`,
        '下单时支付全部货款，无需另付尾款',
        ...limitLine(perOrderQuantity),
      ]}
    />
  );
}
