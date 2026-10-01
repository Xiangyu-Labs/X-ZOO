import { describe, expect, it } from 'vitest';

import { fixedClock } from './clock';
import { testSteps } from './config-test';

const clock = fixedClock('2026-09-24T10:00:00Z');

describe('testSteps', () => {
  it('stops at the first failure and reports the thrown message', async () => {
    const t = testSteps({ clock });
    await t.step('一', async () => '好');
    await t.step('二', async () => {
      throw new Error('坏了');
    });
    const ran = await t.step('三', async () => '不该跑');
    expect(ran).toBe(false);
    expect(t.result()).toEqual({
      ok: false,
      steps: [
        { name: '一', ok: true, detail: '好', ms: 0 },
        { name: '二', ok: false, detail: '坏了', ms: 0 },
      ],
    });
  });

  it('is not ok with no steps at all', () => {
    expect(testSteps({ clock }).result().ok).toBe(false);
  });
});
