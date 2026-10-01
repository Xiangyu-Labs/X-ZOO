import { Text, View } from '@tarojs/components';
import type { ResponseOf } from '@shop/api-client';
import { useInfiniteRouteQuery, useRouteMutation, useRouteQuery } from '@shop/api-client/react';
import { formatDateTime } from '@/lib/format';
import { navigate } from '@/platform';
import { LoginGate } from '@/session/login-card';
import { useSignedIn } from '@/session/session';
import { Button } from '@/ui/button';
import { Empty } from '@/ui/empty';
import { confirm, toast } from '@/ui/feedback';
import { InfiniteList } from '@/ui/infinite-list';
import { PageShell } from '@/ui/page-shell';
import { Pressable } from '@/ui/pressable';
import { CellSkeleton } from '@/ui/skeleton';
import { errorMessage } from '../shared/form';
import { MESSAGE_READS, messageRoute } from '../shared/message';
import './index.scss';

type Message = ResponseOf<'notification.myList'>['items'][number];

/**
 * 消息中心 (`messages`, pages.md §2.6): the shopper's 站内信, newest first. A message with a
 * `data.route` opens that page (and counts as read); one without opens 消息详情.
 */
export default function MessagesPage() {
  return (
    <PageShell title="消息中心">
      <LoginGate reason="登录后可以查看消息" redirect={{ route: 'messages', params: {} }}>
        <Messages />
      </LoginGate>
    </PageShell>
  );
}

function Messages() {
  const signedIn = useSignedIn();
  const list = useInfiniteRouteQuery(
    'notification.myList',
    { query: { pageSize: 20 } },
    { enabled: signedIn },
  );
  const unread = useRouteQuery('notification.myUnreadCount', {}, { enabled: signedIn });
  const markAll = useRouteMutation('notification.myMarkAllRead', { invalidate: MESSAGE_READS });
  const markRead = useRouteMutation('notification.myMarkRead', { invalidate: MESSAGE_READS });
  const remove = useRouteMutation('notification.myDelete', { invalidate: MESSAGE_READS });
  const unreadCount = unread.data?.unread ?? 0;

  async function open(message: Message) {
    const route = messageRoute(message.data);
    if (!route) {
      await navigate({ route: 'message', params: { id: message.id } });
      return;
    }
    if (!message.readAt) {
      // Seen by opening it; a failure here must not keep the shopper from the page.
      markRead.mutate({ params: { id: message.id }, body: {} });
    }
    await navigate(route);
  }

  async function readAll() {
    try {
      await markAll.mutateAsync({ body: {} });
      toast.success('已全部标为已读');
    } catch (error) {
      toast.text(errorMessage(error));
    }
  }

  async function removeOne(message: Message) {
    const ok = await confirm({ content: '删除这条消息？', confirmText: '删除', danger: true });
    if (!ok) return;
    try {
      await remove.mutateAsync({ params: { id: message.id } });
      toast.success('已删除');
    } catch (error) {
      toast.text(errorMessage(error));
    }
  }

  return (
    <View className="account-page">
      {unreadCount > 0 ? (
        <View className="messages__head">
          <Text>{unreadCount} 条未读</Text>
          <Button variant="text" size="sm" loading={markAll.isPending} onClick={() => readAll()}>
            全部已读
          </Button>
        </View>
      ) : null}
      <InfiniteList
        query={list}
        itemKey={(message) => message.id}
        skeleton={<CellSkeleton rows={5} />}
        empty={<Empty title="暂无消息" description="订单发货、售后进度等通知会出现在这里" />}
        renderItem={(message) => (
          <View className="message-row">
            <Pressable
              label={`${message.readAt ? '' : '未读，'}${message.title}`}
              role="link"
              className="message-row__main"
              onClick={() => open(message)}
            >
              <View className="message-row__title-line">
                {message.readAt ? null : <View className="message-row__dot" />}
                <Text className="message-row__title">{message.title}</Text>
              </View>
              <Text className="message-row__content">{message.content}</Text>
              <Text className="message-row__time">{formatDateTime(message.createdAt)}</Text>
            </Pressable>
            <Button
              variant="text"
              size="sm"
              label={`删除「${message.title}」`}
              className="message-row__delete"
              onClick={() => removeOne(message)}
            >
              删除
            </Button>
          </View>
        )}
      />
    </View>
  );
}
