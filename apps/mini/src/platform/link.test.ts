import { describe, expect, it } from 'vitest';
import { taroFake } from '@/test/taro-fake/taro';
import { openLinkTarget } from './link';
import { setWebviewDomains } from './webview';

const lastCall = () => taroFake.calls.at(-1);

describe('openLinkTarget', () => {
  it('opens catalogue kinds through navigate', async () => {
    await openLinkTarget({ kind: 'product', id: '7' });
    expect(lastCall()).toEqual({ api: 'navigateTo', args: { url: '/pages/product/index?id=7' } });
  });

  it('opens an allowed web page in the web-view and copies any other', async () => {
    setWebviewDomains(['h5.example.com']);
    await openLinkTarget({ kind: 'webview', url: 'https://h5.example.com/a' });
    expect(lastCall()?.api).toBe('navigateTo');
    expect(String((lastCall()?.args as { url: string }).url)).toContain('webview');
    await openLinkTarget({ kind: 'webview', url: 'https://elsewhere.example.com/a' });
    expect(taroFake.calls.some((call) => call.api === 'setClipboardData')).toBe(true);
    setWebviewDomains([]);
  });

  it('opens another mini-program, and does nothing without a link', async () => {
    await openLinkTarget({ kind: 'miniprogram', appId: 'wx0123456789abcdef', path: 'pages/a' });
    expect(lastCall()).toEqual({
      api: 'navigateToMiniProgram',
      args: { appId: 'wx0123456789abcdef', path: 'pages/a' },
    });
    const before = taroFake.calls.length;
    await openLinkTarget(null);
    expect(taroFake.calls).toHaveLength(before);
  });
});
