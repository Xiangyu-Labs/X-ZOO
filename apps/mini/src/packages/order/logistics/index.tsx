import { useState } from 'react';
import { Text, View } from '@tarojs/components';
import type { Shipment, ShipmentTracking } from '@shop/contracts/order/order.fulfil.schemas';
import { useRouteQuery } from '@shop/api-client/react';
import { formatDateTime } from '@/lib/format';
import { callPhone, copyText, usePullToRefresh, useRouteParams } from '@/platform';
import { LoginCard } from '@/session/login-card';
import { useSignedIn } from '@/session/session';
import { Card } from '@/ui/card';
import { Empty } from '@/ui/empty';
import { ErrorBlock } from '@/ui/error-block';
import { Image } from '@/ui/image';
import { PageShell } from '@/ui/page-shell';
import { Pressable } from '@/ui/pressable';
import { CellSkeleton } from '@/ui/skeleton';
import { Tabs } from '@/ui/tabs';
import { Tag } from '@/ui/tag';
import { Timeline } from '@/ui/timeline';
import './index.scss';

const STATE_TEXT: Record<ShipmentTracking['state'], string> = {
  unknown: '运输中',
  in_transit: '运输中',
  delivering: '派送中',
  delivered: '已签收',
  exception: '物流异常',
};

/**
 * 物流信息 (`logistics`, `packages/order/logistics/index?orderId=&shipmentId=`). One tab per
 * parcel when the order shipped in several; each shows the carrier and number (copyable), the
 * courier's trail as a timeline, and what is in it. Never shared.
 */
export default function LogisticsPage() {
  const { orderId = '', shipmentId } = useRouteParams('logistics');
  return (
    <PageShell title="物流信息">
      <LoginCard
        reason="登录后查看物流"
        redirect={{
          route: 'logistics',
          params: { orderId, ...(shipmentId ? { shipmentId } : {}) },
        }}
      >
        {orderId ? (
          <Parcels orderId={orderId} initial={shipmentId} />
        ) : (
          <Empty image="order" title="没有找到这个订单" />
        )}
      </LoginCard>
    </PageShell>
  );
}

function Parcels({ orderId, initial }: { orderId: string; initial?: string | undefined }) {
  const signedIn = useSignedIn();
  const shipments = useRouteQuery(
    'order.myShipments',
    { params: { id: orderId } },
    { enabled: signedIn },
  );
  const [chosen, setChosen] = useState(initial);
  usePullToRefresh(() => shipments.refetch());

  if (shipments.isError) {
    return <ErrorBlock error={shipments.error} onRetry={() => shipments.refetch()} />;
  }
  if (!shipments.data) return <CellSkeleton rows={5} />;
  const parcels = shipments.data.items.filter((s) => s.status !== 'cancelled');
  if (parcels.length === 0) {
    return <Empty image="order" title="还没有发货" description="商家发货后，这里会显示物流信息" />;
  }
  const current = parcels.find((p) => p.id === chosen) ?? parcels[0]!;

  return (
    <View className="logistics">
      {parcels.length > 1 ? (
        <Tabs
          sticky
          value={current.id}
          onChange={setChosen}
          items={parcels.map((parcel, index) => ({ key: parcel.id, label: `包裹${index + 1}` }))}
        />
      ) : null}
      <View className="logistics__body">
        <ParcelView key={current.id} parcel={current} />
      </View>
    </View>
  );
}

function ParcelView({ parcel }: { parcel: Shipment }) {
  return (
    <>
      {parcel.deliveryMode === 'express' ? (
        <ExpressTrail parcel={parcel} />
      ) : parcel.deliveryMode === 'merchant_delivery' ? (
        <Card title="商家配送">
          <Text className="logistics__line">配送员 {parcel.courierName ?? '—'}</Text>
          {parcel.courierPhone ? (
            <Pressable
              label={`拨打配送员电话 ${parcel.courierPhone}`}
              className="logistics__link"
              onClick={() => callPhone(parcel.courierPhone!)}
            >
              {parcel.courierPhone}
            </Pressable>
          ) : null}
        </Card>
      ) : (
        <Card title="无需物流">
          <Text className="logistics__line">{parcel.virtualContent ?? '商品已发放，无需物流'}</Text>
        </Card>
      )}
      <Card
        title={`包裹内商品（${parcel.lines.reduce((sum, line) => sum + line.quantity, 0)} 件）`}
      >
        <View className="logistics__lines">
          {parcel.lines.map((line) => (
            <View key={line.orderItemId} className="logistics__item">
              <View className="logistics__thumb">
                <Image src={line.productImageUrl} radius="sm" size="small" />
              </View>
              <Text className="logistics__qty">×{line.quantity}</Text>
            </View>
          ))}
        </View>
      </Card>
    </>
  );
}

function ExpressTrail({ parcel }: { parcel: Shipment }) {
  const signedIn = useSignedIn();
  const tracking = useRouteQuery(
    'order.myShipmentTracking',
    { params: { id: parcel.id } },
    { enabled: signedIn },
  );
  const trackingNo = parcel.trackingNo ?? tracking.data?.trackingNo ?? null;
  const company = parcel.expressCompanyName ?? tracking.data?.expressCompanyName ?? '快递';
  const data = tracking.data;

  return (
    <>
      <Card>
        <View className="logistics__head">
          <View className="logistics__head-main">
            <Text className="logistics__company">{company}</Text>
            {trackingNo ? (
              <View className="logistics__no-row">
                <Text className="logistics__no">运单号 {trackingNo}</Text>
                <Pressable
                  label="复制运单号"
                  className="logistics__link"
                  onClick={() => copyText(trackingNo)}
                >
                  复制
                </Pressable>
              </View>
            ) : null}
          </View>
          {data?.available ? (
            <Tag tone={data.state === 'exception' ? 'danger' : 'primary'}>
              {STATE_TEXT[data.state]}
            </Tag>
          ) : null}
        </View>
      </Card>
      <Card title="物流轨迹">
        {tracking.isPending ? (
          <CellSkeleton rows={3} />
        ) : tracking.isError ? (
          <ErrorBlock error={tracking.error} onRetry={() => tracking.refetch()} />
        ) : data && data.available && data.traces.length > 0 ? (
          <Timeline
            items={data.traces.map((trace, index) => ({
              key: `${trace.at}-${index}`,
              title: trace.context,
              time: formatDateTime(trace.at),
            }))}
          />
        ) : (
          <Text className="logistics__empty">
            {parcel.dispatchedAt ? `${formatDateTime(parcel.dispatchedAt)} 已发货。` : ''}
            暂无物流轨迹，可复制运单号到快递公司查询
          </Text>
        )}
      </Card>
    </>
  );
}
