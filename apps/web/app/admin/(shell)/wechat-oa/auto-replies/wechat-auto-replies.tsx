'use client';

import { Button, Space, Typography } from 'antd';
import {
  wechatOaReplyCreate,
  wechatOaReplyDelete,
  wechatOaReplyList,
  wechatOaReplySetStatus,
  wechatOaReplyUpdate,
} from '@shop/contracts/wechat-oa/wechat-oa.reply.contract';
import {
  wechatAutoReplyForm,
  type WechatAutoReply,
  type WechatAutoReplyForm,
} from '@shop/contracts/wechat-oa/schemas';

import { ConfirmButton } from '@/admin/kit/confirm-button';
import { ModalForm, useFormModal } from '@/admin/kit/form/modal-form';
import type { FieldSpec } from '@/admin/kit/form/types';
import { PageContainer } from '@/admin/kit/page-container';
import { StatusTag, statusOptions } from '@/admin/kit/status-tag';
import { actionsColumn, enumColumn, idColumn, instantColumn } from '@/admin/kit/table/columns';
import { CrudTable } from '@/admin/kit/table/crud-table';
import { StatusToggleButton } from '@/admin/kit/status-toggle-button';
import { Can } from '@/admin/session/can';

import {
  REPLY_MATCH_MODE,
  REPLY_TRIGGER,
  REPLY_TYPE,
  replyBodyFields,
  replySummary,
} from '../wechat-oa-enums';
import { ReplySimulator } from './reply-simulator';

type FormKey = Extract<keyof WechatAutoReplyForm, string>;

/**
 * 自动回复 — what the account says back, in one screen.
 *
 * The three triggers (关注 / 关键词 / 兜底) share a table because they are one
 * decision. Three controllers and three half-identical forms is how a shop ends
 * up with a subscribe greeting nobody can find and two keyword replies fighting
 * over 优惠券.
 *
 * The singletons are enforced by the database, not by this screen: a second
 * 关注时回复 comes back as `WECHAT_OA_REPLY_DUPLICATE` and lands on the form
 * as a banner, so two operators saving at the same moment cannot produce two
 * greetings.
 */
export function WechatAutoRepliesPage() {
  const modal = useFormModal<WechatAutoReply>();

  return (
    <PageContainer subTitle="关注、关键词和兜底回复都在这里；关键词区分大小写。不确定一条消息会得到哪条回复，用「回复模拟」试一下">
      <CrudTable
        route={wechatOaReplyList}
        scrollX={1200}
        filters={[
          {
            kind: 'select',
            name: 'triggerKind',
            label: '触发方式',
            options: statusOptions(REPLY_TRIGGER),
          },
          { kind: 'text', name: 'keyword', label: '关键词' },
          {
            kind: 'select',
            name: 'isEnabled',
            label: '状态',
            options: [
              { value: 'true', label: '启用' },
              { value: 'false', label: '停用' },
            ],
          },
        ]}
        toolbar={
          <Space>
            <ReplySimulator />
            <Can permission="wechat-oa:reply:write">
              <Button type="primary" onClick={() => modal.show()}>
                新建回复
              </Button>
            </Can>
          </Space>
        }
        columns={[
          idColumn<WechatAutoReply>(),
          enumColumn<WechatAutoReply, WechatAutoReply['triggerKind']>({
            title: '触发方式',
            dataIndex: 'triggerKind',
            map: REPLY_TRIGGER,
            width: 130,
          }),
          {
            title: '关键词',
            key: 'keyword',
            width: 180,
            render: (_value: unknown, row: WechatAutoReply) =>
              row.keyword === null ? (
                <Typography.Text type="secondary">—</Typography.Text>
              ) : (
                <>
                  {row.keyword}{' '}
                  <StatusTag value={row.matchMode} map={REPLY_MATCH_MODE} placeholder="" />
                </>
              ),
          },
          enumColumn<WechatAutoReply, WechatAutoReply['replyType']>({
            title: '类型',
            dataIndex: 'replyType',
            map: REPLY_TYPE,
            width: 90,
          }),
          {
            title: '内容',
            key: 'payload',
            ellipsis: true,
            render: (_value: unknown, row: WechatAutoReply) => (
              <Typography.Text type="secondary" ellipsis>
                {replySummary(row.replyType, row.payload)}
              </Typography.Text>
            ),
          },
          {
            title: '状态',
            key: 'isEnabled',
            width: 90,
            render: (_value: unknown, row: WechatAutoReply) => (
              <StatusTag
                value={row.isEnabled ? 'on' : 'off'}
                map={{
                  on: { label: '启用', color: 'success' },
                  off: { label: '停用', color: 'default' },
                }}
              />
            ),
          },
          instantColumn<WechatAutoReply>({ title: '更新时间', dataIndex: 'updatedAt' }),
          actionsColumn<WechatAutoReply>({
            width: 180,
            render: (row) => (
              <>
                <Can permission="wechat-oa:reply:write">
                  <Button type="link" size="small" onClick={() => modal.show(row)}>
                    编辑
                  </Button>
                  <StatusToggleButton
                    route={wechatOaReplySetStatus}
                    on={row.isEnabled}
                    input={(next) => ({ params: { id: row.id }, body: { isEnabled: next } })}
                    confirmTitle={'停用这条自动回复？'}
                    invalidate={[wechatOaReplyList]}
                  />
                </Can>
                <ConfirmButton
                  route={wechatOaReplyDelete}
                  input={{ params: { id: row.id } }}
                  title={
                    row.keyword ? `删除关键词「${row.keyword}」的自动回复？` : '删除该自动回复？'
                  }
                  invalidate={[wechatOaReplyList]}
                  successMessage="已删除"
                  permission="wechat-oa:reply:write"
                  buttonProps={{ type: 'link', size: 'small', danger: true }}
                >
                  删除
                </ConfirmButton>
              </>
            ),
          }),
        ]}
      />

      <ModalForm
        {...modal.props}
        title={modal.record ? `编辑自动回复 #${modal.record.id}` : '新建自动回复'}
        columns={2}
        schema={wechatAutoReplyForm}
        fields={replyFields}
        initialValues={modal.record ? initialValuesOf(modal.record) : NEW_REPLY}
        route={modal.record ? wechatOaReplyUpdate : wechatOaReplyCreate}
        toInput={(values) =>
          modal.record ? { params: { id: modal.record.id }, body: values } : { body: values }
        }
        invalidate={[wechatOaReplyList]}
        successMessage="已保存"
      />
    </PageContainer>
  );
}

