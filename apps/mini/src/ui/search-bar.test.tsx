import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SearchBar } from './search-bar';

describe('SearchBar', () => {
  it('is a read-only entry that opens search', () => {
    const onOpen = vi.fn();
    render(<SearchBar onOpen={onOpen} placeholder="搜索坚果" />);
    expect(screen.queryByRole('textbox')).toBeNull();
    fireEvent.click(screen.getByRole('link', { name: '搜索坚果' }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('types, clears and searches with the trimmed words', () => {
    const onChange = vi.fn();
    const onSearch = vi.fn();
    const { rerender } = render(<SearchBar value="" onChange={onChange} onSearch={onSearch} />);
    expect(screen.queryByRole('button', { name: '清除' })).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: '搜索商品' }), {
      target: { value: ' 坚果 ' },
    });
    expect(onChange).toHaveBeenCalledWith(' 坚果 ');
    rerender(<SearchBar value=" 坚果 " onChange={onChange} onSearch={onSearch} />);
    fireEvent.click(screen.getByRole('button', { name: '搜索' }));
    expect(onSearch).toHaveBeenCalledWith('坚果');
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(onSearch).toHaveBeenLastCalledWith('坚果');
    fireEvent.click(screen.getByRole('button', { name: '清除' }));
    expect(onChange).toHaveBeenLastCalledWith('');
  });
});
