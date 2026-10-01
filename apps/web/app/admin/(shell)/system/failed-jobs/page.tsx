import type { Metadata } from 'next';

import { FailedJobsPage } from './failed-jobs';

export const metadata: Metadata = { title: '失败的后台任务' };

export default function Page() {
  return <FailedJobsPage />;
}
