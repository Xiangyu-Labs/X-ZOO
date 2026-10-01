'use client';

import { Alert, Button, Card, Modal, Table, Tag, Typography } from 'antd';
import { useState, useSyncExternalStore } from 'react';
import type { ColumnsType } from 'antd/es/table';
import { z } from 'zod';
import {
  authApiTokenCreate,
  authApiTokenList,
  authApiTokenRevoke,
  type ApiTokenItem,
} from '@shop/contracts/auth/auth.api-token.contract';

import { useRouteQuery } from '@/admin/api/hooks';
import { ConfirmButton } from '@/admin/kit/confirm-button';
import { columnsWidth, TableToolbar } from '@/admin/kit/table/crud-table';
import { ModalForm } from '@/admin/kit/form/modal-form';
import { PageContainer } from '@/admin/kit/page-container';
import { actionsColumn, instantColumn, textColumn } from '@/admin/kit/table/columns';
import { useSession } from '@/admin/session';

const EXPIRY_DAYS = { '30': 30, '90': 90, '365': 365, never: null } as const;

/** The dialog's own shape: a select cannot carry `null`, so "never" is a key. */
const createForm = z.object({
  name: z.string().trim().min(1, '请填写名称').max(64),
  expiry: z.enum(['30', '90', '365', 'never']),
});

const noSubscription = () => () => {};

type TokenState = 'live' | 'expired' | 'revoked';

function stateOf(row: ApiTokenItem): TokenState {
  if (row.revokedAt !== null) return 'revoked';
  if (row.expiresAt !== null && Date.parse(row.expiresAt) <= Date.now()) return 'expired';
  return 'live';
}

const STATE_TAG: Record<TokenState, { label: string; color: string }> = {
  live: { label: '有效', color: 'success' },
  expired: { label: '已过期', color: 'default' },
  revoked: { label: '已吊销', color: 'default' },
};

/**
 * API 令牌 — how an AI assistant (over MCP) or the `shop` CLI acts as an admin.
 *
 * Two kinds land here. A 个人令牌 is made on this screen and pasted into a
 * client that takes a request header (Cherry Studio, Cursor…); its plain text
 * is shown once, in the create response, and never again. An 授权登录 row
 * appears on its own when a client connects by signing in (Claude, ChatGPT).
 * Either has exactly its owner's permissions as they are at each request, and
 * revoking one cuts it off on its next call.
 */
