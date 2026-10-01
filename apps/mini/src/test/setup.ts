import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import { resetOpenGuard } from '@/platform/nav';
import { contractMismatches } from './fake-api';
import { taroFake } from './taro-fake/taro';

afterEach(() => {
  cleanup();
  taroFake.reset();
  // A test opening the page the previous one just opened is not a double tap.
  resetOpenGuard();
  const mismatches = contractMismatches.splice(0);
  if (mismatches.length > 0) {
    throw new Error(`the fake API disagrees with the contracts:\n${mismatches.join('\n')}`);
  }
});
