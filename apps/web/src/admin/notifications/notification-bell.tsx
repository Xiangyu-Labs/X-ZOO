'use client';

import { BellOutlined } from '@ant-design/icons';
import { Badge, Button, Card, Dropdown, Empty, List, Tooltip, Typography } from 'antd';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { InstantText } from '../kit/instant-text';
import type { AdminNotification } from './types';
import { useNotificationStream } from './use-notification-stream';

export const NOTIFICATION_STREAM_URL = '/admin-api/notifications/stream';

const STATUS_HINT: Record<string, string> = {
  connecting: '正在连接通知服务…',
  open: '通知服务已连接',
  unavailable: '通知服务暂不可用',
};

/**
 * Header bell: unread badge plus the most recent notifications.
 * Tolerates the stream endpoint not existing yet (it goes dormant and says so).
 */
export function NotificationBell() {
  const { notifications, unreadCount, status, markRead, markAllRead } =
    useNotificationStream(NOTIFICATION_STREAM_URL);
  // The status tooltip hangs below the bell, where the open panel's header is:
  // left up, it covers 全部已读 for as long as the pointer rests on the bell.
  const [panelOpen, setPanelOpen] = useState(false);
  const router = useRouter();

  // The whole row opens what it is about, and the panel gets out of the way.
  const open = (item: AdminNotification) => {
    markRead(item.id);
    if (!item.link) return;
    setPanelOpen(false);
    router.push(item.link);
  };

  const panel = (
    <Card
      size="small"
      style={{ width: 340 }}
      styles={{ body: { padding: 0, maxHeight: 420, overflow: 'auto' } }}
      title="通知"
      extra={
        <Button type="link" size="small" onClick={markAllRead} disabled={unreadCount === 0}>
          全部已读
        </Button>
      }
    >
      {notifications.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={STATUS_HINT[status] ?? '暂无通知'}
          style={{ padding: '24px 0' }}
        />
      ) : (
        <List
          size="small"
          dataSource={notifications}
          renderItem={(item) => (
            <List.Item
              key={item.id}
              role="button"
              tabIndex={0}
              onClick={() => open(item)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') open(item);
              }}
              style={{ padding: '10px 16px', cursor: 'pointer' }}
            >
              <List.Item.Meta
                title={
                  <Typography.Text style={item.link ? { color: 'var(--ant-color-link)' } : {}}>
                    {item.title}
                  </Typography.Text>
                }
                description={
                  <div>
                    <Typography.Paragraph
                      type="secondary"
                      ellipsis={{ rows: 2 }}
                      style={{ marginBottom: 2 }}
                    >
                      {item.body}
                    </Typography.Paragraph>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      <InstantText value={item.createdAt} format="relative" />
                    </Typography.Text>
                  </div>
                }
              />
            </List.Item>
          )}
        />
      )}
    </Card>
  );

  return (
    <Dropdown
      trigger={['click']}
      placement="bottomRight"
      popupRender={() => panel}
      open={panelOpen}
      onOpenChange={setPanelOpen}
    >
      <Tooltip
        title={STATUS_HINT[status] ?? '通知'}
        placement="bottom"
        open={panelOpen ? false : undefined}
      >
        <Button type="text" aria-label="通知" data-testid="notification-bell">
          <Badge count={unreadCount} size="small" offset={[2, -2]}>
            <BellOutlined style={{ fontSize: 16 }} />
          </Badge>
        </Button>
      </Tooltip>
    </Dropdown>
  );
}
