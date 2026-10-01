import { describe, expect, it } from 'vitest';
import { refundNoteOf } from './groupbuy.notifications';

describe('the refund notice’s money wording', () => {
  it('names the amount going back', () => {
    expect(refundNoteOf('59.00')).toBe('的 ¥59.00 将原路退回');
  });

  it('does not promise a ¥0.00 refund for an order that cost nothing', () => {
    expect(refundNoteOf('0.00')).toBe('已关闭，没有产生扣款');
    expect(refundNoteOf(null)).toBe('已关闭，没有产生扣款');
  });
});
