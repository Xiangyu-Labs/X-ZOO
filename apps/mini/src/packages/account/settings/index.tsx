import { View } from '@tarojs/components';
import type { StorefrontRoute } from '@shop/api-client/routes';
import { navigate } from '@/platform';
import { logout, useSession } from '@/session/session';
import { Button } from '@/ui/button';
import { Cell, CellGroup } from '@/ui/cell';
import { confirm, toast } from '@/ui/feedback';
import { PageShell } from '@/ui/page-shell';
import './index.scss';

const go = (route: StorefrontRoute) => () => void navigate(route);

/**
 * 设置 (`settings`, pages.md §2.6, C18): the account's pages, the agreements, 注销账号 and
 * signing out (this device, or every device). Reachable signed out too: the agreements are
 * for everyone; the account rows then lead to their own sign-in prompts.
 */
export default function SettingsPage() {
  const signedIn = useSession((state) => state.session.status === 'signed-in');

  async function signOut(everywhere: boolean) {
    const ok = await confirm({
      title: everywhere ? '退出全部设备' : '退出登录',
      content: everywhere
        ? '所有设备上的登录都会失效，需要重新登录。'
        : '退出后，下单、查看订单需要重新登录。',
      confirmText: '退出',
      danger: everywhere,
    });
    if (!ok) return;
    await logout({ everywhere });
    toast.success('已退出');
    void navigate({ route: 'me', params: {} });
  }

  return (
    <PageShell title="设置">
      <View className="account-page">
        <CellGroup title="账号">
          <Cell title="个人资料" onClick={go({ route: 'profile', params: {} })} />
          <Cell title="手机号" onClick={go({ route: 'phone', params: {} })} />
          <Cell title="登录密码" onClick={go({ route: 'password', params: {} })} />
          <Cell title="收货地址" onClick={go({ route: 'addresses', params: {} })} />
          <Cell title="发票抬头" onClick={go({ route: 'invoices', params: { tab: 'titles' } })} />
        </CellGroup>
        <CellGroup title="关于">
          <Cell title="用户协议" onClick={go({ route: 'agreement', params: { key: 'user' } })} />
          <Cell title="隐私政策" onClick={go({ route: 'agreement', params: { key: 'privacy' } })} />
          <Cell title="注销账号" onClick={go({ route: 'cancellation', params: {} })} />
        </CellGroup>
        {signedIn ? (
          <View className="settings__actions">
            <Button variant="outline" size="lg" block onClick={() => signOut(false)}>
              退出登录
            </Button>
            <Button variant="text" size="md" block onClick={() => signOut(true)}>
              退出全部设备
            </Button>
          </View>
        ) : null}
      </View>
    </PageShell>
  );
}
