import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { LandingData } from '@/server/landing';

import { LandingPage } from './landing-page';

const base: LandingData = { shopName: '某某小店', miniName: '某某小店', codeUrl: null, footer: [] };

describe('the landing page', () => {
  it('shows the shop name, the 小程序码 and "scan in WeChat" when WeChat is configured', () => {
    render(<LandingPage data={{ ...base, codeUrl: '/uploads/wechat-mini-code/code.png' }} />);

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('某某小店');
    const code = screen.getByRole('img', { name: '某某小店 小程序码' });
    expect(code).toHaveAttribute('src', '/uploads/wechat-mini-code/code.png');
    expect(screen.getByText('请使用微信扫码打开')).toBeInTheDocument();
  });

  it('falls back to text, with the name to search for, when WeChat is not configured', () => {
    render(<LandingPage data={{ ...base, miniName: '某某小店商城' }} />);

    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByText('请在微信中搜索「某某小店商城」小程序')).toBeInTheDocument();
  });

  it('still renders when the settings could not be read', () => {
    render(<LandingPage data={{ shopName: null, miniName: null, codeUrl: null, footer: [] }} />);

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('欢迎光临');
    expect(screen.getByText('请在微信中打开本店小程序')).toBeInTheDocument();
    expect(screen.queryByRole('contentinfo')).toBeNull();
  });

  it('links a 备案 line only when it has an http(s) link', () => {
    render(
      <LandingPage
        data={{
          ...base,
          footer: [
            { text: '沪ICP备00000000号-1', href: 'https://beian.miit.gov.cn/' },
            { text: '© 某某小店' },
          ],
        }}
      />,
    );

    expect(screen.getByRole('link', { name: '沪ICP备00000000号-1' })).toHaveAttribute(
      'href',
      'https://beian.miit.gov.cn/',
    );
    expect(screen.getByText('© 某某小店').tagName).toBe('SPAN');
  });
});
