import { useState } from 'react';
import { Text, View } from '@tarojs/components';
import { isApiError } from '@shop/api-client';
import { useRouteMutation, useRouteQuery } from '@shop/api-client/react';
import { goBack, navigate } from '@/platform';
import { LoginGate } from '@/session/login-card';
import { renewSession, useSignedIn } from '@/session/session';
import { Button } from '@/ui/button';
import { CellGroup } from '@/ui/cell';
import { ErrorBlock } from '@/ui/error-block';
import { toast } from '@/ui/feedback';
import { Field } from '@/ui/field';
import { PageShell } from '@/ui/page-shell';
import { CellSkeleton } from '@/ui/skeleton';
import { SmsCodeField } from '@/ui/sms-code-field';
import { SubmitBar, errorMessage } from '../shared/form';
import { PASSWORD_MAX, checkNewPassword } from '../shared/password';
import { SMS_CODE_PATTERN, sendSmsCode } from '../shared/sms';
import './index.scss';

type Errors = Partial<Record<'old' | 'code' | 'password' | 'confirm', string>>;

/**
 * 修改密码 (`password`, pages.md §2.6). With a password: the old one, or an SMS code to the
 * bound number when it is forgotten. Without one (a WeChat or SMS account): an SMS code sets it.
 * The server signs every device out after a change, this one included, so the page signs in
 * again silently before going back.
 */
export default function PasswordPage() {
  return (
    <PageShell title="登录密码" withBar>
      <LoginGate reason="登录后可以设置密码" redirect={{ route: 'password', params: {} }}>
        <PasswordBody />
      </LoginGate>
    </PageShell>
  );
}

function PasswordBody() {
  const signedIn = useSignedIn();
  const profile = useRouteQuery('user.getProfile', undefined, { enabled: signedIn });
  if (profile.isPending) return <CellSkeleton rows={3} />;
  if (profile.isError) {
    return <ErrorBlock error={profile.error} onRetry={() => profile.refetch()} />;
  }
  return <PasswordForm hasPassword={profile.data.hasPassword} phone={profile.data.phone} />;
}

function PasswordForm({ hasPassword, phone }: { hasPassword: boolean; phone: string | null }) {
  const [useSms, setUseSms] = useState(!hasPassword);
  const [oldPassword, setOldPassword] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const change = useRouteMutation('auth.changePassword', { invalidate: ['user.getProfile'] });

  if (useSms && !phone) {
    return (
      <View className="account-page">
        <Text className="account-note">
          {hasPassword
            ? '用短信验证码修改需要先绑定手机号。'
            : '设置密码需要先绑定手机号，用来接收验证码。'}
        </Text>
        {hasPassword ? (
          // The way back: a shopper who still knows the old password is not stuck here.
          <View className="password__switch">
            <Button variant="text" size="sm" onClick={() => setUseSms(false)}>
              用原密码修改
            </Button>
          </View>
        ) : null}
        <SubmitBar>
          <Button size="lg" block onClick={() => navigate({ route: 'phone', params: {} })}>
            去绑定手机号
          </Button>
        </SubmitBar>
      </View>
    );
  }

  async function submit() {
    const next: Errors = checkNewPassword({ password, confirm });
    if (!useSms && !oldPassword) next.old = '请输入原密码';
    if (useSms && !SMS_CODE_PATTERN.test(code)) next.code = '请输入 6 位验证码';
    setErrors(next);
    if (Object.keys(next).length > 0) {
      toast.text('请检查填写的内容');
      return;
    }
    try {
      await change.mutateAsync({
        body: useSms ? { code, password } : { oldPassword, password },
      });
    } catch (error) {
      if (isApiError(error, 'auth.changePassword')) {
        if (error.code === 'AUTH_OLD_PASSWORD_INVALID') return setErrors({ old: error.message });
        if (error.code === 'AUTH_PASSWORD_UNCHANGED') return setErrors({ password: error.message });
        if (error.code.startsWith('AUTH_SMS_CODE')) return setErrors({ code: error.message });
      }
      toast.text(errorMessage(error));
      return;
    }
    // Every session ended with the change, this one too.
    await renewSession();
    toast.success(hasPassword ? '密码已修改' : '密码已设置');
    void goBack();
  }

  const clear = (key: keyof Errors) => setErrors((current) => ({ ...current, [key]: undefined }));
  return (
    <View className="account-page">
      <CellGroup>
        {useSms ? (
          <SmsCodeField
            phone={phone ?? ''}
            onPhoneChange={() => undefined}
            phoneReadOnly
            code={code}
            onCodeChange={(value) => {
              clear('code');
              setCode(value);
            }}
            onSend={() => sendSmsCode(phone ?? '', 'reset-password')}
            codeError={errors.code}
          />
        ) : (
          <Field
            label="原密码"
            password
            placeholder="请输入原密码"
            value={oldPassword}
            maxLength={PASSWORD_MAX}
            error={errors.old}
            onChange={(value) => {
              clear('old');
              setOldPassword(value);
            }}
          />
        )}
        <Field
          label="新密码"
          password
          placeholder="6–64 位"
          value={password}
          maxLength={PASSWORD_MAX}
          error={errors.password}
          onChange={(value) => {
            clear('password');
            setPassword(value);
          }}
        />
        <Field
          label="确认密码"
          password
          placeholder="再输入一次"
          value={confirm}
          maxLength={PASSWORD_MAX}
          error={errors.confirm}
          onChange={(value) => {
            clear('confirm');
            setConfirm(value);
          }}
        />
      </CellGroup>
      {hasPassword ? (
        <View className="password__switch">
          <Button variant="text" size="sm" onClick={() => setUseSms(!useSms)}>
            {useSms ? '用原密码修改' : '忘记原密码？用短信验证码'}
          </Button>
        </View>
      ) : null}
      <SubmitBar>
        <Button size="lg" block loading={change.isPending} onClick={() => submit()}>
          {hasPassword ? '确认修改' : '设置密码'}
        </Button>
      </SubmitBar>
    </View>
  );
}
