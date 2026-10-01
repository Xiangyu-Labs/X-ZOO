import { useEffect } from 'react';
import { Text, View } from '@tarojs/components';
import { useRouteMutation, useRouteQuery } from '@shop/api-client/react';
import { formatDateTime } from '@/lib/format';
import { goBack, navigate, useRouteParams } from '@/platform';
import { LoginGate } from '@/session/login-card';
import { useSignedIn } from '@/session/session';
import { Button } from '@/ui/button';
import { Empty } from '@/ui/empty';
import { ErrorBlock } from '@/ui/error-block';
import { confirm, toast } from '@/ui/feedback';
import { PageShell } from '@/ui/page-shell';
import { CellSkeleton } from '@/ui/skeleton';
import { errorMessage } from '../shared/form';
import { MESSAGE_READS, messageRoute } from '../shared/message';
import './index.scss';

/**
 * 消息详情 (`message { id }`, pages.md §2.6). Reading does not mark the message read on the
 * server (the contract says so, against prefetches), so the page marks it once it is shown.
 */
export default function MessagePage() {
  const { id } = useRouteParams('message');
  return (
    <PageShell title="消息详情">
      {id ? (
        <LoginGate reason="登录后可以查看消息" redirect={{ route: 'message', params: { id } }}>
          <Message id={id} />
        </LoginGate>
      ) : (
        <Empty title="消息不存在" />
      )}
    </PageShell>
  );
}

function Message({ id }: { id: string }) {
  const signedIn = useSignedIn();
  const message = useRouteQuery('notification.myDetail', { params: { id } }, { enabled: signedIn });
  const markRead = useRouteMutation('notification.myMarkRead', { invalidate: MESSAGE_READS });
  const remove = useRouteMutation('notification.myDelete', { invalidate: MESSAGE_READS });
  const unread = message.data !== undefined && message.data.readAt === null;
  const { mutate } = markRead;

  useEffect(() => {
    if (unread) mutate({ params: { id }, body: {} });
  }, [unread, id, mutate]);

  if (message.isPending) return <CellSkeleton rows={3} />;
  if (message.isError) {
    return <ErrorBlock error={message.error} onRetry={() => message.refetch()} />;
  }
  const route = messageRoute(message.data.data);

  async function removeIt() {
    const ok = await confirm({ content: '删除这条消息？', confirmText: '删除', danger: true });
    if (!ok) return;
    try {
      await remove.mutateAsync({ params: { id } });
      toast.success('已删除');
      await goBack();
    } catch (error) {
      toast.text(errorMessage(error));
    }
  }

  return (
    <View className="message">
      <Text className="message__title">{message.data.title}</Text>
      <Text className="message__time">{formatDateTime(message.data.createdAt)}</Text>
      <Text className="message__content">{message.data.content}</Text>
      <View className="message__actions">
        {route ? (
          <Button variant="primary" block onClick={() => navigate(route)}>
            查看详情
          </Button>
        ) : null}
        <Button variant="text" block onClick={() => removeIt()}>
          删除消息
        </Button>
      </View>
    </View>
  );
}
