'use client';

import { LockOutlined, UserOutlined } from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, Checkbox, Form, Input, Typography } from 'antd';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';

import { callRoute } from '@/admin/api/call-route';
import { adminLogin } from '@/admin/api/contracts';
import { ApiError } from '@/admin/api/errors';
import { useBrand } from '@/admin/shell/brand-context';
import { BrandMark } from '@/admin/shell/brand-mark';
import { useThemeMode } from '@/admin/theme/theme-provider';
import { SITE_TITLE } from '@/admin/site-title';

interface LoginValues {
  account: string;
  password: string;
  remember?: boolean;
}

/**
 * Only ever navigate to our own admin paths — or back to the OAuth consent
 * screen an MCP client sent the admin to — never to an attacker's `?next=`.
 */
function safeNext(raw: string | null): string {
  if (!raw || raw.startsWith('//')) return '/admin';
  if (!raw.startsWith('/admin') && !raw.startsWith('/oauth/authorize?')) return '/admin';
  return raw;
}

/**
 * Deliberately plain antd `Form` rather than `ZodForm`: login is not a CRUD
 * form, it has to keep working if the kit changes, and it is the one screen
 * that must render with no session and no shell.
 *
 * There is no captcha field. The server asks for one only when a captcha
 * verifier is registered in `@shop/core` (`captchaRequired`), and none is; the
 * per-account login throttle is the defence. Registering a verifier has to ship
 * together with a challenge widget here, or an admin who mistypes the password
 * three times meets `AUTH_CAPTCHA_REQUIRED` with nothing to answer it.
 */
export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const queryClient = useQueryClient();
  const { palette } = useThemeMode();
  // 站点设置 → 后台 Logo, read by the layout without a session.
  const brand = useBrand();

  const [form] = Form.useForm<LoginValues>();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onFinish(values: LoginValues): Promise<void> {
    setSubmitting(true);
    setError(null);
    try {
      await callRoute(
        adminLogin,
        {
          body: {
            account: values.account,
            password: values.password,
            remember: values.remember === true,
          },
        },
        // A 401 here means "wrong password", not "session expired" — showing it
        // inline beats bouncing the browser back to this very page.
        { onUnauthorized: 'throw' },
      );
      queryClient.clear();
      router.replace(safeNext(params.get('next')));
      router.refresh();
    } catch (cause) {
      setError(ApiError.is(cause) ? cause.message : '登录失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        background: palette.contentBg,
        padding: 16,
      }}
    >
      <Card style={{ width: '100%', maxWidth: 380 }} variant="borderless">
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}>
            {brand.logo ? (
              <img
                src={brand.logo}
                alt="商城 Logo"
                style={{ display: 'block', height: 50, width: 'auto', maxWidth: '100%' }}
              />
            ) : (
              <BrandMark size={40} />
            )}
          </div>
          <Typography.Title level={4} style={{ marginBottom: 4 }}>
            {SITE_TITLE}
          </Typography.Title>
          <Typography.Text type="secondary">请使用管理员账号登录</Typography.Text>
        </div>

        {error === null && params.get('expired') === '1' ? (
          <Alert
            type="info"
            showIcon
            message="登录已过期，请重新登录"
            style={{ marginBottom: 16 }}
            data-testid="login-expired"
          />
        ) : null}

        {error ? (
          <Alert
            type="error"
            showIcon
            message={error}
            style={{ marginBottom: 16 }}
            data-testid="login-error"
          />
        ) : null}

        <Form<LoginValues>
          form={form}
          layout="vertical"
          requiredMark={false}
          onFinish={(values) => onFinish(values)}
          // A wrong password's message goes as soon as they start typing again,
          // instead of staying over the form they are correcting.
          onValuesChange={(changed: Partial<LoginValues>) => {
            if ('account' in changed || 'password' in changed) setError(null);
          }}
          // Off by default: seven days signed in is a choice for one's own
          // computer, not what a shared counter PC should get unasked.
          initialValues={{ remember: false }}
        >
          <Form.Item
            name="account"
            label="账号"
            rules={[{ required: true, message: '请输入账号' }]}
          >
            <Input
              size="large"
              autoFocus
              autoComplete="username"
              prefix={<UserOutlined />}
              placeholder="账号"
            />
          </Form.Item>

          <Form.Item
            name="password"
            label="密码"
            rules={[{ required: true, message: '请输入密码' }]}
          >
            <Input.Password
              size="large"
              autoComplete="current-password"
              prefix={<LockOutlined />}
              placeholder="密码"
            />
          </Form.Item>

          <Form.Item name="remember" valuePropName="checked" style={{ marginBottom: 12 }}>
            <Checkbox>记住登录状态（7 天）</Checkbox>
          </Form.Item>

          <Button type="primary" size="large" htmlType="submit" block loading={submitting}>
            登录
          </Button>
        </Form>
      </Card>
    </div>
  );
}
