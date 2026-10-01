import { describe, expect, it } from 'vitest';
import { appConfigFixture } from '@/test/app-config-fixture';
import { useThemeStore } from './store';

describe('theme store', () => {
  it('derives the accent from appearance, falling back to the primary colour', () => {
    const { appearance } = appConfigFixture;
    useThemeStore.getState().applyAppearance(appearance);
    expect(useThemeStore.getState().theme.accent).toBe(appearance.theme.primaryColor);

    useThemeStore.getState().applyAppearance({
      ...appearance,
      theme: { ...appearance.theme, accentColor: '#FF7E00' },
    });
    expect(useThemeStore.getState().theme).toMatchObject({ accent: '#FF7E00' });
    expect(useThemeStore.getState().style).toContain('#FF7E00');
  });
});
