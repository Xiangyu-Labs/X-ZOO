import { definePermissions } from '../auth/permissions';

/**
 * Notification permission atoms.
 *
 * Four, and the split is about blast radius rather than about screens. Editing
 * a template changes what every future customer is told, so it is not the same
 * job as reading the send log to answer one support ticket; re-queuing a parked
 * send makes the system talk to WeChat again, so it is not the same job as
 * reading.
 *
 * The **admin inbox** deliberately has no atom: it uses `auth:profile:read`,
 * which every authenticated admin holds, because the header bell has to work
 * for an account with no grants at all. Which events reach an inbox is decided
 * at fan-out time against the event's own atom (`notification.registry.ts`).
 */
export const notificationPermissions = definePermissions(
  'notification',
  {
    'template:read': '查看通知模板',
    'template:write': '编辑通知模板',
    'log:read': '查看通知发送记录',
    'log:handle': '重试通知发送',
  },
  { section: '设置' },
);
