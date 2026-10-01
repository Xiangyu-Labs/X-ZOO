import { useState } from 'react';
import { View } from '@tarojs/components';
import { isApiError } from '@shop/api-client';
import { useRouteMutation } from '@shop/api-client/react';
import { goBack } from '@/platform';
import { Button } from '@/ui/button';
import { CellGroup } from '@/ui/cell';
import { toast } from '@/ui/feedback';
import { Field } from '@/ui/field';
import { PageShell } from '@/ui/page-shell';
import { PHONE_PATTERN, SmsCodeField } from '@/ui/sms-code-field';
import { SubmitBar, errorMessage } from '../shared/form';
import { PASSWORD_MAX, checkNewPassword } from '../shared/password';
import { SMS_CODE_PATTERN, sendSmsCode } from '../shared/sms';

type Errors = Partial<Record<'code' | 'password' | 'confirm', string>>;

/**
 * 找回密码 (`passwordReset`, pages.md §2.6): no session needed. The bound phone number, an SMS
 * code, a new password; then back to where the shopper came from (the login page) to sign in.
 */
export default function PasswordResetPage() {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const reset = useRouteMutation('auth.resetPassword');

  async function submit() {
    if (!PHONE_PATTERN.test(phone)) {
      toast.text('请输入正确的手机号');
      return;
    }
    const next: Errors = checkNewPassword({ password, confirm });
    if (!SMS_CODE_PATTERN.test(code)) next.code = '请输入 6 位验证码';
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    try {
      await reset.mutateAsync({ body: { phone, code, password } });
    } catch (error) {
      if (isApiError(error, 'auth.resetPassword') && error.code.startsWith('AUTH_SMS_CODE')) {
        setErrors({ code: error.message });
        return;
      }
      toast.text(errorMessage(error));
      return;
    }
    toast.success('密码已重置，请重新登录');
    void goBack();
  }

  const clear = (key: keyof Errors) => setErrors((current) => ({ ...current, [key]: undefined }));
  return (
    <PageShell title="找回密码" withBar>
      <View className="account-page">
        <CellGroup>
          <SmsCodeField
            phone={phone}
            onPhoneChange={setPhone}
            code={code}
            onCodeChange={(value) => {
              clear('code');
              setCode(value);
            }}
            onSend={() => sendSmsCode(phone, 'reset-password')}
            codeError={errors.code}
          />
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
        <SubmitBar>
          <Button size="lg" block loading={reset.isPending} onClick={() => submit()}>
            重置密码
          </Button>
        </SubmitBar>
      </View>
    </PageShell>
  );
}
