import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Stepper } from './stepper';

describe('Stepper', () => {
  it('steps within min and max, with the button at a limit disabled', () => {
    const onChange = vi.fn();
    const { rerender } = render(<Stepper value={1} min={1} max={3} onChange={onChange} />);
    const less = screen.getByRole('button', { name: '减少数量' });
    expect(less.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(less);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '增加数量' }));
    expect(onChange).toHaveBeenCalledWith(2);
    rerender(<Stepper value={3} min={1} max={3} onChange={onChange} />);
    expect(screen.getByRole('button', { name: '增加数量' }).getAttribute('aria-disabled')).toBe(
      'true',
    );
    expect(screen.getByRole('button', { name: '数量 3，点按输入' }).textContent).toBe('3');
  });

  it('is text until tapped, so the tap that opened its sheet cannot bring up the keyboard', () => {
    render(<Stepper value={2} max={5} onChange={vi.fn()} />);
    expect(screen.queryByRole('textbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '数量 2，点按输入' }));
    expect((screen.getByRole('textbox', { name: '数量' }) as HTMLInputElement).value).toBe('2');
  });

  it('clamps a typed number on blur, and restores nonsense', () => {
    const onChange = vi.fn();
    render(<Stepper value={2} max={5} onChange={onChange} />);
    const edit = () => {
      fireEvent.click(screen.getByRole('button', { name: /^数量 \d+，点按输入$/ }));
      return screen.getByRole('textbox', { name: '数量' }) as HTMLInputElement;
    };
    let input = edit();
    fireEvent.change(input, { target: { value: '99' } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith(5);
    expect(screen.queryByRole('textbox')).toBeNull();
    input = edit();
    fireEvent.change(input, { target: { value: 'abc' } });
    fireEvent.blur(input);
    expect(screen.getByRole('button', { name: '数量 2，点按输入' }).textContent).toBe('2');
  });

  it('does not open for typing while disabled, nor reopen when enabled again', () => {
    const { rerender } = render(<Stepper value={1} disabled onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '数量 1，点按输入' }));
    expect(screen.queryByRole('textbox')).toBeNull();
    rerender(<Stepper value={1} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '数量 1，点按输入' }));
    expect(screen.getByRole('textbox', { name: '数量' })).toBeTruthy();
    rerender(<Stepper value={1} disabled onChange={vi.fn()} />);
    rerender(<Stepper value={1} onChange={vi.fn()} />);
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});
