import type { Data } from '@puckeditor/core';
import {
  decorDocumentGet,
  decorDraftSave,
  decorPublish,
} from '@shop/contracts/decor/decor.admin.contract';
import type { ResponseOf } from '@shop/contracts/_conventions/route';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { resetApiConfig } from '@/admin/api/config';
import { on, respondWithError, stubRoutes, type StubCall } from '@/test/api';
import { renderAdmin, testIdentity, zhName } from '@/test/render';

import { DecorPageEditor } from './page-editor';

/**
 * The editor page's session logic — save, conflict, publish, the unsaved
 * guard — with the canvas replaced by a stand-in: Puck itself is exercised by
 * the e2e spec, and what matters here is what the page sends and when.
 */

vi.mock('./editor', () => ({
  DecorEditor: ({
    data,
    onChange,
    toolbar,
    banner,
    readOnly,
  }: {
    data: Data;
    onChange?: (data: Data) => void;
    toolbar: ReactNode;
    banner?: ReactNode;
    readOnly?: boolean;
  }) => (
    <div>
      <div>{toolbar}</div>
      <div>{banner}</div>
      <div data-testid="canvas-title">{String(data.root.props?.title)}</div>
      {readOnly ? <div>只读画布</div> : null}
      <button
        type="button"
        onClick={() =>
          onChange?.({ ...data, root: { props: { ...data.root.props, title: '改过的标题' } } })
        }
      >
        模拟编辑
      </button>
    </div>
  ),
  useDecorSelect: () => () => undefined,
}));

type Detail = ResponseOf<typeof decorDocumentGet>;

function detail(overrides: Partial<Detail> = {}): Detail {
  return {
    id: '7',
    kind: 'home',
    name: '春季首页',
    title: '春季首页',
    designation: null,
    draftVersion: '3',
    published: null,
    hasUnpublishedChanges: true,
    createdAt: '2026-09-01T10:00:00+08:00',
    updatedAt: '2026-09-01T10:00:00+08:00',
    draft: { schemaVersion: 2, root: { props: { title: '春季首页' } }, blocks: [] },
    issues: [],
    warnings: [],
    ...overrides,
  };
}

function summary(full: Detail) {
  const { draft: _draft, issues: _issues, warnings: _warnings, ...rest } = full;
  return rest;
}

const saved = (version: string): ResponseOf<typeof decorDraftSave> => ({
  version,
  issues: [],
  warnings: [],
  updatedAt: '2026-09-01T10:05:00+08:00',
});

const editor = {
  ...testIdentity,
  permissions: ['decor:page:read', 'decor:page:write', 'decor:page:publish'],
};

afterEach(() => {
  resetApiConfig();
});

function render(identity = editor) {
  renderAdmin(<DecorPageEditor id="7" previewUrl={null} />, { identity });
}

const saves = (calls: StubCall[]) =>
  calls.filter((call) => call.method === 'PUT' && call.path.endsWith('/draft'));

async function edit() {
  await userEvent.click(await screen.findByRole('button', { name: '模拟编辑' }));
  expect(await screen.findByText('未保存')).toBeInTheDocument();
}

