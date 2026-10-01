import { describe, expect, it } from 'vitest';
import { taroFake } from '@/test/taro-fake/taro';
import { alert, confirm, toast } from './feedback';

describe('feedback', () => {
  it('toasts through the platform', () => {
    toast.text('已复制');
    toast.loading();
    toast.hide();
    expect(taroFake.calls.map((call) => call.api)).toEqual([
      'showToast',
      'showLoading',
      'hideLoading',
    ]);
  });

  it('confirms with 取消 / 确定 and resolves with the answer', async () => {
    await expect(confirm({ content: '确定取消订单？' })).resolves.toBe(true);
    taroFake.modalConfirm = false;
    await expect(confirm({ content: '确定取消订单？' })).resolves.toBe(false);
    expect(taroFake.calls[0]).toMatchObject({
      api: 'showModal',
      args: {
        content: '确定取消订单？',
        confirmText: '确定',
        cancelText: '取消',
        showCancel: true,
      },
    });
  });

  it('colours a dangerous confirm and alerts with one button', async () => {
    await confirm({ content: '删除后无法恢复', confirmText: '删除', danger: true });
    await alert('库存不足');
    const [danger, single] = taroFake.calls;
    expect((danger?.args as { confirmColor?: string }).confirmColor).toBeTruthy();
    expect(single?.args).toMatchObject({
      content: '库存不足',
      showCancel: false,
      confirmText: '我知道了',
    });
  });
});
