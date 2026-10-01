import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { installPrivacyHandler, resetPrivacyForTest } from '@/platform/privacy';
import { taroFake } from '@/test/taro-fake/taro';
import { PrivacySheet } from './privacy-sheet';

describe('PrivacySheet', () => {
  beforeEach(() => {
    resetPrivacyForTest();
    installPrivacyHandler();
  });

  it('opens when WeChat asks, says why, and a refusal answers disagree once', async () => {
    render(<PrivacySheet />);
    let resolved: Array<{ event: string }> = [];
    act(() => {
      resolved = taroFake.needPrivacy('chooseAddress');
    });
    const dialog = await screen.findByRole('dialog', { name: '用户隐私保护提示' });
    expect(dialog.textContent).toContain('为了');
    expect(resolved).toEqual([{ event: 'exposureAuthorization' }]);
    fireEvent.click(screen.getByRole('button', { name: '拒绝' }));
    expect(resolved).toEqual([{ event: 'exposureAuthorization' }, { event: 'disagree' }]);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('shows one sheet for several asks and answers each of them once on agree', async () => {
    render(<PrivacySheet />);
    let first: Array<{ event: string; buttonId?: string }> = [];
    let second: Array<{ event: string; buttonId?: string }> = [];
    act(() => {
      first = taroFake.needPrivacy('chooseMedia');
      second = taroFake.needPrivacy('setClipboardData');
    });
    await screen.findByRole('dialog');
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '同意' }));
    expect(first).toEqual([
      { event: 'exposureAuthorization' },
      { event: 'agree', buttonId: 'privacy-agree' },
    ]);
    expect(second).toEqual([{ event: 'agree', buttonId: 'privacy-agree' }]);
    // A later tap does not answer anyone twice.
    act(() => undefined);
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(1);
  });

  it('opens the privacy guide from a link a screen reader can name', async () => {
    render(<PrivacySheet />);
    act(() => void taroFake.needPrivacy());
    fireEvent.click(await screen.findByRole('link', { name: '用户隐私保护指引' }));
    expect(taroFake.calls.some((call) => call.api === 'openPrivacyContract')).toBe(true);
  });

  it('cannot be dismissed by the mask or a close button', async () => {
    const { container } = render(<PrivacySheet />);
    act(() => void taroFake.needPrivacy());
    await screen.findByRole('dialog');
    expect(screen.queryByRole('button', { name: '关闭' })).toBeNull();
    fireEvent.click(container.querySelector('.shop-mask') as Element);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});
