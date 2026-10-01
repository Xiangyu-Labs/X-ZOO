import { useEffect, useRef, useState } from 'react';
import { Image, Text, View } from '@tarojs/components';
import { useAppConfig } from '@/app-config';
import { assetUrl } from '@/lib/asset-url';
import {
  goBack,
  isPrivacyRefusal,
  parseLoginRedirect,
  platform,
  returnFromLogin,
  useRouteParams,
} from '@/platform';
import {
  bindPhone,
  bindPhoneWithSms,
  clearSessionNotice,
  sendLoginSms,
  startSession,
  takeSignInHint,
  useSession,
  useSessionNotice,
} from '@/session/session';
import { PasswordLoginForm } from '@/features/auth/password-login';
import { AgreementCheck } from '@/ui/agreement-check';
import { Button, buttonClassName } from '@/ui/button';
import { CellGroup } from '@/ui/cell';
import { toast } from '@/ui/feedback';
import { PageShell } from '@/ui/page-shell';
import { SmsCodeField } from '@/ui/sms-code-field';
import './index.scss';
import { errorMessage } from '@/lib/error-message';

/** The privacy sheet's 拒绝 before 手机号快速登录 (WeChat's errMsg is English). */
const PRIVACY_REFUSED = '未同意隐私保护指引，可改用短信验证码登录';

/**
 * 登录 (`login { redirect? }`, docs/mini/auth.md, design.md §5 G). Reached from
 * `requireLogin()` when the silent sign-in could not finish on its own: the shop wants a phone
 * number (快速登录, or an SMS code), the shopper signed out, or WeChat failed. Also opened by
 * the session when a renewal reached another account (AUTH-010), whose notice replaces the hint
 * under the shop's name. Comes back to
 * `redirect` (a catalogue route, never a path) once signed in, going back when that is the page
 * under it (`loginReturn`); 暂不登录 just goes back. 其他方式 holds 密码登录
 * (`features/auth/password-login`), offered whatever the WeChat sign-in did.
 */
