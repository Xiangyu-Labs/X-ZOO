import { defineRoute, id } from '@shop/contracts';
import { QueryClient } from '@tanstack/react-query';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { resetApiConfig } from '@/admin/api/config';
import { on, respondWithError, stubRoutes } from '@/test/api';
import { renderAdmin, zhName } from '@/test/render';

import { ModalForm, useFormModal } from './modal-form';
import type { FieldSpec } from './types';

/**
 * `ModalForm`'s loader.
 *
 * The rule it exists to enforce is one sentence: **an edit form never renders
 * from a list row.** A list route answers the columns, an update route takes
 * the whole record, and a form opened on the row submits every missing field
 * as its default — which on 预售活动 deleted every presale price on the campaign.
 *
 * So the three states are what is tested here, and the middle one — "in flight"
 * — is tested by asserting the fields are *not* there, because a half-populated
 * form on screen is exactly the failure.
 */

const widgetBody = z.object({
  name: z.string().min(1),
  note: z.string().default(''),
});

const detailRoute = defineRoute({
  id: 'test.widgetDetail',
  method: 'GET',
  path: '/admin-api/widgets/:id',
  auth: 'admin',
  permission: 'test:widget:list',
  summary: '详情',
  tags: ['test'],
  params: z.object({ id }),
  response: z.object({ id, name: z.string(), note: z.string() }),
  examples: [{ name: 'ok', params: { id: '7' }, response: { id: '7', name: 'a', note: 'b' } }],
});

const updateRoute = defineRoute({
  id: 'test.widgetUpdate',
  method: 'PUT',
  path: '/admin-api/widgets/:id',
  auth: 'admin',
  permission: 'test:widget:create',
  summary: '编辑',
  tags: ['test'],
  params: z.object({ id }),
  body: widgetBody,
  response: z.object({ id }),
  examples: [
    { name: 'ok', params: { id: '7' }, body: { name: 'a', note: 'b' }, response: { id: '7' } },
  ],
});

const fields: FieldSpec<'name' | 'note'>[] = [
  { kind: 'text', name: 'name', label: '名称' },
  { kind: 'text', name: 'note', label: '备注' },
];

interface Row {
  id: string;
  name: string;
}

/**
 * The detail responds only when `release()` is called, so "in flight" is a
 * state the test can stand still in rather than a race it has to win.
 */
function deferredApi() {
  const urls: string[] = [];
  let release: (() => void) | undefined;
  let attempts = 0;
  let failNext = false;

  stubRoutes([
    on(detailRoute, async (call) => {
      urls.push(call.url);
      attempts += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      if (failNext) {
        return respondWithError(500, { code: 'INTERNAL', message: '服务器开小差了' });
      }
      return { id: '7', name: '已加载的名称', note: '已加载的备注' };
    }),
  ]);

  return {
    urls,
    get attempts() {
      return attempts;
    },
    fail(value: boolean) {
      failNext = value;
    },
    release() {
      release?.();
      release = undefined;
    },
  };
}

function Harness({ row }: { row?: Row }) {
  const modal = useFormModal<Row, typeof detailRoute>({
    detail: { route: detailRoute, params: (record) => ({ id: record.id }) },
  });
  return (
    <>
      <button type="button" onClick={() => modal.show(row)}>
        打开
      </button>
      <ModalForm
        {...modal.props}
        title="编辑组件"
        schema={widgetBody}
        fields={fields}
        route={updateRoute}
        toInput={(values) => ({ params: { id: row?.id ?? '0' }, body: values })}
      />
    </>
  );
}

afterEach(() => {
  resetApiConfig();
});

describe('<ModalForm> load', () => {
  it('shows a skeleton while the detail is in flight and no field before it lands', async () => {
    const api = deferredApi();
    const user = userEvent.setup();
    renderAdmin(<Harness row={{ id: '7', name: '列表里的名称' }} />);

    await user.click(screen.getByRole('button', { name: zhName('打开') }));

    const dialog = await screen.findByRole('dialog');
    await waitFor(() => {
      expect(api.urls.some((url) => url.includes('/admin-api/widgets/7'))).toBe(true);
    });

    // Nothing editable, and nothing to submit: this is the whole point.
    expect(screen.queryByLabelText('名称')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: zhName('保存') })).not.toBeInTheDocument();
    expect(dialog.querySelector('.ant-skeleton')).not.toBeNull();

    api.release();

    // And then the fields arrive already filled — from the detail, not the row.
    expect(await screen.findByDisplayValue('已加载的名称')).toBeInTheDocument();
    expect(screen.getByDisplayValue('已加载的备注')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: zhName('保存') })).toBeInTheDocument();
  });

  it('offers the reason and a retry when the detail fails, then renders the form', async () => {
    const api = deferredApi();
    api.fail(true);
    const user = userEvent.setup();
    renderAdmin(<Harness row={{ id: '7', name: '列表里的名称' }} />);

    await user.click(screen.getByRole('button', { name: zhName('打开') }));
    await waitFor(() => expect(api.attempts).toBe(1));
    api.release();

    expect(await screen.findByText('服务器开小差了')).toBeInTheDocument();
    // Still nothing to save: a retry is the only way forward.
    expect(screen.queryByRole('button', { name: zhName('保存') })).not.toBeInTheDocument();

    api.fail(false);
    await user.click(screen.getByRole('button', { name: zhName('重试') }));
    await waitFor(() => expect(api.attempts).toBe(2));
    api.release();

    expect(await screen.findByDisplayValue('已加载的名称')).toBeInTheDocument();
  });

  it('asks for nothing and opens immediately when there is no record', async () => {
    const api = deferredApi();
    const user = userEvent.setup();
    renderAdmin(<Harness />);

    await user.click(screen.getByRole('button', { name: zhName('打开') }));

    await screen.findByRole('dialog');
    expect(await screen.findByLabelText('名称')).toBeInTheDocument();
    expect(api.urls).toEqual([]);
  });
});

