import { defineRoute } from '../_conventions/route';
import {
  failedJobItemExample,
  failedJobListQuery,
  failedJobParams,
  failedJobResolveResult,
  pagedFailedJobs,
} from './schemas';

/**
 * 失败的后台任务 — the worker's dead-letter box, on screen.
 *
 * A scheduled sweep (auto-cancel, auto-receive, coupon expiry…) that fails all
 * its retries lands in `failed_jobs`. Nothing re-runs it from here: the sweeps
 * run again on their own schedule, so the job is to read what went wrong, fix
 * the cause, and mark the row 已处理 so the 「异常待处理」 figure on the home
 * page means something.
 */

export const systemFailedJobList = defineRoute({
  id: 'system.failedJobList',
  method: 'GET',
  path: '/admin-api/failed-jobs',
  auth: 'admin',
  permission: 'system:job:handle',
  summary: '失败的后台任务',
  tags: ['system'],
  query: failedJobListQuery,
  response: pagedFailedJobs,
  examples: [
    {
      name: 'open',
      query: { page: 1, pageSize: 20, status: 'open' },
      response: { items: [failedJobItemExample], total: 1, page: 1, pageSize: 20 },
    },
  ],
});

export const systemFailedJobResolve = defineRoute({
  id: 'system.failedJobResolve',
  method: 'POST',
  path: '/admin-api/failed-jobs/:id/resolve',
  auth: 'admin',
  permission: 'system:job:handle',
  summary: '标记后台任务失败已处理',
  tags: ['system'],
  params: failedJobParams,
  response: failedJobResolveResult,
  errors: ['SYSTEM_FAILED_JOB_NOT_FOUND'],
  examples: [
    { name: 'resolved', params: { id: '12' }, response: { resolved: true } },
    { name: 'already-resolved', params: { id: '12' }, response: { resolved: false } },
  ],
});
