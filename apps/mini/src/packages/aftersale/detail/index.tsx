import type { ReactNode } from 'react';
import { Text, View } from '@tarojs/components';
import type { RefundDetail } from '@shop/contracts/refund/schemas';
import { routeKey, useRouteQuery } from '@shop/api-client/react';
import { useRefetchOnShow } from '@/data/use-refetch-on-show';
import { assetUrl } from '@/lib/asset-url';
import { formatDateTime } from '@/lib/format';
import { formatSpec } from '@/lib/spec';
import { copyText, goBack, leaveFor, previewImages, useRouteParams } from '@/platform';
import { LoginCard } from '@/session/login-card';
import { useSignedIn } from '@/session/session';
import { ActionBar } from '@/ui/action-bar';
import { Button } from '@/ui/button';
import { Card } from '@/ui/card';
import { sessionFromOf, useContactIcon } from '@/ui/contact-button';
import { Empty } from '@/ui/empty';
import { ErrorBlock } from '@/ui/error-block';
import { Image } from '@/ui/image';
import { PageShell } from '@/ui/page-shell';
import { Price } from '@/ui/price';
import { Pressable } from '@/ui/pressable';
import { CellSkeleton } from '@/ui/skeleton';
import { Timeline } from '@/ui/timeline';
import { useRefundActions } from '../shared/actions';
import { refundActions } from '../shared/refund-card';
import { KIND_TEXT, refundStatusText } from '../shared/refund';
import './index.scss';

const LOG_TEXT: Record<RefundDetail['status'], string> = {
  applied: '提交申请',
  approved: '商家已同意',
  rejected: '商家已拒绝',
  processing: '退款处理中',
  succeeded: '退款成功',
  failed: '退款未完成，商家处理中',
  unknown: '退款处理中',
  cancelled: '已撤销',
};

/** The line under the status. */
export function statusNote(refund: RefundDetail): string | null {
  switch (refund.status) {
    case 'applied':
      return '商家会尽快处理你的申请';
    case 'approved':
      if (refund.kind === 'return_and_refund' && refund.returnStage === 'awaiting_shipment') {
        return '请将商品寄回下方地址，并填写退货物流';
      }
      if (refund.returnStage === 'shipped_back') return '商家收到商品后将为你退款';
      return '退款将原路退回';
    case 'rejected':
      return refund.rejectReason ? `原因：${refund.rejectReason}` : null;
    case 'succeeded':
      return '款项已原路退回，到账时间以支付渠道为准';
    case 'failed':
      return '商家正在处理，如有疑问请联系客服';
    default:
      return null;
  }
}

/**
 * 售后详情 (`refund`, `packages/aftersale/detail/index?id=`). Where the request stands, the
 * return address (copyable) and the parcel sent back, the progress as a timeline, the lines
 * and amount, what the shopper wrote; 客服 and the request's buttons in the bottom bar.
 */
export default function RefundDetailPage() {
  const { id = '' } = useRouteParams('refund');
  return (
    <PageShell title="售后详情" withBar>
      <LoginCard reason="登录后查看售后" redirect={{ route: 'refund', params: { id } }}>
        {id ? <Body id={id} /> : <Empty image="order" title="没有找到这个售后单" />}
      </LoginCard>
    </PageShell>
  );
}