describe('<ModalForm> save', () => {
  it('keeps the dialog open and shows a server 422 under the field it names', async () => {
    stubRoutes([
      on(detailRoute, { id: '7', name: '已加载的名称', note: '已加载的备注' }),
      on(updateRoute, () =>
        respondWithError(422, {
          code: 'VALIDATION_FAILED',
          message: '提交的数据有误',
          details: [{ field: 'name', message: '该名称已被占用' }],
        }),
      ),
    ]);
    const user = userEvent.setup();
    renderAdmin(<Harness row={{ id: '7', name: '列表里的名称' }} />);

    await user.click(screen.getByRole('button', { name: zhName('打开') }));
    await screen.findByDisplayValue('已加载的名称');
    await user.click(screen.getByRole('button', { name: zhName('保存') }));

    const item = screen.getByLabelText('名称').closest('.ant-form-item');
    await waitFor(() => expect(item).toHaveTextContent('该名称已被占用'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('dialog').querySelector('.ant-alert')).toBeNull();
  });
});

describe('<ModalForm> never edits a cached record', () => {
  it('reopened after a save, shows the saved record, not the detail cached before it', async () => {
    let stored = { id: '7', name: '旧名称', note: '备注' };
    const calls = stubRoutes([
      on(detailRoute, () => stored),
      on(updateRoute, (call) => {
        stored = { id: '7', ...(call.body as { name: string; note: string }) };
        return { id: '7' };
      }),
    ]);
    // The admin's own cache settings: a detail stays fresh for 30 s, which is
    // what let a reopened form mount on the record from before the save.
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 30_000, gcTime: 300_000 } },
    });
    const user = userEvent.setup();
    renderAdmin(<Harness row={{ id: '7', name: '列表里的名称' }} />, { queryClient });

    await user.click(screen.getByRole('button', { name: zhName('打开') }));
    const name = await screen.findByDisplayValue('旧名称');
    await user.clear(name);
    await user.type(name, '新名称');
    await user.click(screen.getByRole('button', { name: zhName('保存') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: zhName('打开') }));
    expect(await screen.findByDisplayValue('新名称')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('旧名称')).not.toBeInTheDocument();
    expect(calls.filter((call) => call.routeId === detailRoute.id).length).toBeGreaterThanOrEqual(
      2,
    );
  });

  it('reopened without a save, still reads the record again before showing the fields', async () => {
    let name = '第一次';
    const calls = stubRoutes([on(detailRoute, () => ({ id: '7', name, note: '' }))]);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 30_000, gcTime: 300_000 } },
    });
    const user = userEvent.setup();
    renderAdmin(<Harness row={{ id: '7', name: '列表里的名称' }} />, { queryClient });

    await user.click(screen.getByRole('button', { name: zhName('打开') }));
    await screen.findByDisplayValue('第一次');
    await user.click(screen.getByRole('button', { name: zhName('取消') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    // Changed elsewhere — a 停用 toggle on the list, another tab.
    name = '列表上改过';
    await user.click(screen.getByRole('button', { name: zhName('打开') }));
    expect(await screen.findByDisplayValue('列表上改过')).toBeInTheDocument();
    expect(calls.filter((call) => call.routeId === detailRoute.id)).toHaveLength(2);
  });
});

interface WidgetRow {
  id: string;
  name: string;
  note: string | null;
}

/** Filled from the row itself, no `detail`: the 备注 / 分类 dialogs. */
function RowHarness({ rows }: { rows: WidgetRow[] }) {
  const modal = useFormModal<WidgetRow>();
  return (
    <>
      {rows.map((row) => (
        <button key={row.id} type="button" onClick={() => modal.show(row)}>
          {`打开${row.id}`}
        </button>
      ))}
      <ModalForm
        {...modal.props}
        title="编辑组件"
        schema={widgetBody}
        fields={fields}
        initialValues={
          modal.record
            ? {
                name: modal.record.name,
                ...(modal.record.note === null ? {} : { note: modal.record.note }),
              }
            : undefined
        }
        route={updateRoute}
        toInput={(values) => ({ params: { id: modal.record?.id ?? '0' }, body: values })}
      />
    </>
  );
}

