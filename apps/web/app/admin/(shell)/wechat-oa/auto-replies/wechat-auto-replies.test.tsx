import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { WechatAutoReply } from '@shop/contracts/wechat-oa/schemas';
import { wechatOaMediaList } from '@shop/contracts/wechat-oa/wechat-oa.media.contract';
import {
  wechatOaReplyCreate,
  wechatOaReplyList,
  wechatOaReplySetStatus,
  wechatOaReplySimulate,
  wechatOaReplyUpdate,
} from '@shop/contracts/wechat-oa/wechat-oa.reply.contract';

import { resetApiConfig } from '@/admin/api/config';
import { on, stubRoutes, type StubCall } from '@/test/api';
import { renderAdmin, testIdentity, zhName } from '@/test/render';

import { WechatAutoRepliesPage } from './wechat-auto-replies';

/**
 * The auto-reply screen as a component test.
 *
 * The wiring worth pinning down is the shape of what gets sent: the trigger
 * decides whether a keyword is allowed at all (the contract refines on it), and
 * enable/disable is a sub-resource rather than a full save — saving the whole
 * form to flip a switch is how a concurrent edit gets clobbered.
 */

const reply: WechatAutoReply = {
  id: '1',
  triggerKind: 'keyword',
  keyword: '优惠券',
  matchMode: 'contains',
  replyType: 'text',
  payload: { text: '点击 https://shop.example.com/coupons 领取本月优惠券' },
  isEnabled: true,
  sortOrder: 0,
  createdAt: '2026-01-04T10:00:00+08:00',
  updatedAt: '2026-01-04T10:00:00+08:00',
};

function stubApi(): StubCall[] {
  return stubRoutes([
    on(wechatOaMediaList, { items: [], total: 0, page: 1, pageSize: 100 }),
    on(wechatOaReplyList, { items: [reply], total: 1, page: 1, pageSize: 20 }),
    on(wechatOaReplySetStatus, { ...reply, isEnabled: false }),
    on(wechatOaReplyCreate, reply),
    on(wechatOaReplyUpdate, reply),
    on(wechatOaReplySimulate, {
      source: 'keyword',
      reply,
      shadowed: [{ ...reply, id: '2', keyword: '券', sortOrder: 5 }],
      explanation: '命中关键词「优惠券」（包含匹配）；另有 1 条规则也匹配，但优先级更低',
    }),
  ]);
}

afterEach(() => {
  resetApiConfig();
});

/**
 * antd draws a radio *button* as a label covering an input that carries
 * `pointer-events: none`; user-event refuses to click such an element unless
 * the check is switched off.
 */
const user = userEvent.setup({ pointerEventsCheck: 0 });

const allPermissions = {
  ...testIdentity,
  permissions: ['wechat-oa:reply:read', 'wechat-oa:reply:write'],
};

describe('公众号自动回复', () => {
  it('lists replies with a readable preview of the body', async () => {
    const calls = stubApi();
    renderAdmin(<WechatAutoRepliesPage />, { identity: allPermissions });

    expect(await screen.findByText('关键词回复')).toBeInTheDocument();
    expect(screen.getByText('优惠券')).toBeInTheDocument();
    // A row that only says 文字 tells an operator nothing about which reply it is.
    expect(screen.getByText(/领取本月优惠券/)).toBeInTheDocument();
    expect(calls[0]?.url).toContain('/admin-api/wechat-auto-replies?');
  });

  it('toggles through the status sub-resource, not the edit form', async () => {
    const calls = stubApi();
    renderAdmin(<WechatAutoRepliesPage />, { identity: allPermissions });
    await screen.findByText('关键词回复');

    await user.click(screen.getByRole('button', { name: zhName('停用') }));
    // Switching off is customer-visible, so it asks first.
    const popup = (await screen.findByText('停用这条自动回复？')).closest(
      '.ant-popover',
    ) as HTMLElement;
    await user.click(within(popup).getByRole('button', { name: zhName('停用') }));

    await waitFor(() => {
      const toggle = calls.find((call) => call.url.includes('/status'));
      expect(toggle?.method).toBe('POST');
      expect(toggle?.url).toContain('/admin-api/wechat-auto-replies/1/status');
      expect(toggle?.body).toEqual({ isEnabled: false });
    });
  });

  it('hides every write action from a read-only admin', async () => {
    stubApi();
    renderAdmin(<WechatAutoRepliesPage />, {
      identity: { ...testIdentity, permissions: ['wechat-oa:reply:read'] },
    });

    await screen.findByText('关键词回复');
    expect(screen.queryByRole('button', { name: zhName('新建回复') })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: zhName('编辑') })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: zhName('停用') })).not.toBeInTheDocument();
  });

  // A dialog plus a radio round trip; see the note in the menu page's tests.
  it('only offers a keyword when the trigger is a keyword', { timeout: 20_000 }, async () => {
    stubApi();
    renderAdmin(<WechatAutoRepliesPage />, { identity: allPermissions });
    await screen.findByText('关键词回复');

    await user.click(screen.getByRole('button', { name: zhName('新建回复') }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('关键词')).toBeInTheDocument();

    // The contract refuses a keyword on a 关注时回复, so the field goes away
    // rather than being submitted and 422'd.
    await user.click(within(dialog).getByRole('radio', { name: zhName('关注时回复') }));
    await waitFor(() => expect(within(dialog).queryByLabelText('关键词')).not.toBeInTheDocument());
  });

  it(
    'sends the trigger, the keyword and the body the contract declares',
    { timeout: 20_000 },
    async () => {
      const calls = stubApi();
      renderAdmin(<WechatAutoRepliesPage />, { identity: allPermissions });
      await screen.findByText('关键词回复');

      await user.click(screen.getByRole('button', { name: zhName('新建回复') }));
      const dialog = await screen.findByRole('dialog');

      await user.type(within(dialog).getByLabelText('关键词'), '发票');
      await user.type(within(dialog).getByLabelText('回复内容'), '开票请联系客服');
      await user.click(within(dialog).getByRole('button', { name: zhName('保存') }));

      await waitFor(() => {
        const save = calls.find((call) => call.method === 'POST' && !call.url.includes('/status'));
        expect(save?.body).toMatchObject({
          triggerKind: 'keyword',
          keyword: '发票',
          replyType: 'text',
          payload: { text: '开票请联系客服' },
        });
      });
    },
  );

  it('simulates a message for a read-only admin and shows the rule that answers', async () => {
    const calls = stubApi();
    renderAdmin(<WechatAutoRepliesPage />, {
      identity: { ...testIdentity, permissions: ['wechat-oa:reply:read'] },
    });
    await screen.findByText('关键词回复');

    await user.click(screen.getByTestId('reply-simulate'));
    const modal = await screen.findByRole('dialog');
    await user.type(within(modal).getByPlaceholderText(/用户发来的消息/), '有优惠券吗{Enter}');

    const result = await within(modal).findByTestId('reply-simulate-result');
    expect(within(result).getByText(/命中关键词「优惠券」/)).toBeInTheDocument();
    expect(within(result).getByText('也匹配、但没被选中的规则：')).toBeInTheDocument();
    expect(within(result).getByText('#2')).toBeInTheDocument();
    const call = calls.find((entry) => entry.path === '/admin-api/wechat-auto-replies/simulate');
    expect(call?.body).toEqual({ kind: 'text', text: '有优惠券吗' });
  });
});