function Body({ id }: { id: string }) {
  const signedIn = useSignedIn();
  const detail = useRouteQuery(
    'refund.myDetail',
    { params: { id } },
    // The merchant moves a request while the app is elsewhere: never show a cached state first.
    { enabled: signedIn, refetchOnMount: 'always' },
  );
  useRefetchOnShow(routeKey('refund.myDetail'));
  const actions = useRefundActions({ onHidden: () => void goBack() });
  const contact = useContactIcon(sessionFromOf('refund', id));

  if (detail.isError) {
    return <ErrorBlock error={detail.error} onRetry={() => detail.refetch()} />;
  }
  const refund = detail.data;
  if (!refund) return <CellSkeleton rows={6} />;

  const note = statusNote(refund);
  const logs = [...refund.logs].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const buttons = refundActions(refund);

  return (
    <View className="refund-detail" id="refund-detail">
      <View className="refund-detail__hero">
        <Text className="refund-detail__status">{refundStatusText(refund)}</Text>
        {note ? <Text className="refund-detail__note">{note}</Text> : null}
      </View>
      <View className="refund-detail__body">
        {refund.returnAddress && refund.returnStage !== 'not_required' ? (
          <Card
            title="退货地址"
            extra={
              <Pressable
                label="复制退货地址"
                className="refund-detail__link"
                onClick={() =>
                  copyText(
                    `${refund.returnAddress!.name} ${refund.returnAddress!.phone} ${refund.returnAddress!.address}`,
                  )
                }
              >
                复制
              </Pressable>
            }
          >
            <Text className="refund-detail__line">
              {refund.returnAddress.name} {refund.returnAddress.phone}
            </Text>
            <Text className="refund-detail__line refund-detail__line--muted">
              {refund.returnAddress.address}
            </Text>
          </Card>
        ) : null}
        {refund.returnTrackingNo ? (
          <Card title="退货物流">
            <Text className="refund-detail__line">
              {refund.returnExpressCompanyName ?? '快递'} {refund.returnTrackingNo}
            </Text>
          </Card>
        ) : null}
        <Card title="售后进度">
          <Timeline
            items={logs.map((log, index) => ({
              key: `${log.createdAt}-${index}`,
              title: log.message ?? LOG_TEXT[log.toStatus],
              time: formatDateTime(log.createdAt),
            }))}
          />
        </Card>
        <Card title="售后商品">
          {refund.items.map((item) => (
            <View key={item.orderItemId} className="refund-detail__item">
              <View className="refund-detail__thumb">
                <Image src={item.productImageUrl} radius="sm" size="small" />
              </View>
              <View className="refund-detail__info">
                <Text className="refund-detail__name">{item.productName}</Text>
                {item.specText ? (
                  <Text className="refund-detail__line--muted">{formatSpec(item.specText)}</Text>
                ) : null}
              </View>
              <Text className="refund-detail__line--muted">×{item.quantity}</Text>
            </View>
          ))}
          <View className="refund-detail__amount">
            <Text className="refund-detail__line--muted">
              {refund.includesFreight ? '退款金额（含运费）' : '退款金额'}
            </Text>
            <Price value={refund.amount} />
          </View>
        </Card>
        <Card title="申请信息">
          <Fact label="售后单号">
            <Text className="refund-detail__fact-value">{refund.refundNo}</Text>
            <Pressable
              label="复制售后单号"
              className="refund-detail__link"
              onClick={() => copyText(refund.refundNo)}
            >
              复制
            </Pressable>
          </Fact>
          <Fact label="订单编号">
            <Pressable
              role="link"
              label="查看订单"
              className="refund-detail__fact-value refund-detail__link"
              // Back to 订单详情 when 售后 was opened from it, rather than a second copy of it.
              onClick={() => leaveFor({ route: 'order', params: { id: refund.orderId } })}
            >
              {refund.orderNo}
            </Pressable>
          </Fact>
          <Fact label="售后类型">{KIND_TEXT[refund.kind]}</Fact>
          {refund.reason ? <Fact label="售后原因">{refund.reason}</Fact> : null}
          {refund.explanation ? <Fact label="补充说明">{refund.explanation}</Fact> : null}
          <Fact label="申请时间">{formatDateTime(refund.createdAt)}</Fact>
          {refund.images.length > 0 ? (
            <View className="refund-detail__images">
              {refund.images.map((url, index) => (
                <Pressable
                  key={url}
                  label={`查看凭证 ${index + 1}`}
                  className="refund-detail__image"
                  onClick={() =>
                    previewImages(
                      refund.images.map((image) => assetUrl(image) ?? image),
                      assetUrl(url) ?? url,
                    )
                  }
                >
                  <Image src={url} radius="sm" size="small" />
                </Pressable>
              ))}
            </View>
          ) : null}
        </Card>
      </View>
      {buttons.length > 0 || contact ? (
        <ActionBar icons={contact ? [contact] : []}>
          {buttons.map((action) => (
            <Button
              key={action.key}
              size="md"
              variant={action.primary ? 'primary' : 'outline'}
              loading={actions.busy?.key === action.key}
              onClick={() => actions.run(action.key, refund.id)}
            >
              {action.label}
            </Button>
          ))}
        </ActionBar>
      ) : null}
    </View>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View className="refund-detail__fact">
      <Text className="refund-detail__fact-label">{label}</Text>
      {typeof children === 'string' ? (
        <Text className="refund-detail__fact-value">{children}</Text>
      ) : (
        children
      )}
    </View>
  );
}
