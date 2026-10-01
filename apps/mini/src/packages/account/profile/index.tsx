import { useState } from 'react';
import { View } from '@tarojs/components';
import { useRouteMutation, useRouteQuery } from '@shop/api-client/react';
import { maskPhone } from '@/lib/format';
import { NicknameField, navigate } from '@/platform';
import { LoginGate } from '@/session/login-card';
import { useSignedIn } from '@/session/session';
import { AvatarPicker } from '@/ui/avatar-picker';
import { Button } from '@/ui/button';
import { Cell, CellGroup } from '@/ui/cell';
import { ErrorBlock } from '@/ui/error-block';
import { toast } from '@/ui/feedback';
import { PageShell } from '@/ui/page-shell';
import { CellSkeleton } from '@/ui/skeleton';
import { SubmitBar, errorMessage, fieldErrorsOf } from '../shared/form';
import './index.scss';

const NICKNAME_MAX = 24;

/**
 * 个人资料 (`profile`, pages.md §2.6, C05): WeChat's avatar picker (`chooseAvatar`) and a
 * `type="nickname"` input, which offers the WeChat nickname above the keyboard. Nothing is
 * required. A nickname the server's content check refuses (C09) is said on the field.
 */
export default function ProfilePage() {
  return (
    <PageShell title="个人资料" withBar>
      <LoginGate reason="登录后可以设置头像和昵称" redirect={{ route: 'profile', params: {} }}>
        <ProfileForm />
      </LoginGate>
    </PageShell>
  );
}

function ProfileForm() {
  const signedIn = useSignedIn();
  const profile = useRouteQuery('user.getProfile', undefined, { enabled: signedIn });
  const save = useRouteMutation('user.updateProfile', { invalidate: ['user.getProfile'] });
  const [nickname, setNickname] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>();
  // A request to focus, apart from the error: tied to the error, `focus` went false as the
  // shopper typed (which can drop the keyboard), and a second failed save changed nothing to
  // focus again. Cleared on blur, so the next failure asks anew.
  const [focusNickname, setFocusNickname] = useState(false);

  const saved = profile.data?.nickname ?? '';

  if (profile.isPending) return <CellSkeleton rows={3} />;
  if (profile.isError) {
    return <ErrorBlock error={profile.error} onRetry={() => profile.refetch()} />;
  }

  const value = nickname ?? saved;
  const trimmed = value.trim();
  const changed = trimmed !== saved;

  async function submit() {
    if (!trimmed) {
      setError('请输入昵称');
      setFocusNickname(true);
      return;
    }
    try {
      await save.mutateAsync({ body: { nickname: trimmed } });
      setNickname(trimmed);
      toast.success('已保存');
    } catch (failure) {
      const fields = fieldErrorsOf(failure, { USER_NICKNAME_REJECTED: 'nickname' });
      if (fields?.['nickname']) {
        setError(fields['nickname']);
        setFocusNickname(true);
      } else toast.text(errorMessage(failure));
    }
  }

  const { phone } = profile.data;
  return (
    <View className="account-page">
      <View className="profile__avatar">
        <AvatarPicker src={profile.data.avatarUrl} />
      </View>
      <CellGroup>
        <NicknameField
          id="profile-nickname"
          label="昵称"
          placeholder="填写昵称"
          value={value}
          maxLength={NICKNAME_MAX}
          error={error}
          focus={focusNickname}
          onChange={(next) => {
            setError(undefined);
            setNickname(next);
          }}
          // WeChat fills a `type="nickname"` input from its own suggestion without an input
          // event on some versions; the blur carries the final value.
          onBlur={(next) => {
            setFocusNickname(false);
            if (next !== value) setNickname(next);
          }}
        />
      </CellGroup>
      <CellGroup>
        <Cell
          title="手机号"
          value={phone ? maskPhone(phone) : '未绑定'}
          onClick={() => navigate({ route: 'phone', params: {} })}
        />
        <Cell
          title="登录密码"
          value={profile.data.hasPassword ? '修改' : '未设置'}
          onClick={() => navigate({ route: 'password', params: {} })}
        />
      </CellGroup>
      <SubmitBar>
        <Button size="lg" block disabled={!changed} loading={save.isPending} onClick={submit}>
          保存
        </Button>
      </SubmitBar>
    </View>
  );
}
