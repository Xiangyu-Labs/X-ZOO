import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { taroFake } from '@/test/taro-fake/taro';
import { applyTabBarLook, bundledTabIcon, type TabBarLook } from './tab-bar';
import { TAB_PAGES } from './tab-pages';

const src = path.resolve(import.meta.dirname, '..');

const look = (items: TabBarLook['items']): TabBarLook => ({
  color: '#666666',
  selectedColor: '#E1251B',
  backgroundColor: '#FFFFFF',
  items,
});

describe('tab bar icons', () => {
  it('bundles a normal and a selected PNG for every tab, 81 × 81 and within 40 KB', () => {
    for (let index = 0; index < TAB_PAGES.length; index++) {
      for (const selected of [false, true]) {
        const file = path.join(src, (bundledTabIcon(index, selected) ?? '').replace(/^\//, ''));
        const bytes = fs.readFileSync(file);
        expect(bytes.subarray(1, 4).toString('ascii'), file).toBe('PNG');
        expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)], file).toEqual([81, 81]);
        expect(bytes.length, file).toBeLessThanOrEqual(40 * 1024);
      }
    }
  });

  it('uses an uploaded icon once downloaded, and the bundled one otherwise', async () => {
    await applyTabBarLook(
      look([
        {
          key: 'home',
          label: '首页',
          iconUrl: 'https://cdn.example.com/home.png',
          selectedIconUrl: null,
        },
        { key: 'me', label: '', iconUrl: null, selectedIconUrl: null },
      ]),
    );
    const items = taroFake.calls
      .filter((call) => call.api === 'setTabBarItem')
      .map((call) => call.args as { index: number })
      .sort((a, b) => a.index - b.index);
    expect(items).toEqual([
      {
        index: 0,
        text: '首页',
        iconPath: 'wxfile://tmp/home.png',
        selectedIconPath: '/assets/tab-bar/home-active.png',
      },
      {
        index: 3,
        text: '我的',
        iconPath: '/assets/tab-bar/me.png',
        selectedIconPath: '/assets/tab-bar/me-active.png',
      },
    ]);
  });
});
