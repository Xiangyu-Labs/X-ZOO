'use client';

import { StatusTag, type StatusMap } from '@/admin/kit/status-tag';

type ActivityStatus = 'draft' | 'active' | 'paused' | 'ended';

/**
 * What an operator should read in the 状态 column of a 拼团 or 预售 activity.
 *
 * `status` is what the operator set; the window is when it applies. An
 * `active` activity before its start is 未开始, and one past its end is
 * 已结束 even in the minute before the sweep writes `ended` — 进行中 would
 * claim shoppers can buy when they cannot.
 */
export function shownActivityStatus(
  row: { status: ActivityStatus; startAt: string; endAt: string },
  now: number = Date.now(),
): ActivityStatus | 'upcoming' {
  if (row.status !== 'active') return row.status;
  if (now < Date.parse(row.startAt)) return 'upcoming';
  if (now >= Date.parse(row.endAt)) return 'ended';
  return 'active';
}

export function ActivityStatusTag({
  row,
  map,
}: {
  row: { status: ActivityStatus; startAt: string; endAt: string };
  map: StatusMap<ActivityStatus>;
}) {
  const shown = shownActivityStatus(row);
  const full: StatusMap<ActivityStatus | 'upcoming'> = {
    ...map,
    upcoming: { label: '未开始', color: 'processing' },
  };
  return <StatusTag value={shown} map={full} />;
}
