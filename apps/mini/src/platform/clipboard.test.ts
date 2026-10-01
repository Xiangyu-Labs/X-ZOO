import { describe, expect, it } from 'vitest';
import { taroFake } from '@/test/taro-fake/taro';
import { copyText } from './clipboard';

const toastTitle = () =>
  (taroFake.calls.findLast((call) => call.api === 'showToast')?.args as { title?: string })?.title;

describe('copyText', () => {
  it('copies, and WeChat says so itself', async () => {
    await expect(copyText('P1')).resolves.toBe(true);
    expect(taroFake.calls).toContainEqual({ api: 'setClipboardData', args: { data: 'P1' } });
    expect(toastTitle()).toBeUndefined();
  });

  it('names a privacy refusal, apart from any other failure', async () => {
    taroFake.clipboardError = 'setClipboardData:fail privacy permission is not authorized';
    await expect(copyText('P1')).resolves.toBe(false);
    expect(toastTitle()).toBe('未同意隐私保护指引，无法复制，请长按手动复制');

    taroFake.clipboardError = 'setClipboardData:fail system error';
    await copyText('P1');
    expect(toastTitle()).toBe('复制失败，请长按手动复制');
  });
});