export default function LoginPage() {
  const { redirect, mode: openOn } = useRouteParams('login');
  const session = useSession((state) => state.session);
  // Why the session sent the shopper here (a renewal that reached another account, AUTH-010),
  // until they sign in or leave.
  const notice = useSessionNotice((state) => state.notice);
  useEffect(() => clearSessionNotice, []);
  const config = useAppConfig();
  const [agreed, setAgreed] = useState(false);
  const [shake, setShake] = useState(0);
  const [mode, setMode] = useState<'wechat' | 'sms' | 'password'>(
    openOn === 'sms' ? 'sms' : 'wechat',
  );
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);

  // Leave once. A page opened first stays mounted under the tab it went to, and a later session
  // renewal (signed-in → signing-in → signed-in) must not pull the shopper back from where they are.
  const left = useRef(false);
  useEffect(() => {
    if (session.status !== 'signed-in' || left.current) return;
    left.current = true;
    const target = parseLoginRedirect(redirect) ?? { route: 'home' as const, params: {} };
    // A hint from the sign-in (a password sign-in whose WeChat link was refused) is shown once
    // the shopper is on the page they were going to: here it would leave with this page.
    void returnFromLogin(target)
      .catch(() => undefined)
      .then(() => {
        const hint = takeSignInHint();
        if (hint) toast.long(hint);
      });
  }, [session.status, redirect]);

  function needAgreement(): boolean {
    if (agreed) return false;
    setShake((count) => count + 1);
    toast.text('请先阅读并同意用户协议和隐私政策');
    return true;
  }

  async function submitSms() {
    if (needAgreement()) return;
    if (!/^\d{4,6}$/.test(code)) {
      setCodeError('请输入短信验证码');
      return;
    }
    setSubmitting(true);
    try {
      await bindPhoneWithSms(phone, code);
    } catch (error) {
      setCodeError(errorMessage(error, '登录失败，请重试'));
    } finally {
      setSubmitting(false);
    }
  }

  const logo = assetUrl(config?.logo.login ?? config?.logo.square ?? null);
  const name = config?.name ?? '';
  const waiting = session.status === 'idle' || session.status === 'signing-in';

  return (
    <PageShell title="登录" bg="surface">
      <View className="login">
        <View className="login__brand">
          {logo ? (
            <Image className="login__logo" src={logo} mode="aspectFill" ariaHidden />
          ) : (
            <View className="login__logo login__logo--blank" />
          )}
          {name ? <Text className="login__name">{name}</Text> : null}
          {notice ? (
            <Text className="login__hint login__hint--notice">{notice}</Text>
          ) : (
            <Text className="login__hint">登录后可以下单、查看订单和领取优惠券</Text>
          )}
        </View>

        {mode === 'password' ? (
          <PasswordLoginForm
            canSubmit={() => !needAgreement()}
            onCancel={() => setMode('wechat')}
          />
        ) : mode === 'sms' && (session.status === 'phone-required' || submitting) ? (
          // Kept while the code is checked (`signing-in`): swapping in the 登录中… buttons for
          // that moment made the page jump.
          <View className="login__form">
            <CellGroup inset={false}>
              <SmsCodeField
                phone={phone}
                onPhoneChange={setPhone}
                code={code}
                onCodeChange={(value) => {
                  setCodeError(undefined);
                  setCode(value);
                }}
                onSend={() => sendLoginSms(phone)}
                codeError={codeError}
              />
            </CellGroup>
            <View className="login__actions">
              <Button size="lg" block loading={submitting} onClick={() => submitSms()}>
                登录
              </Button>
              <Button variant="text" size="sm" onClick={() => setMode('wechat')}>
                使用微信手机号登录
              </Button>
            </View>
          </View>
        ) : (
          <View className="login__actions">
            {session.status === 'phone-required' ? (
              agreed ? (
                <platform.PhoneNumberButton
                  className={buttonClassName({ size: 'lg', block: true })}
                  onResult={(result) => {
                    if (!result.ok) {
                      if (result.reason === 'unavailable') setMode('sms');
                      if (isPrivacyRefusal(result.message)) toast.text(PRIVACY_REFUSED);
                      else if (result.reason !== 'denied') toast.text(result.message);
                      return;
                    }
                    bindPhone(result.code).catch((error: unknown) =>
                      toast.text(errorMessage(error, '登录失败，请重试')),
                    );
                  }}
                >
                  手机号快速登录
                </platform.PhoneNumberButton>
              ) : (
                <Button
                  size="lg"
                  block
                  onClick={() => {
                    needAgreement();
                  }}
                >
                  手机号快速登录
                </Button>
              )
            ) : session.status === 'failed' ? (
              <>
                <Text className="login__error">{session.message}</Text>
                <Button size="lg" block onClick={() => startSession()}>
                  重新登录
                </Button>
              </>
            ) : (
              <Button
                size="lg"
                block
                loading={waiting}
                onClick={() => (needAgreement() ? undefined : startSession())}
              >
                {waiting ? '登录中…' : '微信一键登录'}
              </Button>
            )}
            {session.status === 'phone-required' ? (
              <Button variant="outline" size="lg" block onClick={() => setMode('sms')}>
                短信验证码登录
              </Button>
            ) : null}
            {waiting ? null : (
              <View className="login__other">
                <Text className="login__other-title">其他方式</Text>
                <Button variant="text" size="sm" onClick={() => setMode('password')}>
                  密码登录
                </Button>
              </View>
            )}
            <Button variant="text" size="sm" onClick={() => goBack()}>
              暂不登录
            </Button>
          </View>
        )}

        <View className="login__agreement">
          <AgreementCheck checked={agreed} onChange={setAgreed} shake={shake} />
        </View>
      </View>
    </PageShell>
  );
}
