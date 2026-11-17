import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';

import { renderAdmin } from '@/test/render';

import { RemoteSelect, type RemoteSelectOption } from './remote-select';

/**
 * A picker over a server-paged list: typing is the search, and the selected
 * tags keep their names when the next search replaces the rows. A fixed
 * `options` array would silently stop at whatever page it was given.
 */

const firstPage: RemoteSelectOption[] = [
  { value: '1', label: '第一个' },
  { value: '2', label: '第二个' },
];

function Harness({
  loadOptions,
  multiple = false,
  active = true,
}: {
  loadOptions: (keyword: string) => Promise<readonly RemoteSelectOption[]>;
  multiple?: boolean;
  active?: boolean;
}) {
  const [value, setValue] = useState<string[]>([]);
  return (
    <RemoteSelect
      aria-label="标签"
      loadOptions={loadOptions}
      cacheKey="test.remote"
      multiple={multiple}
      active={active}
      value={multiple ? value : (value[0] ?? undefined)}
      onChange={(next) => setValue(next === undefined ? [] : Array.isArray(next) ? next : [next])}
    />
  );
}

describe('<RemoteSelect>', () => {
  it('sends the typed keyword to the server and shows what it answers', async () => {
    const user = userEvent.setup();
    const loadOptions = vi.fn(async (keyword: string) =>
      keyword === '' ? firstPage : [{ value: '3', label: '第三个' }],
    );
    renderAdmin(<Harness loadOptions={loadOptions} />);

    const select = screen.getByRole('combobox', { name: '标签' });
    await user.click(select);
    await screen.findByText('第一个');

    await user.type(select, '第三');

    await waitFor(() => expect(loadOptions).toHaveBeenCalledWith('第三'));
    expect(await screen.findByText('第三个')).toBeInTheDocument();
  });

  it('keeps a chosen tag’s name after the search replaces the rows', async () => {
    const user = userEvent.setup();
    const loadOptions = vi.fn(async (keyword: string) =>
      keyword === '' ? firstPage : [{ value: '3', label: '第三个' }],
    );
    renderAdmin(<Harness loadOptions={loadOptions} multiple />);

    const select = screen.getByRole('combobox', { name: '标签' });
    await user.click(select);
    await screen.findByText('第一个');
    await user.click(screen.getByText('第一个'));

    // The dropdown closes after a multi-select pick; search again.
    await user.type(select, '第三');
    await waitFor(() => expect(screen.queryByText('第二个')).toBeNull());

    // The selected value is still rendered by name, not as its id.
    const tag = document.querySelector('.ant-select-selection-item');
    expect(tag).toHaveTextContent('第一个');
    expect(tag?.textContent).not.toBe('1');
  });

  it('does not ask for options when the viewer may not read them', async () => {
    const loadOptions = vi.fn(async () => firstPage);
    renderAdmin(<Harness loadOptions={loadOptions} active={false} />);

    expect(loadOptions).not.toHaveBeenCalled();
  });
});
