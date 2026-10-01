import { useState } from 'react';
import { Text, View, WebView } from '@tarojs/components';
import { copyText, goBack, isWebviewAllowed, useRouteParams } from '@/platform';
import { Button } from '@/ui/button';
import { PageShell } from '@/ui/page-shell';
import { Sheet } from '@/ui/sheet';
import './index.scss';

/**
 * 网页 (`webview { url }`, pages.md §2.7, C12). Only a 业务域名 opens: `mp.weixin.qq.com` and
 * the shop's `app/config.webviewDomains` (the `platform/webview` check). Any other link — from
 * an old share, a DIY block, a message — is offered to copy for a browser instead of failing
 * in a blank web-view.
 */
export default function WebviewPage() {
  const { url = '' } = useRouteParams('webview');
  if (isWebviewAllowed(url)) return <WebView src={url} />;
  return <NotAllowed url={url} />;
}

function NotAllowed({ url }: { url: string }) {
  const [open, setOpen] = useState(true);
  const close = () => {
    setOpen(false);
    void goBack();
  };
  return (
    <PageShell title="打开链接" bg="surface">
      <Sheet
        visible={open}
        onClose={close}
        title="该链接需在浏览器中打开"
        footer={
          url ? (
            <Button size="lg" block onClick={() => copyText(url)}>
              复制链接
            </Button>
          ) : (
            <Button size="lg" block onClick={close}>
              返回
            </Button>
          )
        }
      >
        <View className="webview-blocked">
          <Text className="webview-blocked__note">
            {url ? '小程序内无法打开这个网址，复制后可在浏览器中访问。' : '链接地址无效。'}
          </Text>
          {url ? (
            <Text className="webview-blocked__url" userSelect>
              {url}
            </Text>
          ) : null}
        </View>
      </Sheet>
    </PageShell>
  );
}
