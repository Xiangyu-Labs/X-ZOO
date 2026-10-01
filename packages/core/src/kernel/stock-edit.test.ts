import { describe, expect, it } from 'vitest';
import { resolveStockEdit } from './stock-edit';

describe('resolveStockEdit', () => {
  it('writes the sent number when the form says nothing about what it saw', () => {
    expect(resolveStockEdit({ sent: 5, expected: undefined, current: 9 })).toEqual({
      kind: 'write',
      value: 5,
    });
  });

  it('writes the sent number for a row that does not exist yet', () => {
    expect(resolveStockEdit({ sent: 5, expected: 3, current: undefined })).toEqual({
      kind: 'write',
      value: 5,
    });
  });

  it('keeps what is there when the operator left the number alone', () => {
    expect(resolveStockEdit({ sent: 10, expected: 10, current: 7 })).toEqual({
      kind: 'write',
      value: 7,
    });
  });

  it('writes a changed number when nobody moved the row', () => {
    expect(resolveStockEdit({ sent: 50, expected: 10, current: 10 })).toEqual({
      kind: 'write',
      value: 50,
    });
  });

  it('is a conflict when the operator changed it and orders moved it too', () => {
    expect(resolveStockEdit({ sent: 50, expected: 10, current: 7 })).toEqual({
      kind: 'conflict',
      current: 7,
    });
  });
});
