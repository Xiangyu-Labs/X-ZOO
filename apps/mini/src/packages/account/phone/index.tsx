import { useState } from 'react';
import { Text, View } from '@tarojs/components';
import { useRouteMutation, useRouteQuery } from '@shop/api-client/react';
import { maskPhone } from '@/lib/format';
import { goBack, isPrivacyRefusal, platform } from '@/platform';
import { LoginGate } from '@/session/login-card';
import { useSignedIn } from '@/session/session';
import { Button, buttonClassName } from '@/ui/button';
import { CellGroup } from '@/ui/cell';
import { ErrorBlock } from '@/ui/error-block';
import { toast } from '@/ui/feedback';
import { PageShell } from '@/ui/page-shell';
import { CellSkeleton } from '@/ui/skeleton';
import { PHONE_PATTERN, SmsCodeField } from '@/ui/sms-code-field';
import { SubmitBar, errorMessage } from '../shared/form';
import { SMS_CODE_PATTERN, sendSmsCode } from '../shared/sms';
import './index.scss';

const PRIVACY_REFUSED = '未同意隐私保护指引，可改用其他手机号绑定';

/**
 * 手机号 (`phone`, pages.md §2.6): with no number yet, 绑定 — WeChat's own number first
 * (`getPhoneNumber`), an SMS code as the alternative; with one, 更换 — an SMS code to the new
 * number only (the old one may be gone with the SIM).
 */
export default function PhonePage() {
  return (
    <PageShell title="手机号" withBar>
      <LoginGate reason="登录后可以绑定手机号" redirect={{ route: 'phone', params: {} }}>
        <PhoneBody />
      </LoginGate>
    </PageShell>
  );
}

function PhoneBody() {
  const signedIn = useSignedIn();
  const profile = useRouteQuery('user.getProfile', undefined, { enabled: signedIn });
  if (profile.isPending) return <CellSkeleton rows={2} />;
  if (profile.isError) {
    return <ErrorBlock error={profile.error} onRetry={() => profile.refetch()} />;
  }
  return <PhoneForm current={profile.data.phone} />;
}

function PhoneForm({ current }: { current: string | null }) {
  const [mode, setMode] = useState<'wechat' | 'sms'>(current ? 'sms' : 'wechat');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | undefined>();
  const invalidate = { invalidate: ['user.getProfile'] } as const;
  const bindWechat = useRouteMutation('auth.bindPhoneWechatMini', invalidate);
  const bindSms = useRouteMutation('auth.bindPhone', invalidate);
  const change = useRouteMutation('auth.changePhone', invalidate);
  const changing = current !== null;

  function done(message: string) {
    toast.success(message);
    void goBack();
  }

  async function submit() {
    if (!PHONE_PATTERN.test(phone)) {
      toast.text('请输入正确的手机号');
      return;
    }
    if (!SMS_CODE_PATTERN.test(code)) {
      setCodeError('请输入 6 位验证码');
      return;
    }
    try {
      if (changing) await change.mutateAsync({ body: { phone, code } });
      else await bindSms.mutateAsync({ body: { phone, code } });
      done(changing ? '手机号已更换' : '手机号已绑定');
    } catch (error) {
      setCodeError(errorMessage(error));
    }
  }

  return (
    <View className="account-page">
      <View className="phone__head">
        <Text className="phone__label">{changing ? '当前手机号' : '还没有绑定手机号'}</Text>
        {current ? <Text className="phone__current">{maskPhone(current)}</Text> : null}
        <Text className="phone__hint">
          {changing
            ? '更换后，用新手机号接收验证码和订单通知。'
            : '绑定后，可以用手机号登录，也能接收订单通知。'}
        </Text>
      </View>

      {mode === 'wechat' ? (
        <View className="phone__actions">
          <platform.PhoneNumberButton
            className={buttonClassName({ size: 'lg', block: true })}
            disabled={bindWechat.isPending}
            onResult={(result) => {
              if (!result.ok) {
                if (result.reason === 'unavailable') setMode('sms');
                // WeChat's own errMsg is English; 使用其他手机号 (an SMS code) still works.
                if (isPrivacyRefusal(result.message)) toast.text(PRIVACY_REFUSED);
                else if (result.reason !== 'denied') toast.text(result.message);
                return;
              }
              bindWechat.mutateAsync({ body: { phoneCode: result.code } }).then(
                () => done('手机号已绑定'),
                (error: unknown) => toast.text(errorMessage(error)),
              );
            }}
          >
            使用微信手机号
          </platform.PhoneNumberButton>
          <Button variant="text" size="md" onClick={() => setMode('sms')}>
            使用其他手机号
          </Button>
        </View>
      ) : (
        <>
          <CellGroup>
            <SmsCodeField
              phone={phone}
              onPhoneChange={setPhone}
              code={code}
              onCodeChange={(value) => {
                setCodeError(undefined);
                setCode(value);
              }}
              onSend={() => sendSmsCode(phone, changing ? 'change-phone' : 'bind-phone')}
              codeError={codeError}
            />
          </CellGroup>
          {!changing ? (
            <View className="phone__switch">
              <Button variant="text" size="sm" onClick={() => setMode('wechat')}>
                使用微信手机号
              </Button>
            </View>
          ) : null}
          <SubmitBar>
            <Button
              size="lg"
              block
              loading={bindSms.isPending || change.isPending}
              onClick={() => submit()}
            >
              {changing ? '确认更换' : '绑定'}
            </Button>
          </SubmitBar>
        </>
      )}
    </View>
  );
}
