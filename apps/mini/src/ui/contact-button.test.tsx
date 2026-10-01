import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useAppConfigStore, type AppConfig } from '@/app-config';
import { taroFake } from '@/test/taro-fake/taro';
import { ContactButton, sessionFromOf } from './contact-button';

function withSupport(support: AppConfig['support']) {
  useAppConfigStore.setState({ config: { support } as AppConfig, source: 'network' });
}

describe('ContactButton', () => {
  afterEach(() => useAppConfigStore.setState({ config: null, source: 'none' }));

  it("opens WeChat's customer service with the page as the session source", () => {
    withSupport({ kind: 'mini-program', phone: null, qrcodeUrl: null });
    render(<ContactButton sessionFrom={sessionFromOf('product', '11')} />);
    const button = screen.getByRole('button', { name: '联系客服' });
    expect(button.dataset['openType']).toBe('contact');
    expect(button.dataset['sessionFrom']).toBe('route:product;id:11');
  });

  it('calls the hotline when that is what the shop has', () => {
    withSupport({ kind: 'phone', phone: '400-000-0000', qrcodeUrl: null });
    render(<ContactButton sessionFrom="route:order" />);
    fireEvent.click(screen.getByRole('button', { name: '拨打客服电话 400-000-0000' }));
    expect(taroFake.calls).toContainEqual({
      api: 'makePhoneCall',
      args: { phoneNumber: '400-000-0000' },
    });
  });

  it('is not there when the shop has no customer service', () => {
    withSupport({ kind: 'none', phone: null, qrcodeUrl: null });
    const { container } = render(<ContactButton sessionFrom="route:order" />);
    expect(container.textContent).toBe('');
  });
});
