import { Text, View } from '@tarojs/components';
import type { OrderDetail } from '@shop/contracts/order/schemas';
import type { Shipment } from '@shop/contracts/order/order.fulfil.schemas';
import { routeKey, useRouteQuery } from '@shop/api-client/react';
import { useRefetchOnShow } from '@/data/use-refetch-on-show';
import { formatDateTime, maskPhone } from '@/lib/format';
import { orderPrices } from '@/lib/order-price';
import { copyText, goBack, navigate, useRouteParams } from '@/platform';
import { LoginCard } from '@/session/login-card';
import { useSignedIn } from '@/session/session';
import { ActionBar, type ActionBarIcon } from '@/ui/action-bar';
import { Button } from '@/ui/button';
import { Card } from '@/ui/card';
import { Cell, CellGroup } from '@/ui/cell';
import { sessionFromOf, useContactIcon } from '@/ui/contact-button';
import { Countdown } from '@/ui/countdown';
import { Empty } from '@/ui/empty';
import { ErrorBlock } from '@/ui/error-block';
import { Icon } from '@/ui/icon';
import { orderActions, type OrderActionKey } from '@/ui/order-actions';
import { OrderItemRow } from '@/ui/order-card';
import { PageShell } from '@/ui/page-shell';
import { Pressable } from '@/ui/pressable';
import { CellSkeleton } from '@/ui/skeleton';
import { useOrderActions } from '../shared/actions';
import { PriceBreakdown } from '../shared/price-breakdown';
import { statusHeadline } from '../shared/status';
import './index.scss';

/**
 * 订单详情 (`order`, `packages/order/detail/index?id=` or `?outTradeNo=`). Opened by the order
 * id or number from the app, or by the payment's out-trade-no from WeChat's 发货 message
 * (C07), which `payment.status` turns into the order id first.
 *
 * Status header (with the time left to pay), parcels, address, lines, 金额明细, order facts,
 * 发票 and the bottom bar: 客服 and the buttons `orderActions` gives the order. Never shared.
 */
export default function OrderDetailPage() {
  const params = useRouteParams('order');
  return (
    <PageShell title="订单详情" withBar>
      <LoginCard
        reason="登录后查看订单"
        redirect={
          params.id
            ? { route: 'order', params: { id: params.id } }
            : { route: 'order', params: { outTradeNo: params.outTradeNo ?? '' } }
        }
      >
        <ResolvedOrder id={params.id} outTradeNo={params.outTradeNo} />
      </LoginCard>
    </PageShell>
  );
}

function ResolvedOrder({
  id,
  outTradeNo,
}: {
  id?: string | undefined;
  outTradeNo?: string | undefined;
}) {
  const signedIn = useSignedIn();
  const byPayment = useRouteQuery(
    'payment.status',
    { params: { outTradeNo: outTradeNo ?? '' } },
    { enabled: signedIn && !id && Boolean(outTradeNo) },
  );
  if (id) return <OrderBody id={id} />;
  if (!outTradeNo) return <Empty image="order" title="没有找到这个订单" />;
  if (byPayment.isError) {
    return <ErrorBlock error={byPayment.error} onRetry={() => byPayment.refetch()} />;
  }
  if (!byPayment.data) return <CellSkeleton rows={6} />;
  return <OrderBody id={byPayment.data.orderId} />;
}

/** Parcels exist once anything shipped. */
function mayHaveShipments(order: OrderDetail): boolean {
  return order.fulfillmentStatus !== 'unfulfilled';
}

function OrderBody({ id }: { id: string }) {
  const signedIn = useSignedIn();
  const detail = useRouteQuery(
    'order.detail',
    { params: { id } },
    // An order moves while the app is elsewhere (paid, shipped): never show a cached state first.
    { enabled: signedIn, refetchOnMount: 'always' },
  );
  useRefetchOnShow(routeKey('order.detail'));
  const order = detail.data;
  const shipments = useRouteQuery(
    'order.myShipments',
    { params: { id } },
    { enabled: signedIn && order !== undefined && mayHaveShipments(order) },
  );
  const actions = useOrderActions({ onDeleted: () => void goBack() });
  const contact = useContactIcon(sessionFromOf('order', id));

  if (detail.isError) {
    return <ErrorBlock error={detail.error} onRetry={() => detail.refetch()} />;
  }
  if (!order) return <CellSkeleton rows={6} />;

  const parcels = (shipments.data?.items ?? []).filter((s) => s.status !== 'cancelled');
  const all = orderActions(order);
  // 查看物流 is the parcel card above; 申请售后 sits on the items card.
  const barActions = all.filter(
    (a) => a.key !== 'aftersale' && !(a.key === 'logistics' && parcels.length > 0),
  );
  const canAftersale = all.some((a) => a.key === 'aftersale');
  const icons: ActionBarIcon[] = contact ? [contact] : [];
  const run = (key: OrderActionKey) => actions.run(key, order);
  const prices = orderPrices(order);

  return (
    <View className="order-detail" id="order-detail">
      <StatusHeader order={order} onExpired={() => detail.refetch()} />
      <View className="order-detail__body">
        {order.groupbuyTeamId !== null ? <TeamCell teamId={order.groupbuyTeamId} /> : null}
        {parcels.length > 0 ? <ParcelCard orderId={order.id} parcels={parcels} /> : null}
        <ReceiverCard order={order} />
        <Card
          title="商品"
          extra={
            canAftersale ? (
              <Pressable
                label="申请售后"
                role="link"
                className="order-detail__link"
                onClick={() => run('aftersale')}
              >
                申请售后
              </Pressable>
            ) : undefined
          }
        >
          {order.items.map((item) => (
            <OrderItemRow
              key={item.id}
              item={item}
              price={prices.unitPrices[item.id]}
              note={item.refundedQuantity > 0 ? `已退 ${item.refundedQuantity} 件` : undefined}
            />
          ))}
          <View className="order-detail__price">
            <PriceBreakdown order={order} />
          </View>
        </Card>
        <OrderFacts order={order} />
        {/* Only while the server would take the request (INVOICE-004): not unpaid, not fully
            refunded, not ¥0, not already requested. */}
        {order.invoiceRequestable ? (
          <CellGroup>
            <Cell
              title="发票"
              value="申请开票"
              onClick={() => navigate({ route: 'invoiceApply', params: { orderId: order.id } })}
            />
          </CellGroup>
        ) : null}
      </View>
      {barActions.length > 0 || icons.length > 0 ? (
        <ActionBar icons={icons}>
          {barActions.map((action) => (
            <Button
              key={action.key}
              size="md"
              variant={action.variant}
              loading={actions.busy?.key === action.key}
              onClick={() => run(action.key)}
            >
              {action.label}
            </Button>
          ))}
        </ActionBar>
      ) : null}
    </View>
  );
}

