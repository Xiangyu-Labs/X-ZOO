import type { ReactNode } from 'react';
import { Text, View } from '@tarojs/components';
import type { StorefrontRoute } from '@shop/api-client/routes';
import { isPrivacyRefusal, navigate, platform } from '@/platform';
import { Button, buttonClassName } from '@/ui/button';
import { Empty } from '@/ui/empty';
import { toast } from '@/ui/feedback';
import { bindPhone, startSession, useSession } from './session';
import './login-card.scss';
import { errorMessage } from '@/lib/error-message';

const PRIVACY_REFUSED = '未同意隐私保护指引，可改用短信验证码登录';

export interface LoginCardProps {
  children: ReactNode;
  /** Why signing in helps here: 「登录后即可购买」. */
  reason: string;
  /** Where the SMS login comes back to; the current page, usually. */
  redirect?: StorefrontRoute | undefined;
}

/**
 * Renders `children` for a signed-in shopper, and what it takes to get there otherwise: a line
 * while the silent sign-in runs, the phone-number button when the shop needs a number (with the
 * SMS alternative), a retry after a failure, a login button after signing out. After a failure or
 * a sign-out it also links the login page, whose 密码登录 is the way in while 微信登录 is off.
 * Never navigates away by itself (C05): browsing never needs a session.
 */
export function LoginCard({ children, reason, redirect }: LoginCardProps) {
  const session = useSession((state) => state.session);
  if (session.status === 'signed-in') return <>{children}</>;

  const toLoginPage = (mode?: 'sms') =>
    void navigate({
      route: 'login',
      params: {
        ...(redirect ? { redirect: JSON.stringify(redirect) } : {}),
        ...(mode ? { mode } : {}),
      },
    });

  return (
    <View className="shop-login-card" id="login-card">
      {session.status === 'phone-required' ? (
        <>
          <Text className="shop-login-card__reason">{reason}</Text>
          <platform.PhoneNumberButton
            className={buttonClassName({ variant: 'primary', size: 'lg', block: true })}
            onResult={(result) => {
              if (!result.ok) {
                // WeChat's own errMsg is English; the SMS login below still works (auth.md 隐私保护指引).
                if (isPrivacyRefusal(result.message)) toast.text(PRIVACY_REFUSED);
                else if (result.reason !== 'denied') toast.text(result.message);
                return;
              }
              bindPhone(result.code).catch((error: unknown) => {
                toast.text(errorMessage(error, '登录失败，请重试'));
              });
            }}
          >
            手机号快速登录
          </platform.PhoneNumberButton>
          <Button variant="text" size="sm" onClick={() => toLoginPage('sms')}>
            短信验证码登录
          </Button>
        </>
      ) : session.status === 'failed' ? (
        <>
          <Text className="shop-login-card__reason">{session.message}</Text>
          <Button variant="primary" size="lg" block onClick={() => startSession()}>
            重新登录
          </Button>
          <Button variant="text" size="sm" onClick={() => toLoginPage()}>
            其他方式登录
          </Button>
        </>
      ) : session.status === 'signed-out' ? (
        <>
          <Text className="shop-login-card__reason">{reason}</Text>
          <Button variant="primary" size="lg" block onClick={() => startSession()}>
            登录
          </Button>
          <Button variant="text" size="sm" onClick={() => toLoginPage()}>
            其他方式登录
          </Button>
        </>
      ) : (
        <Text className="shop-login-card__reason">登录中…</Text>
      )}
    </View>
  );
}

/**
 * A whole page's worth of LoginCard (design.md §4.5 `LoginGate`): 我的订单, 我的优惠券… for a
 * shopper who is not signed in; the page itself stays reachable (C05).
 */
export function LoginGate({ children, reason, redirect }: LoginCardProps) {
  const status = useSession((state) => state.session.status);
  if (status === 'signed-in') return <>{children}</>;
  return (
    <View className="shop-login-gate">
      <Empty image="general" title="还没有登录" description={reason} />
      <LoginCard reason={reason} redirect={redirect}>
        {null}
      </LoginCard>
    </View>
  );
}
