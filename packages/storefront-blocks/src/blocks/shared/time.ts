/**
 * Dates and countdowns for the marketing blocks. Shown in Beijing time
 * (UTC+8, no daylight saving) whatever the device's zone, and computed from
 * the instant the host gives (`BlockHost.serverNow`), never `Date.now()`.
 */

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const SECOND = 1000;

const pad = (value: number) => String(value).padStart(2, '0');

function beijing(iso: string): Date | null {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : new Date(ms + BEIJING_OFFSET_MS);
}

/** `2026-05-01` */
export function formatDate(iso: string | null): string {
  const at = iso ? beijing(iso) : null;
  if (!at) return '';
  return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`;
}

/** `05.01` */
export function formatMonthDay(iso: string | null): string {
  const at = iso ? beijing(iso) : null;
  if (!at) return '';
  return `${pad(at.getUTCMonth() + 1)}.${pad(at.getUTCDate())}`;
}

/** `05月01日 20:00` */
export function formatMoment(iso: string): string {
  const at = beijing(iso);
  if (!at) return '';
  return `${pad(at.getUTCMonth() + 1)}月${pad(at.getUTCDate())}日 ${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}`;
}

/** Remaining time: `2天 03:04:05` from a day up, `03:04:05` below. Never negative. */
export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.floor(ms / SECOND));
  const days = Math.floor(total / 86_400);
  const hms = `${pad(Math.floor((total % 86_400) / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
  return days > 0 ? `${days}天 ${hms}` : hms;
}

export type CampaignPhase =
  { phase: 'upcoming'; until: number } | { phase: 'running'; until: number } | { phase: 'ended' };

/** Where a campaign's window stands at `now`, and the instant the current phase ends. */
export function campaignPhase(startAt: string, endAt: string, now: number): CampaignPhase {
  const start = Date.parse(startAt);
  const end = Date.parse(endAt);
  if (now < start) return { phase: 'upcoming', until: start };
  if (now < end) return { phase: 'running', until: end };
  return { phase: 'ended' };
}
