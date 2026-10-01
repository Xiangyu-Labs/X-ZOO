'use client';

import { Alert, Button, Descriptions, Input, Modal, Segmented, Space, Tag, Typography } from 'antd';
import { useState } from 'react';
import { wechatOaReplySimulate } from '@shop/contracts/wechat-oa/wechat-oa.reply.contract';
import type {
  WechatAutoReply,
  WechatReplySimulateBody,
  WechatReplySimulateResult,
} from '@shop/contracts/wechat-oa/schemas';

import { errorMessage } from '@/admin/api/errors';
import { useRouteMutation } from '@/admin/api/hooks';
import { StatusTag } from '@/admin/kit/status-tag';

import { REPLY_MATCH_MODE, REPLY_TYPE, replySummary } from '../wechat-oa-enums';

type Kind = WechatReplySimulateBody['kind'];

const KINDS: { value: Kind; label: string }[] = [
  { value: 'text', label: '发消息' },
  { value: 'click', label: '点菜单' },
  { value: 'subscribe', label: '新关注' },
];

/**
 * 回复模拟: type what a follower sends and see which rule answers, with the
 * rules it beat. The server asks the webhook's own query, so this is what a
 * follower gets — enabled rules only, saved rules only.
 */
export function ReplySimulator() {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<Kind>('text');
  const [text, setText] = useState('');
  const simulate = useRouteMutation(wechatOaReplySimulate, { presentError: false });
  // The server fills the payload's defaults, so the response is the parsed shape.
  const result = simulate.data as WechatReplySimulateResult | undefined;

  const run = (): void => simulate.mutate({ body: { kind, text } });

  return (
    <>
      <Button onClick={() => setOpen(true)} data-testid="reply-simulate">
        回复模拟
      </Button>
      <Modal
        open={open}
        title="回复模拟"
        onCancel={() => setOpen(false)}
        afterClose={() => simulate.reset()}
        destroyOnHidden
        footer={<Button onClick={() => setOpen(false)}>关闭</Button>}
      >
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Typography.Text type="secondary">
            只看已保存并启用的规则。关键词区分大小写，完全匹配优先，其次排序值小的优先。
          </Typography.Text>
          <Segmented<Kind>
            options={KINDS}
            value={kind}
            onChange={(value) => {
              setKind(value);
              simulate.reset();
            }}
          />
          {kind === 'subscribe' ? (
            <Button type="primary" loading={simulate.isPending} onClick={run}>
              模拟一次关注
            </Button>
          ) : (
            <Input.Search
              value={text}
              onChange={(event) => setText(event.target.value)}
              onSearch={run}
              enterButton="模拟"
              loading={simulate.isPending}
              placeholder={
                kind === 'click' ? '菜单按钮的 key，如 SERVICE' : '用户发来的消息，如：怎么退货'
              }
              maxLength={2048}
            />
          )}

          {simulate.error ? (
            <Alert
              type="error"
              showIcon
              message={errorMessage(simulate.error, '模拟失败，请重试')}
            />
          ) : null}

          {result ? (
            <Space
              direction="vertical"
              style={{ width: '100%' }}
              data-testid="reply-simulate-result"
            >
              <Alert
                type={result.source === 'none' ? 'warning' : 'success'}
                showIcon
                message={result.explanation}
              />
              {result.reply ? <ReplyCard reply={result.reply} /> : null}
              {result.shadowed.length > 0 ? (
                <>
                  <Typography.Text type="secondary">也匹配、但没被选中的规则：</Typography.Text>
                  {result.shadowed.map((reply) => (
                    <ReplyCard key={reply.id} reply={reply} muted />
                  ))}
                </>
              ) : null}
            </Space>
          ) : null}
        </Space>
      </Modal>
    </>
  );
}

function ReplyCard({ reply, muted = false }: { reply: WechatAutoReply; muted?: boolean }) {
  return (
    <Descriptions
      size="small"
      bordered
      column={1}
      style={muted ? { opacity: 0.7 } : undefined}
      items={[
        {
          key: 'rule',
          label: '规则',
          children: (
            <Space size={4} wrap>
              <span>#{reply.id}</span>
              {reply.keyword === null ? null : (
                <>
                  <Tag>{reply.keyword}</Tag>
                  <StatusTag value={reply.matchMode} map={REPLY_MATCH_MODE} placeholder="" />
                </>
              )}
              <Typography.Text type="secondary">排序 {reply.sortOrder}</Typography.Text>
            </Space>
          ),
        },
        {
          key: 'reply',
          label: REPLY_TYPE[reply.replyType]?.label ?? reply.replyType,
          children: (
            <Typography.Paragraph style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
              {replySummary(reply.replyType, reply.payload)}
            </Typography.Paragraph>
          ),
        },
      ]}
    />
  );
}