describe('装修页面编辑器', () => {
  it('saves only when asked, with the draft token it loaded', async () => {
    const calls = stubRoutes([on(decorDocumentGet, detail()), on(decorDraftSave, saved('4'))]);
    render();

    const save = await screen.findByRole('button', { name: zhName('保存草稿') });
    expect(save).toBeDisabled();
    await edit();
    expect(saves(calls)).toHaveLength(0);

    await userEvent.click(save);
    await waitFor(() => expect(saves(calls)).toHaveLength(1));
    expect(saves(calls)[0]?.body).toMatchObject({
      version: '3',
      document: { schemaVersion: 2, root: { props: { title: '改过的标题' } }, blocks: [] },
    });
    await waitFor(() => expect(screen.queryByText('未保存')).not.toBeInTheDocument());
    // Our own save is not someone else's.
    expect(screen.queryByText('草稿已在别处被修改')).not.toBeInTheDocument();
  });

  it('on a conflict, overwrites knowingly with the current token', async () => {
    let attempt = 0;
    const calls = stubRoutes([
      on(decorDocumentGet, detail()),
      on(decorDraftSave, () => {
        attempt += 1;
        return attempt === 1
          ? respondWithError(409, {
              code: 'DECOR_VERSION_CONFLICT',
              message: '页面已被其他人修改，请刷新后重新保存',
              details: { version: '9' },
            })
          : saved('10');
      }),
    ]);
    render();
    await edit();
    await userEvent.click(screen.getByRole('button', { name: zhName('保存草稿') }));

    const dialog = await screen.findByRole('dialog', { name: '草稿已被其他人修改' });
    await userEvent.click(within(dialog).getByRole('button', { name: '用我的覆盖' }));

    await waitFor(() => expect(saves(calls)).toHaveLength(2));
    expect(saves(calls).map((call) => (call.body as { version: string }).version)).toEqual([
      '3',
      '9',
    ]);
  });

  it('on a conflict, can load the other version instead, dropping the edit', async () => {
    let loads = 0;
    stubRoutes([
      on(decorDocumentGet, () => {
        loads += 1;
        return loads === 1
          ? detail()
          : detail({
              draftVersion: '9',
              draft: { schemaVersion: 2, root: { props: { title: '同事的标题' } }, blocks: [] },
            });
      }),
      on(decorDraftSave, () =>
        respondWithError(409, {
          code: 'DECOR_VERSION_CONFLICT',
          message: '页面已被其他人修改，请刷新后重新保存',
          details: { version: '9' },
        }),
      ),
    ]);
    render();
    await edit();
    await userEvent.click(screen.getByRole('button', { name: zhName('保存草稿') }));
    const dialog = await screen.findByRole('dialog', { name: '草稿已被其他人修改' });
    await userEvent.click(within(dialog).getByRole('button', { name: '载入对方的版本' }));

    await waitFor(() => expect(screen.getByTestId('canvas-title')).toHaveTextContent('同事的标题'));
    expect(screen.queryByText('未保存')).not.toBeInTheDocument();
  });

  it('publishes with a note, saving the edit first and publishing that token', async () => {
    const calls = stubRoutes([
      on(decorDocumentGet, detail()),
      on(decorDraftSave, saved('4')),
      on(decorPublish, {
        document: summary(detail({ hasUnpublishedChanges: false })),
        revision: {
          id: '31',
          number: 1,
          note: '换上春季主图',
          authorAdminId: '1',
          restoredFrom: null,
          createdAt: '2026-09-01T10:06:00+08:00',
        },
        warnings: [],
      }),
    ]);
    render();
    await edit();
    await userEvent.click(screen.getByRole('button', { name: /^发\s*布$/ }));
    const dialog = await screen.findByRole('dialog', { name: '发布页面' });
    await userEvent.type(within(dialog).getByLabelText('发布说明'), '换上春季主图');
    await userEvent.click(within(dialog).getByRole('button', { name: zhName('保存并发布') }));

    await waitFor(() => expect(calls.some((call) => call.path.endsWith('/publish'))).toBe(true));
    const order = calls
      .filter((call) => call.method !== 'GET')
      .map((call) => call.path.split('/').pop());
    expect(order).toEqual(['draft', 'publish']);
    expect(calls.find((call) => call.path.endsWith('/publish'))?.body).toEqual({
      version: '4',
      note: '换上春季主图',
    });
  });

  it('lists what blocks publishing, from the server, under the toolbar', async () => {
    stubRoutes([
      on(
        decorDocumentGet,
        detail({
          hasUnpublishedChanges: true,
          draft: {
            schemaVersion: 2,
            root: { props: { title: '春季首页' } },
            blocks: [{ id: 'hero', type: 'carousel', v: 1, props: { slides: [] } }],
          },
        }),
      ),
      on(decorPublish, () =>
        respondWithError(422, {
          code: 'DECOR_DOCUMENT_INVALID',
          message: '页面内容有误，请按提示修改',
          details: { issues: [{ path: 'blocks.0.props.slides', message: '至少添加一张图片' }] },
        }),
      ),
    ]);
    render();
    await userEvent.click(await screen.findByRole('button', { name: /^发\s*布$/ }));
    const dialog = await screen.findByRole('dialog', { name: '发布页面' });
    await userEvent.click(within(dialog).getByRole('button', { name: /^发\s*布$/ }));

    const issues = await screen.findByTestId('decor-issues');
    expect(issues).toHaveTextContent('第 1 个组件「轮播」');
    expect(issues).toHaveTextContent('至少添加一张图片');
    expect(within(issues).getByRole('button', { name: '定位' })).toBeInTheDocument();
  });

  it('guards unsaved changes: the browser prompt and the back button', async () => {
    stubRoutes([on(decorDocumentGet, detail())]);
    render();
    await screen.findByRole('button', { name: '模拟编辑' });

    const clean = new Event('beforeunload', { cancelable: true });
    act(() => void window.dispatchEvent(clean));
    expect(clean.defaultPrevented).toBe(false);

    await edit();
    const dirty = new Event('beforeunload', { cancelable: true });
    act(() => void window.dispatchEvent(dirty));
    expect(dirty.defaultPrevented).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: '返回列表' }));
    expect((await screen.findAllByText('有未保存的修改')).length).toBeGreaterThan(0);
  });

  it('is read-only for an admin who may only look', async () => {
    stubRoutes([on(decorDocumentGet, detail())]);
    render({ ...testIdentity, permissions: ['decor:page:read'] });

    expect(await screen.findByText('只读画布')).toBeInTheDocument();
    expect(screen.getByText('你没有编辑权限，当前为只读查看。')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: zhName('保存草稿') })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^发\s*布$/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: zhName('发布记录') })).toBeInTheDocument();
  });
});
