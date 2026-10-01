'use client';

import { DownloadOutlined } from '@ant-design/icons';
import { App, Button } from 'antd';
import { useState } from 'react';
import type { StatsExportResult } from '@shop/contracts/stats/schemas';

import { callRoute } from '@/admin/api/call-route';
import { presentApiError } from '@/admin/api/error-presenter';
import type { AnyRouteDef } from '@/admin/api/contracts';
import { Can } from '@/admin/session/can';

/**
 * 导出 CSV.
 *
 * The route answers with the CSV *text* inside a JSON envelope — `handle()`
 * validates every response against its contract, so a route cannot stream a
 * file. The download is assembled here, with a BOM, because Excel on
 * Windows reads a BOM-less UTF-8 CSV as GBK and turns every Chinese column
 * heading into mojibake.
 *
 * The two exports behave differently on purpose and the button says which
 * happened: a ranking truncates (`truncated`), a time series refuses with
 * `STATS_EXPORT_TOO_LARGE`. The call is made here rather than through a query
 * hook, so the failure is handed to the presenter here too — before, it was
 * an unhandled rejection and the button simply stopped spinning.
 */
export function StatsExportButton({
  route,
  query,
  permission,
  label = '导出 CSV',
}: {
  route: AnyRouteDef;
  query: Record<string, unknown>;
  permission: string;
  label?: string;
}) {
  const { message } = App.useApp();
  const [busy, setBusy] = useState(false);

  const download = async () => {
    setBusy(true);
    try {
      const result = (await callRoute(route, { query } as never)) as StatsExportResult;
      const blob = new Blob(['﻿', result.content], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = result.filename;
      anchor.click();
      URL.revokeObjectURL(url);
      if (result.truncated) {
        message.warning(`导出已截断到 ${result.rowCount} 行，请缩小时间范围`);
      } else {
        message.success(`已导出 ${result.rowCount} 行`);
      }
    } catch (error) {
      presentApiError(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Can permission={permission}>
      <Button icon={<DownloadOutlined />} loading={busy} onClick={download}>
        {label}
      </Button>
    </Can>
  );
}
