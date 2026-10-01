import { z } from 'zod';
import { id } from '../_conventions/common';
import { defineRoute } from '../_conventions/route';
import {
  markReadResult,
  notificationMessage,
  notificationMessageExample,
  notificationMessageListQuery,
  pagedNotificationMessages,
  unreadCount,
} from './schemas';

/**
 * 站内信 — the shopper's message centre, `/api/v1/my-messages`.
 *
 * The resource is `my-messages` rather than `messages` because the id space is
 * global and the rows are per-person: `GET /api/v1/messages/5001` reads as "the
 * message with id 5001", which invites exactly the bug where somebody else's id
 * returns somebody else's message. Every query here carries
 * `user_id = ctx.actor.id` in its `WHERE`, and a row that belongs to another
 * user answers 404 — never 403, which would confirm it exists.
 *
 * Deleting is a soft delete of *this user's copy* (`deleted_at`): the message
 * may also be part of a send record an operator needs to see.
 */

const messageParams = z.object({ id });

export const notificationMyList = defineRoute({
  id: 'notification.myList',
  method: 'GET',
  path: '/api/v1/my-messages',
  auth: 'user',
  summary: '我的消息',
  tags: ['notification'],
  query: notificationMessageListQuery,
  response: pagedNotificationMessages,
  examples: [
    {
      name: 'first-page',
      query: { page: 1, pageSize: 20 },
      response: { items: [notificationMessageExample], total: 1, page: 1, pageSize: 20 },
    },
    {
      name: 'unread-only',
      query: { page: 1, pageSize: 20, unreadOnly: 'true' },
      response: { items: [notificationMessageExample], total: 1, page: 1, pageSize: 20 },
    },
  ],
});

export const notificationMyUnreadCount = defineRoute({
  id: 'notification.myUnreadCount',
  method: 'GET',
  path: '/api/v1/my-messages/unread-count',
  auth: 'user',
  summary: '未读消息数',
  tags: ['notification'],
  response: unreadCount,
  examples: [
    { name: 'two', response: { unread: 2 } },
    { name: 'none', response: { unread: 0 } },
  ],
});

/**
 * Reading the detail does **not** mark it read.
 *
 * Marking on fetch would let a prefetch or a double render silently consume the
 * unread badge. The client calls `POST …/read` when the user has actually seen
 * it.
 */
export const notificationMyDetail = defineRoute({
  id: 'notification.myDetail',
  method: 'GET',
  path: '/api/v1/my-messages/:id',
  auth: 'user',
  summary: '消息详情',
  tags: ['notification'],
  params: messageParams,
  response: notificationMessage,
  errors: ['NOTIFICATION_MESSAGE_NOT_FOUND'],
  examples: [{ name: 'ok', params: { id: '5001' }, response: notificationMessageExample }],
});

export const notificationMyMarkRead = defineRoute({
  id: 'notification.myMarkRead',
  method: 'POST',
  path: '/api/v1/my-messages/:id/read',
  auth: 'user',
  summary: '标记消息已读',
  tags: ['notification'],
  params: messageParams,
  body: z.object({}),
  response: markReadResult,
  errors: ['NOTIFICATION_MESSAGE_NOT_FOUND'],
  examples: [
    { name: 'marked', params: { id: '5001' }, body: {}, response: { marked: 1 } },
    { name: 'already-read', params: { id: '5001' }, body: {}, response: { marked: 0 } },
  ],
});

export const notificationMyMarkAllRead = defineRoute({
  id: 'notification.myMarkAllRead',
  method: 'POST',
  path: '/api/v1/my-messages/read-all',
  auth: 'user',
  summary: '全部标记为已读',
  tags: ['notification'],
  body: z.object({}),
  response: markReadResult,
  examples: [{ name: 'marked-two', body: {}, response: { marked: 2 } }],
});

export const notificationMyDelete = defineRoute({
  id: 'notification.myDelete',
  method: 'DELETE',
  path: '/api/v1/my-messages/:id',
  auth: 'user',
  summary: '删除消息',
  tags: ['notification'],
  params: messageParams,
  response: z.void(),
  status: 204,
  errors: ['NOTIFICATION_MESSAGE_NOT_FOUND'],
  examples: [{ name: 'ok', params: { id: '5001' }, response: undefined }],
});
