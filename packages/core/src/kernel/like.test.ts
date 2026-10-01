import { describe, expect, it } from 'vitest';

import { containsPattern } from './like';

describe('containsPattern', () => {
  it('matches the keyword literally: 100%, a_b and a backslash are not wildcards', () => {
    expect(containsPattern('100%纯棉')).toBe('%100\\%纯棉%');
    expect(containsPattern('a_b')).toBe('%a\\_b%');
    expect(containsPattern('C:\\x')).toBe('%C:\\\\x%');
    expect(containsPattern('小明')).toBe('%小明%');
  });
});