export function ApiTokensPage() {
  const { identity } = useSession();
  const [creating, setCreating] = useState(false);
  const [issued, setIssued] = useState<string | null>(null);
  const list = useRouteQuery(authApiTokenList);
  // The server render has no origin; hydration starts from the same blank.
  const origin = useSyncExternalStore(
    noSubscription,
    () => window.location.origin,
    () => '',
  );
  const mcpUrl = `${origin}/mcp`;

  const columns: ColumnsType<ApiTokenItem> = [
    textColumn<ApiTokenItem>({ title: '名称', dataIndex: 'name' }),
    {
      title: '类型',
      key: 'kind',
      width: 100,
      render: (_value: unknown, row: ApiTokenItem) =>
        row.kind === 'pat' ? <Tag>个人令牌</Tag> : <Tag color="blue">授权登录</Tag>,
    },
    {
      title: '令牌',
      key: 'hint',
      width: 140,
      render: (_value: unknown, row: ApiTokenItem) => (
        <Typography.Text code>{row.hint}…</Typography.Text>
      ),
    },
    ...(identity.isSuper
      ? [textColumn<ApiTokenItem>({ title: '管理员', dataIndex: 'adminAccount' })]
      : []),
    {
      title: '状态',
      key: 'state',
      width: 90,
      render: (_value: unknown, row: ApiTokenItem) => {
        const tag = STATE_TAG[stateOf(row)];
        return <Tag color={tag.color}>{tag.label}</Tag>;
      },
    },
    instantColumn<ApiTokenItem>({ title: '最近使用', dataIndex: 'lastUsedAt' }),
    textColumn<ApiTokenItem>({ title: '最近 IP', dataIndex: 'lastUsedIp' }),
    instantColumn<ApiTokenItem>({ title: '过期时间', dataIndex: 'expiresAt' }),
    instantColumn<ApiTokenItem>({ title: '创建时间', dataIndex: 'createdAt' }),
    actionsColumn<ApiTokenItem>({
      width: 100,
      render: (row) =>
        row.revokedAt === null ? (
          <ConfirmButton
            route={authApiTokenRevoke}
            input={{ params: { id: row.id } }}
            title={`吊销令牌「${row.name}」？`}
            description="使用它的 AI 助手或命令行会立刻失去访问权限，无法恢复。"
            invalidate={[authApiTokenList]}
            successMessage="已吊销"
            buttonProps={{ type: 'link', size: 'small', danger: true }}
          >
            吊销
          </ConfirmButton>
        ) : null,
    }),
  ];

  return (
    <PageContainer subTitle="让 AI 助手或命令行以你的身份操作后台；权限与你的账号相同，每次操作都记入操作日志">
      <Card size="small" style={{ marginBottom: 16 }}>
        <Typography.Paragraph style={{ marginBottom: 8 }}>
          MCP 地址：
          <Typography.Text code copyable>
            {mcpUrl}
          </Typography.Text>
        </Typography.Paragraph>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          Claude、ChatGPT
          等支持「添加连接器」的应用：直接填这个地址，按提示登录授权即可，无需新建令牌。 Cherry
          Studio、Cursor 等可以填请求头的客户端：新建一个个人令牌，请求头填{' '}
          <Typography.Text code>Authorization: Bearer shp_…</Typography.Text>。
        </Typography.Paragraph>
        <Typography.Paragraph type="secondary" style={{ margin: '8px 0 0' }}>
          命令行（Claude Code、Codex 等在终端里工作的助手也用它；需要 Node 24）：新建个人令牌，然后
        </Typography.Paragraph>
        <Typography.Paragraph style={{ marginBottom: 0 }}>
          <Typography.Text code copyable>
            {`curl -o shop.js ${origin}/downloads/shop.js`}
          </Typography.Text>
          <br />
          <Typography.Text code copyable>
            {`node shop.js login --origin ${origin} --token -`}
          </Typography.Text>
        </Typography.Paragraph>
      </Card>

      <Card size="small" title={identity.isSuper ? '全部令牌' : '我的令牌'}>
        <TableToolbar onRefresh={() => list.refetch()} refreshing={list.isFetching}>
          <Button type="primary" onClick={() => setCreating(true)}>
            新建个人令牌
          </Button>
        </TableToolbar>
        <Table<ApiTokenItem>
          rowKey="id"
          size="middle"
          loading={list.isPending}
          dataSource={list.data?.items ?? []}
          pagination={false}
          scroll={{ x: columnsWidth(columns) }}
          columns={columns}
        />
      </Card>

      <ModalForm
        open={creating}
        onClose={() => setCreating(false)}
        title="新建个人令牌"
        size="small"
        schema={createForm}
        fields={[
          {
            kind: 'text',
            name: 'name',
            label: '名称',
            help: '写清用在哪里，例如「老板的 Cherry Studio」',
            span: 24,
          },
          {
            kind: 'radio',
            name: 'expiry',
            label: '有效期',
            optionType: 'button',
            options: [
              { value: '30', label: '30 天' },
              { value: '90', label: '90 天' },
              { value: '365', label: '1 年' },
              { value: 'never', label: '永不过期' },
            ],
            span: 24,
          },
        ]}
        initialValues={{ expiry: '90' }}
        route={authApiTokenCreate}
        toInput={(values) => ({
          body: { name: values.name, expiresInDays: EXPIRY_DAYS[values.expiry] },
        })}
        invalidate={[authApiTokenList]}
        onSuccess={(result) => {
          setCreating(false);
          setIssued(result.token);
        }}
      />

      <Modal
        open={issued !== null}
        title="令牌已创建"
        onCancel={() => setIssued(null)}
        footer={
          <Button type="primary" onClick={() => setIssued(null)}>
            我已保存
          </Button>
        }
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="这是唯一一次显示完整令牌，关闭后无法再次查看。请立即复制保存。"
        />
        <Typography.Paragraph
          copyable={{ text: issued ?? '' }}
          code
          style={{ wordBreak: 'break-all' }}
        >
          {issued}
        </Typography.Paragraph>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          拿到令牌的人可以用你的身份操作后台。不要发到群里；泄露了就回到这里吊销它。
        </Typography.Paragraph>
      </Modal>
    </PageContainer>
  );
}
