import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { taroFake } from '@/test/taro-fake/taro';
import { AgreementCheck } from './agreement-check';

describe('AgreementCheck', () => {
  it('is unchecked until the shopper ticks it', () => {
    const onChange = vi.fn();
    render(<AgreementCheck checked={false} onChange={onChange} />);
    const box = screen.getByRole('checkbox', { name: '我已阅读并同意用户协议和隐私政策' });
    expect(box.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(box);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('opens each agreement', async () => {
    render(<AgreementCheck checked onChange={() => undefined} />);
    fireEvent.click(screen.getByRole('link', { name: '用户协议' }));
    fireEvent.click(screen.getByRole('link', { name: '隐私政策' }));
    await vi.waitFor(() =>
      expect(taroFake.calls.filter((c) => c.api === 'navigateTo')).toHaveLength(2),
    );
    const urls = taroFake.calls.map((call) => (call.args as { url: string }).url);
    expect(urls).toEqual(['/pages/agreement/index?key=user', '/pages/agreement/index?key=privacy']);
  });

  it('shakes again on each new shake count', () => {
    const { container, rerender } = render(
      <AgreementCheck checked={false} onChange={() => undefined} shake={1} />,
    );
    expect(container.firstElementChild?.className).toContain('shop-agreement--shake-1');
    rerender(<AgreementCheck checked={false} onChange={() => undefined} shake={2} />);
    expect(container.firstElementChild?.className).toContain('shop-agreement--shake-0');
  });
});
