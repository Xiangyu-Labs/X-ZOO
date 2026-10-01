import { defineRoute } from '@shop/contracts';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { resetApiConfig } from '@/admin/api/config';
import { StatsExportButton } from '@/admin/stats/export-button';
import { on, respondWithError, stubRoutes } from '@/test/api';
import { renderAdmin, testIdentity } from '@/test/render';

import { describeApiError, setApiFeedback } from './error-presenter';
import { ApiError } from './errors';

afterEach(() => {
  resetApiConfig();
  setApiFeedback(null);
});

describe('describeApiError', () => {
  it('follows 提交的数据有误 with the reasons a 422 carries', () => {
    const error = new ApiError({
      status: 422,
      code: 'VALIDATION_FAILED',
      message: '提交的数据有误',
      details: [
        { field: 'password', message: '最多 72 个字' },
        { field: 'userIds', message: '请至少选择一项' },
      ],
    });
    expect(describeApiError(error)).toBe('提交的数据有误：最多 72 个字；请至少选择一项');
  });

  it('is the message itself for anything else', () => {
    const error = new ApiError({ status: 409, code: 'X_TAKEN', message: '名称已被占用' });
    expect(describeApiError(error)).toBe('名称已被占用');
  });
});

const exportRoute = defineRoute({
  id: 'test.statsExport',
  method: 'GET',
  path: '/admin-api/test-stats/export',
  auth: 'admin',
  permission: 'test:stats:export',
  summary: '导出',
  tags: ['test'],
  query: z.object({ from: z.string().optional() }),
  response: z.object({
    filename: z.string(),
    content: z.string(),
    rowCount: z.number(),
    truncated: z.boolean(),
  }),
  errors: ['STATS_EXPORT_TOO_LARGE'],
  examples: [
    { name: 'ok', response: { filename: 'a.csv', content: '', rowCount: 0, truncated: false } },
  ],
});

describe('<StatsExportButton>', () => {
  it('shows why an export was refused instead of silently stopping', async () => {
    const shown = vi.fn();
    setApiFeedback({ error: shown, success: () => {} });
    stubRoutes([
      on(exportRoute, () =>
        respondWithError(422, {
          code: 'STATS_EXPORT_TOO_LARGE',
          message: '时间范围太大，请缩小后再导出',
        }),
      ),
    ]);
    renderAdmin(
      <StatsExportButton route={exportRoute} query={{}} permission="test:stats:export" />,
      { identity: { ...testIdentity, permissions: ['test:stats:export'] } },
    );

    await userEvent.click(screen.getByRole('button', { name: /导出 CSV/ }));

    await waitFor(() => expect(shown).toHaveBeenCalledTimes(1));
    expect(shown.mock.calls[0]?.[0]).toMatchObject({ message: '时间范围太大，请缩小后再导出' });
  });
});
