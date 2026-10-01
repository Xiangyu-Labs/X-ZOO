import { defineRoute, id } from '@shop/contracts';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { resetApiConfig } from '@/admin/api/config';
import { on, stubRoutes } from '@/test/api';
import { renderAdmin } from '@/test/render';

import { StatusToggleButton } from './status-toggle-button';

const setEnabled = defineRoute({
  id: 'test.widgetSetEnabled',
  method: 'POST',
  path: '/admin-api/widgets/:id/enabled',
  auth: 'admin',
  permission: 'test:widget:write',
  summary: '启停',
  tags: ['test'],
  params: z.object({ id }),
  body: z.object({ isEnabled: z.boolean() }),
  response: z.object({ id, isEnabled: z.boolean() }),
  examples: [
    {
      name: 'ok',
      params: { id: '1' },
      body: { isEnabled: true },
      response: { id: '1', isEnabled: true },
    },
  ],
});

function Rows({ rows }: { rows: { id: string; isEnabled: boolean }[] }) {
  return (
    <>
      {rows.map((row) => (
        <div key={row.id} data-testid={`row-${row.id}`}>
          <StatusToggleButton
            route={setEnabled}
            on={row.isEnabled}
            input={(next) => ({ params: { id: row.id }, body: { isEnabled: next } })}
            confirmTitle={`停用组件 ${row.id}？`}
          />
        </div>
      ))}
    </>
  );
}

afterEach(() => resetApiConfig());

describe('<StatusToggleButton>', () => {
  it('spins only the row that was clicked', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    stubRoutes([
      on(setEnabled, async (call) => {
        await held;
        return { id: call.params.id ?? '', isEnabled: true };
      }),
    ]);
    const user = userEvent.setup();
    renderAdmin(
      <Rows
        rows={[
          { id: '1', isEnabled: false },
          { id: '2', isEnabled: false },
        ]}
      />,
    );

    const [first, second] = screen.getAllByRole('button', { name: /启\s*用/ });
    await user.click(second!);

    await waitFor(() => expect(second!.className).toContain('ant-btn-loading'));
    expect(first!.className).not.toContain('ant-btn-loading');
    release();
    await waitFor(() => expect(second!.className).not.toContain('ant-btn-loading'));
  });

  it('asks before switching off, then sends isEnabled: false', async () => {
    const calls = stubRoutes([on(setEnabled, { id: '1', isEnabled: false })]);
    const user = userEvent.setup();
    renderAdmin(<Rows rows={[{ id: '1', isEnabled: true }]} />);

    await user.click(screen.getByRole('button', { name: /停\s*用/ }));
    expect(calls).toHaveLength(0);
    expect(await screen.findByText('停用组件 1？')).toBeInTheDocument();

    const confirm = screen
      .getAllByRole('button', { name: /停\s*用/ })
      .find((button) => button.closest('.ant-popconfirm'));
    await user.click(confirm!);

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body).toEqual({ isEnabled: false });
    expect(calls[0]?.params).toEqual({ id: '1' });
  });
});
