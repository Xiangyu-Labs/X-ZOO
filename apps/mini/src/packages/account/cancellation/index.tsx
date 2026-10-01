import { useState } from 'react';
import { Text, View } from '@tarojs/components';
import type { ResponseOf } from '@shop/api-client';
import { useRouteMutation, useRouteQuery } from '@shop/api-client/react';
import { RichContent } from '@/features/content/rich-content';
import { formatDateTime } from '@/lib/format';
import { navigate } from '@/platform';
import { LoginGate } from '@/session/login-card';
import { logout, useSignedIn } from '@/session/session';
import { Button } from '@/ui/button';
import { CellGroup } from '@/ui/cell';
import { Checkbox } from '@/ui/choice';
import { ErrorBlock } from '@/ui/error-block';
import { confirm, toast } from '@/ui/feedback';
import { Textarea } from '@/ui/field';
import { PageShell } from '@/ui/page-shell';
import { Result } from '@/ui/result';
import { CellSkeleton } from '@/ui/skeleton';
import { SubmitBar, errorMessage } from '../shared/form';
import './index.scss';

type CancellationRequest = NonNullable<ResponseOf<'user.currentCancellation'>['request']>;

const INVALIDATE = ['user.currentCancellation'] as const;

/** What a 注销 does, in the shop's words (the operator's 注销协议 follows it). */
const EFFECTS = [
  '提交后由商家审核，审核通过前可以随时撤回。',
  '审核通过后，昵称、头像、手机号等账号信息会被清除，所有设备退出登录，账号无法恢复。',
  '保存的发票抬头会被删除，账号内的优惠券等权益无法再使用。',
  '已有订单和已开具的发票会保留，用于售后和财务核对。',
];

/**
 * 注销账号 (`cancellation`, pages.md §2.6): what it does and the 注销协议 first, then a
 * confirmation; the request goes to an operator (no SMS), and the shopper is signed out. A
 * pending request shows its state and 撤回; signing in again is how to reach it.
 */
export default function CancellationPage() {
  const [submitted, setSubmitted] = useState(false);
  const signedIn = useSignedIn();
  if (submitted) {
    return (
      <PageShell title="注销账号">
        <Result
          status="waiting"
          title="已提交注销申请"
          description="已为你退出登录。审核通过前，重新登录后可在「设置 - 注销账号」撤回申请。"
          actions={
            <Button variant="outline" onClick={() => navigate({ route: 'home', params: {} })}>
              回到首页
            </Button>
          }
        />
      </PageShell>
    );
  }
  return (
    <PageShell title="注销账号" withBar={signedIn}>
      <LoginGate reason="登录后可以申请注销账号" redirect={{ route: 'cancellation', params: {} }}>
        <Cancellation onSubmitted={() => setSubmitted(true)} />
      </LoginGate>
    </PageShell>
  );
}

function Cancellation({ onSubmitted }: { onSubmitted: () => void }) {
  const signedIn = useSignedIn();
  const current = useRouteQuery('user.currentCancellation', {}, { enabled: signedIn });
  if (current.isPending) return <CellSkeleton rows={4} />;
  if (current.isError) {
    return <ErrorBlock error={current.error} onRetry={() => current.refetch()} />;
  }
  const request = current.data.request;
  if (request?.status === 'pending') return <Pending request={request} />;
  return <Apply previous={request} onSubmitted={onSubmitted} />;
}

function Pending({ request }: { request: CancellationRequest }) {
  const withdraw = useRouteMutation('user.withdrawCancellation', { invalidate: INVALIDATE });

  async function withdrawIt() {
    const ok = await confirm({
      title: '撤回注销申请',
      content: '撤回后账号照常使用。',
      confirmText: '撤回',
    });
    if (!ok) return;
    try {
      await withdraw.mutateAsync({});
      toast.success('已撤回');
    } catch (error) {
      toast.text(errorMessage(error));
    }
  }

  return (
    <Result
      status="pending"
      title="注销申请审核中"
      description={`提交于 ${formatDateTime(request.createdAt)}，审核通过前可以撤回。`}
      actions={
        <Button variant="outline" loading={withdraw.isPending} onClick={() => withdrawIt()}>
          撤回申请
        </Button>
      }
    >
      {request.reason ? <Text className="cancellation__reason">原因：{request.reason}</Text> : null}
    </Result>
  );
}

function Apply({
  previous,
  onSubmitted,
}: {
  previous: CancellationRequest | null;
  onSubmitted: () => void;
}) {
  const agreement = useRouteQuery('system.agreementGet', { params: { key: 'cancellation' } });
  const request = useRouteMutation('user.requestCancellation', { invalidate: INVALIDATE });
  const [reason, setReason] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!agreed) {
      toast.text('请先阅读并同意《注销协议》');
      return;
    }
    const ok = await confirm({
      title: '确认注销账号',
      content: '提交后将退出登录，审核通过后账号信息无法恢复。',
      confirmText: '确认注销',
      danger: true,
    });
    if (!ok) return;
    const note = reason.trim();
    setBusy(true);
    try {
      await request.mutateAsync({ body: note ? { reason: note } : {} });
    } catch (error) {
      setBusy(false);
      toast.text(errorMessage(error));
      return;
    }
    await logout();
    onSubmitted();
  }

  return (
    <View className="account-page">
      {previous?.status === 'rejected' ? (
        <Text className="cancellation__notice">
          上次的注销申请未通过{previous.reviewRemark ? `：${previous.reviewRemark}` : '。'}
        </Text>
      ) : null}
      <CellGroup title="注销后">
        <View className="cancellation__effects">
          {EFFECTS.map((line) => (
            <Text key={line} className="cancellation__effect">
              {line}
            </Text>
          ))}
        </View>
      </CellGroup>
      <CellGroup title={agreement.data?.title || '注销协议'}>
        <View className="cancellation__agreement">
          {agreement.isPending ? (
            <CellSkeleton rows={3} />
          ) : agreement.isError ? (
            <ErrorBlock compact error={agreement.error} onRetry={() => agreement.refetch()} />
          ) : agreement.data.content.trim() ? (
            <RichContent html={agreement.data.content} />
          ) : (
            <Text className="cancellation__effect">以上即为注销说明。</Text>
          )}
        </View>
      </CellGroup>
      <CellGroup title="注销原因（选填）">
        <Textarea
          label="注销原因"
          placeholder="可以告诉我们原因，帮助我们改进"
          value={reason}
          maxLength={500}
          onChange={setReason}
        />
      </CellGroup>
      <View className="cancellation__agree">
        <Checkbox label="我已阅读并同意《注销协议》" checked={agreed} onChange={setAgreed} />
      </View>
      <SubmitBar>
        <Button
          size="lg"
          variant="danger"
          block
          loading={busy}
          disabled={!agreement.isSuccess}
          onClick={() => submit()}
        >
          申请注销
        </Button>
      </SubmitBar>
    </View>
  );
}