function StatusHeader({ order, onExpired }: { order: OrderDetail; onExpired: () => void }) {
  const { title, note } = statusHeadline(order);
  return (
    <View className="order-detail__hero">
      <Text className="order-detail__status">{title}</Text>
      {order.status === 'pending_payment' && order.payExpiresAt ? (
        <View className="order-detail__note">
          <Text>剩余 </Text>
          <Countdown endsAt={order.payExpiresAt} onEnd={onExpired} />
          <Text> 未付款将自动取消</Text>
        </View>
      ) : note ? (
        <Text className="order-detail__note">{note}</Text>
      ) : null}
    </View>
  );
}

/** 拼团: the team this order opened or joined, however it ended. */
function TeamCell({ teamId }: { teamId: string }) {
  return (
    <CellGroup>
      <Cell
        icon="group"
        title="拼团"
        value="查看拼团"
        label="查看拼团"
        onClick={() => navigate({ route: 'groupbuyTeam', params: { id: teamId } })}
      />
    </CellGroup>
  );
}

function ParcelCard({ orderId, parcels }: { orderId: string; parcels: Shipment[] }) {
  const latest = parcels[0];
  if (!latest) return null;
  const summary =
    latest.deliveryMode === 'express'
      ? `${latest.expressCompanyName ?? '快递'} ${latest.trackingNo ?? ''}`.trim()
      : latest.deliveryMode === 'merchant_delivery'
        ? '商家配送'
        : '虚拟发货';
  return (
    <CellGroup>
      <Cell
        icon="truck"
        title={parcels.length > 1 ? `已拆分为 ${parcels.length} 个包裹` : '物流信息'}
        description={summary}
        label="查看物流"
        onClick={() => navigate({ route: 'logistics', params: { orderId } })}
      />
    </CellGroup>
  );
}

function ReceiverCard({ order }: { order: OrderDetail }) {
  const { receiver } = order;
  const region = [receiver.province, receiver.city, receiver.district]
    .filter((part, index, all) => part && (index === 0 || part !== all[index - 1]))
    .join(' ');
  return (
    <Card className="order-detail__receiver">
      <View className="order-detail__receiver-row">
        <Icon name="location" className="order-detail__pin" />
        <View className="order-detail__receiver-main">
          <Text className="order-detail__receiver-name">
            {receiver.name} {maskPhone(receiver.phone)}
          </Text>
          <Text className="order-detail__receiver-address">
            {region} {receiver.detail}
          </Text>
        </View>
      </View>
    </Card>
  );
}

function OrderFacts({ order }: { order: OrderDetail }) {
  const rows: Array<[string, string]> = [
    ['下单时间', formatDateTime(order.createdAt)],
    ...(order.paidAt
      ? ([['付款时间', formatDateTime(order.paidAt)]] as Array<[string, string]>)
      : []),
    ...(order.shippedAt
      ? ([['发货时间', formatDateTime(order.shippedAt)]] as Array<[string, string]>)
      : []),
    ...(order.receivedAt
      ? ([['收货时间', formatDateTime(order.receivedAt)]] as Array<[string, string]>)
      : []),
    ...(order.cancelledAt
      ? ([['取消时间', formatDateTime(order.cancelledAt)]] as Array<[string, string]>)
      : []),
    ...(order.buyerRemark ? ([['订单备注', order.buyerRemark]] as Array<[string, string]>) : []),
  ];
  return (
    <Card title="订单信息">
      <View className="order-detail__fact">
        <Text className="order-detail__fact-label">订单编号</Text>
        <Text className="order-detail__fact-value" selectable>
          {order.orderNo}
        </Text>
        <Pressable
          label="复制订单编号"
          className="order-detail__copy"
          onClick={() => copyText(order.orderNo)}
        >
          复制
        </Pressable>
      </View>
      {rows.map(([label, value]) => (
        <View key={label} className="order-detail__fact">
          <Text className="order-detail__fact-label">{label}</Text>
          <Text className="order-detail__fact-value">{value}</Text>
        </View>
      ))}
    </Card>
  );
}
