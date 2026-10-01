import { afterEach, describe, expect, it, vi } from 'vitest';

const production = vi.hoisted(() => ({ value: false }));

vi.mock('@/server/env', () => ({ isProduction: () => production.value }));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));

import DevLayout from './layout';

afterEach(() => {
  production.value = false;
});

describe('/admin/dev/*', () => {
  it('is a 404 in production', () => {
    production.value = true;
    expect(() => DevLayout({ children: 'demo' })).toThrow('NEXT_NOT_FOUND');
  });

  it('is served everywhere else, the admin e2e suite included', () => {
    expect(DevLayout({ children: 'demo' })).toBe('demo');
  });
});
