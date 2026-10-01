import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderAdmin } from '@/test/render';

import { MoneyInput } from './money-input';

function Harness({ initial, onValue }: { initial?: string; onValue?: (value?: string) => void }) {
  const [value, setValue] = useState<string | undefined>(initial);
  return (
    <>
      <MoneyInput
        value={value}
        onChange={(next) => {
          setValue(next);
          onValue?.(next);
        }}
      />
      <span data-testid="value">{value ?? 'undefined'}</span>
    </>
  );
}

const input = (): HTMLInputElement => screen.getByRole('textbox') as HTMLInputElement;

describe('<MoneyInput>', () => {
  it('shows the value it is given', () => {
    renderAdmin(<Harness initial="12.00" />);
    expect(input().value).toBe('12.00');
  });

  it('emits a two-decimal string while typing whole numbers', async () => {
    const user = userEvent.setup();
    const onValue = vi.fn();
    renderAdmin(<Harness onValue={onValue} />);

    await user.type(input(), '12');
    expect(onValue).toHaveBeenLastCalledWith('12.00');
    expect(screen.getByTestId('value')).toHaveTextContent('12.00');
  });

  it('keeps the raw text while a decimal point is half-typed', async () => {
    const user = userEvent.setup();
    renderAdmin(<Harness />);

    await user.type(input(), '12.');
    // The operator still sees what they typed…
    expect(input().value).toBe('12.');
    // …but the committed value is the last well-formed one.
    expect(screen.getByTestId('value')).toHaveTextContent('12.00');
  });

  it('normalises on blur', async () => {
    const user = userEvent.setup();
    renderAdmin(<Harness />);

    await user.type(input(), '7.5');
    await user.tab();
    expect(input().value).toBe('7.50');
    expect(screen.getByTestId('value')).toHaveTextContent('7.50');
  });

  it('refuses characters that are not part of an amount', async () => {
    const user = userEvent.setup();
    renderAdmin(<Harness />);

    await user.type(input(), '1a2元');
    expect(input().value).toBe('12');
  });

  it('refuses a third decimal digit', async () => {
    const user = userEvent.setup();
    renderAdmin(<Harness />);

    await user.type(input(), '1.234');
    expect(input().value).toBe('1.23');
  });

  it('rejects a minus sign unless negatives are allowed', async () => {
    const user = userEvent.setup();
    renderAdmin(<Harness />);
    await user.type(input(), '-5');
    expect(input().value).toBe('5');
  });

  it('emits undefined when cleared', async () => {
    const user = userEvent.setup();
    const onValue = vi.fn();
    renderAdmin(<Harness initial="12.00" onValue={onValue} />);

    await user.clear(input());
    expect(onValue).toHaveBeenLastCalledWith(undefined);
    expect(screen.getByTestId('value')).toHaveTextContent('undefined');
  });

  it('adopts a value set from outside', () => {
    const { rerender } = renderAdmin(<MoneyInput value="1.00" />);
    rerender(<MoneyInput value="2.50" />);
    expect(input().value).toBe('2.50');
  });

  it('shows the currency prefix', () => {
    renderAdmin(<MoneyInput value="1.00" />);
    expect(screen.getByText('¥')).toBeInTheDocument();
  });
});
