import { useState } from 'react';
import { View } from '@tarojs/components';
import { isApiError } from '@shop/api-client';
import { navigate } from '@/platform';
import { signInWithPassword } from '@/session/session';
import { Button } from '@/ui/button';
import { CellGroup } from '@/ui/cell';
import { toast } from '@/ui/feedback';
import { Field } from '@/ui/field';
import { errorMessage } from '@/lib/error-message';

/** The server's bounds (`passwordLoginBody`). */
const ACCOUNT_MAX = 64;
const PASSWORD_MAX = 128;

type Errors = Partial<Record<'account' | 'password', string>>;

export interface PasswordLoginFormProps {
  /** Checks the agreement box first; `false` stops the submit (the page shakes the box). */
  canSubmit: () => boolean;
  /** Back to the WeChat ways. */
  onCancel: () => void;
}

/**
 * 密码登录, under the login page's 其他方式 (pages.md 登录; auth.md「密码登录」): 手机号或账号 and
 * 密码, 忘记密码 to 找回密码. A wrong password is the password field's error (the server says the
 * same thing for an unknown account); throttling, a captcha the mini-program cannot show, or a
 * disabled account are a toast. Signing in is noticed by the page, which goes back to `redirect`.
 */
export function PasswordLoginForm({ canSubmit, onCancel }: PasswordLoginFormProps) {
  const [account, setAccount] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    if (!canSubmit()) return;
    const next: Errors = {};
    if (account.trim() === '') next.account = '请输入手机号或账号';
    if (password === '') next.password = '请输入密码';
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    setSubmitting(true);
    try {
      await signInWithPassword(account.trim(), password);
    } catch (error) {
      if (isApiError(error) && error.code === 'AUTH_INVALID_CREDENTIALS') {
        setErrors({ password: error.message });
      } else if (isApiError(error) && error.code.startsWith('AUTH_CAPTCHA')) {
        // No slider in the mini-program: the shopper waits, or signs in another way.
        toast.text('尝试次数较多，请稍后再试或使用短信验证码登录');
      } else {
        toast.text(errorMessage(error, '登录失败，请重试'));
      }
    } finally {
      setSubmitting(false);
    }
  }

  const clear = (key: keyof Errors) => setErrors((current) => ({ ...current, [key]: undefined }));
  return (
    <View className="login__form">
      <CellGroup inset={false}>
        <Field
          label="账号"
          placeholder="手机号或账号"
          value={account}
          maxLength={ACCOUNT_MAX}
          error={errors.account}
          onChange={(value) => {
            clear('account');
            setAccount(value);
          }}
        />
        <Field
          label="密码"
          password
          placeholder="请输入密码"
          value={password}
          maxLength={PASSWORD_MAX}
          error={errors.password}
          confirmType="go"
          onConfirm={() => submit()}
          onChange={(value) => {
            clear('password');
            setPassword(value);
          }}
        />
      </CellGroup>
      <View className="login__actions">
        <Button size="lg" block loading={submitting} onClick={() => submit()}>
          登录
        </Button>
        <View className="login__links">
          <Button variant="text" size="sm" onClick={onCancel}>
            使用微信登录
          </Button>
          <Button
            variant="text"
            size="sm"
            onClick={() => navigate({ route: 'passwordReset', params: {} })}
          >
            忘记密码
          </Button>
        </View>
      </View>
    </View>
  );
}
