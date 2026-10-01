'use client';

import { Alert, Button, Card, Flex, Typography } from 'antd';

import type { AuthorizeParams } from './params';

/**
 * The consent card. A plain HTML form post to `./decision` — no client-side
 * request, so it works the same with scripts slow or off, and the decision
 * route re-checks everything it is sent.
 */
export function Consent({
  clientName,
  adminName,
  account,
  params,
}: {
  clientName: string;
  adminName: string;
  account: string;
  params: AuthorizeParams;
}) {
  return (
    <Flex justify="center" style={{ padding: '12vh 16px' }}>
      <Card style={{ width: '100%', maxWidth: 440 }}>
        <Typography.Title level={4} style={{ marginTop: 0 }}>
          授权「{clientName}」管理商城
        </Typography.Title>
        <Typography.Paragraph>
          授权后，这个 AI 助手将以管理员 <b>{adminName}</b>（{account}
          ）的身份操作后台，权限与该账号完全相同，可以新增、修改和删除数据。每一次操作都会记入操作日志。
        </Typography.Paragraph>
        <Typography.Paragraph type="secondary">
          随时可以在「设置 → API 令牌」里断开它。修改密码也会断开所有已授权的助手。
        </Typography.Paragraph>
        <form method="post" action="/oauth/authorize/decision">
          {Object.entries(params).map(([key, value]) => (
            <input key={key} type="hidden" name={key} value={value} />
          ))}
          <Flex gap={12} justify="flex-end">
            <Button htmlType="submit" name="decision" value="deny">
              拒绝
            </Button>
            <Button type="primary" htmlType="submit" name="decision" value="allow">
              授权
            </Button>
          </Flex>
        </form>
      </Card>
    </Flex>
  );
}

export function ConsentError({ description }: { description: string }) {
  return (
    <Flex justify="center" style={{ padding: '15vh 16px' }}>
      <Alert type="error" showIcon message="无法授权" description={description} />
    </Flex>
  );
}
