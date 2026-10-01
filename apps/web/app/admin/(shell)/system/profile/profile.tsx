'use client';

import { Alert, Button, Card, Col, Row, Skeleton, Space, Tag, Typography, message } from 'antd';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  systemProfileChangePassword,
  systemProfileGet,
  systemProfileUpdate,
} from '@shop/contracts/system/system.admin.contract';
import { profileForm, profilePasswordBody } from '@shop/contracts/system/schemas';

import { useRouteQuery } from '@/admin/api/hooks';
import { DescriptionsCard } from '@/admin/kit/descriptions-card';
import { ModalForm } from '@/admin/kit/form/modal-form';
import { InstantText } from '@/admin/kit/instant-text';
import { PageContainer } from '@/admin/kit/page-container';

/**
 * 个人资料.
 *
 * Reachable by every logged-in admin, including one holding no grants at all —
 * the routes ask for `auth:session:*`, which the session always carries.
 *
 * Changing your own password requires the current one (a stolen cookie must not
 * be enough to lock the real owner out) and revokes **every** session including
 * this one, so the page says so before you click and sends you back to the
 * login screen after.
 */
export function ProfilePage() {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);
  const { data, isPending } = useRouteQuery(systemProfileGet);

  if (isPending || !data) {
    return (
      <PageContainer>
        <Skeleton active />
      </PageContainer>
    );
  }

  return (
    <PageContainer subTitle="你自己的账号信息与密码">
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={14}>
          <DescriptionsCard
            title="基本信息"
            column={1}
            extra={
              <Button type="link" onClick={() => setEditing(true)}>
                编辑
              </Button>
            }
            items={[
              { label: '账号', value: data.account },
              { label: '姓名', value: data.name },
              { label: '手机号', value: data.phone ?? '—' },
              {
                label: '身份',
                value: data.isSuper ? (
                  <Tag color="gold">超级管理员</Tag>
                ) : data.roleNames.length === 0 ? (
                  <Typography.Text type="secondary">未分配</Typography.Text>
                ) : (
                  data.roleNames.map((name) => <Tag key={name}>{name}</Tag>)
                ),
              },
              { label: '最后登录', value: <InstantText value={data.lastLoginAt} /> },
            ]}
          />
        </Col>

        <Col xs={24} lg={10}>
          <Card title="登录密码" size="small">
            <Space direction="vertical" style={{ width: '100%' }}>
              <Alert
                type="info"
                showIcon
                message="修改密码会注销你在所有设备上的登录，包括当前这台。"
              />
              <Button type="primary" onClick={() => setChangingPassword(true)}>
                修改密码
              </Button>
            </Space>
          </Card>

          <Card title="我的权限" size="small" style={{ marginTop: 16 }}>
            {data.isSuper ? (
              <Typography.Text type="secondary">超级管理员拥有全部权限。</Typography.Text>
            ) : data.permissions.length === 0 ? (
              <Typography.Text type="secondary">没有额外权限。</Typography.Text>
            ) : (
              <Space wrap size={[4, 8]}>
                {data.permissions.map((atom) => (
                  <Tag key={atom}>{atom}</Tag>
                ))}
              </Space>
            )}
          </Card>
        </Col>
      </Row>

      <ModalForm
        open={editing}
        onClose={() => setEditing(false)}
        title="编辑我的资料"
        size="small"
        schema={profileForm}
        fields={[
          { kind: 'text', name: 'name', label: '姓名', span: 24 },
          { kind: 'text', name: 'phone', label: '手机号', span: 24 },
          { kind: 'asset', name: 'avatar', label: '头像', span: 24 },
        ]}
        initialValues={{
          name: data.name,
          ...(data.phone === null ? {} : { phone: data.phone }),
          ...(data.avatar === null ? {} : { avatar: data.avatar }),
        }}
        route={systemProfileUpdate}
        invalidate={[systemProfileGet]}
        successMessage="已保存"
      />

      <ModalForm
        open={changingPassword}
        onClose={() => setChangingPassword(false)}
        title="修改密码"
        size="small"
        schema={profilePasswordBody}
        fields={[
          { kind: 'password', name: 'currentPassword', label: '当前密码', span: 24 },
          { kind: 'password', name: 'newPassword', label: '新密码', span: 24 },
          { kind: 'password', name: 'confirmPassword', label: '确认新密码', span: 24 },
        ]}
        route={systemProfileChangePassword}
        onSuccess={() => {
          void message.success('密码已修改，请重新登录');
          // Every session died, including this one — the cookie this tab holds
          // is already worthless, so there is nothing to go back to.
          router.replace('/admin/login');
        }}
      />
    </PageContainer>
  );
}
