import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SmsCodeField } from './sms-code-field';

function Harness({
  onSend,
  initialPhone = '',
}: {
  onSend: () => Promise<number>;
  initialPhone?: string;
}) {
  const [phone, setPhone] = useState(initialPhone);
  const [code, setCode] = useState('');
  return (
    <SmsCodeField
      phone={phone}
      onPhoneChange={setPhone}
      code={code}
      onCodeChange={setCode}
      onSend={onSend}
    />
  );
}

describe('SmsCodeField', () => {
  afterEach(() => vi.useRealTimers());

  it('checks the number before sending', () => {
    const onSend = vi.fn(() => Promise.resolve(60));
    render(<Harness onSend={onSend} initialPhone="1380013" />);
    fireEvent.click(screen.getByRole('button', { name: '获取验证码' }));
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByText('请输入正确的手机号')).toBeTruthy();
  });

  it('counts down after sending, then offers to send again', async () => {
    vi.useFakeTimers();
    const onSend = vi.fn(() => Promise.resolve(2));
    render(<Harness onSend={onSend} initialPhone="13800138000" />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '获取验证码' }));
      await Promise.resolve();
    });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: '2 秒后重发' }).getAttribute('aria-disabled')).toBe(
      'true',
    );
    act(() => vi.advanceTimersByTime(2000));
    expect(screen.getByRole('button', { name: '获取验证码' })).toBeTruthy();
  });

  it('keeps time while the app was in the background, where timers wait', async () => {
    vi.useFakeTimers();
    render(<Harness onSend={() => Promise.resolve(60)} initialPhone="13800138000" />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '获取验证码' }));
      await Promise.resolve();
    });
    // Off to read the code: 30 s pass with no tick.
    vi.setSystemTime(Date.now() + 30_000);
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByRole('button', { name: '29 秒后重发' })).toBeTruthy();
  });

  it('shows why sending failed', async () => {
    const onSend = vi.fn(() => Promise.reject(new Error('发送太频繁，请稍后再试')));
    render(<Harness onSend={onSend} initialPhone="13800138000" />);
    fireEvent.click(screen.getByRole('button', { name: '获取验证码' }));
    expect(await screen.findByText('发送太频繁，请稍后再试')).toBeTruthy();
  });
});
