import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

import { takeFixtureFailures } from './api';

// Page components own a `CrudTable`, which binds its state to the URL through
// `next/navigation`. There is no app router in a component test, so every test file gets this
// inert one; a test that cares about navigation declares its own `vi.mock('next/navigation')`.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/admin',
  useSearchParams: () => new URLSearchParams(),
  redirect: vi.fn(),
  notFound: vi.fn(),
}));

// antd probes both of these at import time; happy-dom ships neither.
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
}

if (!globalThis.scrollTo) {
  globalThis.scrollTo = (() => {}) as unknown as typeof globalThis.scrollTo;
}

// antd 6 warns about a few deprecated props from inside rc-* internals during
// tests; keep the output readable without hiding our own console noise.
const originalWarn = console.warn;
console.warn = (...args: unknown[]) => {
  if (typeof args[0] === 'string' && args[0].startsWith('Warning: [antd:')) return;
  originalWarn(...(args as []));
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  // A fixture that disagrees with its contract is thrown inside the stubbed
  // `fetch`, where the client reports it as a network error; this is where it
  // fails the test that owns it, whatever the component made of it.
  const failures = takeFixtureFailures();
  if (failures.length > 0) throw new Error(failures.join('\n\n'));
});