/**
 * What a blank form starts as.
 *
 * The contract's `.default()`s apply on parse, which is too late for
 * `visibleWhen`: an unset `replyType` would render a form with a type picker
 * and no body field at all. 关键词回复 is the default trigger because the other
 * two are singletons that a shop sets up once.
 */
const NEW_REPLY = {
  triggerKind: 'keyword',
  matchMode: 'contains',
  replyType: 'text',
  payload: {},
  isEnabled: true,
  sortOrder: 0,
} as const;

const isKeyword = (values: Record<string, unknown>) => values['triggerKind'] === 'keyword';

const replyFields: FieldSpec<FormKey>[] = [
  {
    kind: 'radio',
    name: 'triggerKind',
    label: '触发方式',
    span: 24,
    optionType: 'button',
    options: statusOptions(REPLY_TRIGGER),
  },
  {
    kind: 'text',
    name: 'keyword',
    label: '关键词',
    span: 12,
    maxLength: 64,
    visibleWhen: isKeyword,
    help: '用户发来的消息命中它就回复这一条。',
  },
  {
    kind: 'select',
    name: 'matchMode',
    label: '匹配方式',
    span: 12,
    visibleWhen: isKeyword,
    options: statusOptions(REPLY_MATCH_MODE),
  },
  {
    kind: 'radio',
    name: 'replyType',
    label: '回复类型',
    span: 24,
    optionType: 'button',
    options: statusOptions(REPLY_TYPE),
  },
  ...replyBodyFields<FormKey>('payload'),
  { kind: 'switch', name: 'isEnabled', label: '启用', span: 12 },
  {
    kind: 'number',
    name: 'sortOrder',
    label: '排序',
    span: 12,
    min: 0,
    max: 9999,
    help: '数字小的先匹配。',
  },
];

/**
 * The row minus the fields the form does not own, with `null` turned into
 * absence: `exactOptionalPropertyTypes` means an optional field is either
 * missing or a real value, and the contract refuses a `keyword` on a
 * non-keyword reply outright.
 */
function initialValuesOf(row: WechatAutoReply) {
  return {
    triggerKind: row.triggerKind,
    ...(row.keyword === null ? {} : { keyword: row.keyword }),
    ...(row.matchMode === null ? {} : { matchMode: row.matchMode }),
    replyType: row.replyType,
    payload: row.payload,
    isEnabled: row.isEnabled,
    sortOrder: row.sortOrder,
  };
}