describe('<ModalForm> filled from the row', () => {
  it('opened on another row, shows that row, not the one opened before', async () => {
    stubRoutes([]);
    const user = userEvent.setup();
    renderAdmin(
      <RowHarness
        rows={[
          { id: '1', name: '第一行', note: '第一行的备注' },
          { id: '2', name: '第二行', note: null },
        ]}
      />,
    );

    await user.click(screen.getByRole('button', { name: '打开1' }));
    expect(await screen.findByDisplayValue('第一行')).toBeInTheDocument();
    expect(screen.getByDisplayValue('第一行的备注')).toBeInTheDocument();
    // Closed, but not torn down: the dialog animates out, and jsdom never
    // finishes the animation, so the next opening comes straight after.
    await user.click(screen.getByRole('button', { name: zhName('取消') }));

    await user.click(screen.getByRole('button', { name: '打开2' }));
    expect(await screen.findByDisplayValue('第二行')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('第一行')).not.toBeInTheDocument();
    // A field the second row leaves empty must not keep the first row's value.
    expect(screen.queryByDisplayValue('第一行的备注')).not.toBeInTheDocument();
  });
});

describe('<ModalForm> closing', () => {
  async function openTyped(user: ReturnType<typeof userEvent.setup>) {
    stubRoutes([on(detailRoute, { id: '7', name: '已加载的名称', note: '' })]);
    renderAdmin(<Harness row={{ id: '7', name: '列表里的名称' }} />);
    await user.click(screen.getByRole('button', { name: zhName('打开') }));
    const name = await screen.findByDisplayValue('已加载的名称');
    await user.type(name, '改');
    return name;
  }

  async function discardPrompt() {
    const prompt = await waitFor(() => {
      // The last one: a prompt already answered may still be animating out.
      const found = [...document.querySelectorAll('.ant-modal-confirm')].at(-1);
      if (!(found instanceof HTMLElement)) throw new Error('no prompt yet');
      return found;
    });
    expect(prompt).toHaveTextContent('放弃未保存的修改？');
    return prompt;
  }

  it('asks before 取消 throws away what was typed, and 继续编辑 keeps it', async () => {
    const user = userEvent.setup();
    await openTyped(user);

    await user.click(screen.getByRole('button', { name: zhName('取消') }));
    await user.click(within(await discardPrompt()).getByRole('button', { name: '继续编辑' }));

    expect(screen.getByDisplayValue('已加载的名称改')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: zhName('取消') }));
    await user.click(within(await discardPrompt()).getByRole('button', { name: '放弃修改' }));
    await waitFor(() => expect(screen.queryByLabelText('名称')).not.toBeInTheDocument());
  });

  it('asks on Esc too', async () => {
    const user = userEvent.setup();
    await openTyped(user);

    await user.keyboard('{Escape}');

    expect(await discardPrompt()).toBeInTheDocument();
    expect(screen.getByDisplayValue('已加载的名称改')).toBeInTheDocument();
  });
});

describe('<ModalForm> Enter', () => {
  // A browser submits a form on Enter in a one-line field through its submit
  // button, wherever the button sits; user-event only looks inside the
  // `<form>`, so the wiring is what is checked here and the key itself in e2e.
  it('makes 保存 the submit button of the form, from the footer', async () => {
    stubRoutes([on(detailRoute, { id: '7', name: '已加载的名称', note: '' })]);
    const user = userEvent.setup();
    renderAdmin(<Harness row={{ id: '7', name: '列表里的名称' }} />);
    await user.click(screen.getByRole('button', { name: zhName('打开') }));
    await screen.findByDisplayValue('已加载的名称');

    const form = screen.getByRole('dialog').querySelector('form');
    const save = screen.getByRole('button', { name: zhName('保存') });
    expect(form?.id).toBeTruthy();
    expect(save).toHaveAttribute('type', 'submit');
    expect(save).toHaveAttribute('form', form?.id);
  });

  it('sends one save for two quick submits', async () => {
    const calls = stubRoutes([
      on(detailRoute, { id: '7', name: '已加载的名称', note: '' }),
      on(updateRoute, { id: '7' }),
    ]);
    const user = userEvent.setup();
    renderAdmin(<Harness row={{ id: '7', name: '列表里的名称' }} />);
    await user.click(screen.getByRole('button', { name: zhName('打开') }));
    await screen.findByDisplayValue('已加载的名称');

    const form = screen.getByRole('dialog').querySelector('form');
    if (!form) throw new Error('no form');
    fireEvent.submit(form);
    fireEvent.submit(form);

    await waitFor(() => expect(screen.queryByLabelText('名称')).not.toBeInTheDocument());
    expect(calls.filter((call) => call.routeId === updateRoute.id)).toHaveLength(1);
  });
});
