import type {
  NotificationChannel,
  NotificationChannelToggleBody,
  NotificationLog,
  NotificationLogChannel,
  NotificationLogListQuery,
  NotificationLogRetryResult,
  NotificationTemplate,
  NotificationTemplateForm,
  NotificationTemplateListQuery,
} from '@shop/contracts/notification/schemas';
import { requirePermission } from '../auth/rbac';
import {
  findEffectById,
  listEffects,
  retryEffect,
  retryMessage,
  type EffectDetailRow,
} from '../effects';
import type { Ctx } from '../kernel/context';
import { DomainError } from '../kernel/errors';
import { toId } from '../kernel/ids';
import { notificationPermissions } from './permissions';
import { CHANNEL_LABELS, channelProblems, describeRefusal } from './notification.channels';
import * as repo from './notification.repo';
import type { NotificationChannels } from './notification.repo';
import {
  allNotificationEvents,
  findNotificationEvent,
  type NotificationEvent,
} from './notification.registry';
import { explainFailure, explainSkip, failedChannelsInWords } from './notification.send';
import {
  defaultChannels,
  effectiveChannels,
  NOTIFICATION_SCOPE,
  parseFailureMessage,
  readClaimedChannels,
  type FanOutOutcome,
} from './notification.service';

/**
 * The operator's three screens.
 *
 * The template list is **driven by the registry, not by the table**: the rows
 * are what the code can send, and the table only remembers what an operator
 * chose. That is why the list seeds missing rows as it reads and why a row
 * whose code has left the registry simply stops appearing instead of hanging
 * around as an event nobody can trigger.
 */

interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export async function listTemplates(
  ctx: Ctx,
  query: NotificationTemplateListQuery,
): Promise<Paged<NotificationTemplate>> {
  requirePermission(ctx, notificationPermissions['template:read']);

  const keyword = query.keyword?.trim() ?? '';
  const events = allNotificationEvents().filter((event) => {
    if (query.audience !== undefined && event.audience !== query.audience) return false;
    if (keyword === '') return true;
    return event.name.includes(keyword) || event.code.includes(keyword);
  });

  await seedMissing(ctx, events);
  const rows = await repo.listTemplates(
    ctx.db,
    events.map((event) => event.code),
  );
  const byCode = new Map(rows.map((row) => [row.code, row]));

  const offset = (query.page - 1) * query.pageSize;
  const page = events.slice(offset, offset + query.pageSize);

  return {
    items: page.map((event) => toTemplate(event, byCode.get(event.code))),
    total: events.length,
    page: query.page,
    pageSize: query.pageSize,
  };
}

export async function getTemplate(
  ctx: Ctx,
  input: { code: string },
): Promise<NotificationTemplate> {
  requirePermission(ctx, notificationPermissions['template:read']);
  const event = requireEvent(input.code);
  await seedMissing(ctx, [event]);
  return toTemplate(event, await repo.findTemplate(ctx.db, event.code));
}

export async function saveTemplate(
  ctx: Ctx,
  params: { code: string },
  body: NotificationTemplateForm,
): Promise<NotificationTemplate> {
  requirePermission(ctx, notificationPermissions['template:write']);
  const event = requireEvent(params.code);
  await seedMissing(ctx, [event]);

  const channels = validateChannels(event, body.channels as NotificationChannels);
  await repo.saveTemplate(ctx.db, event.code, {
    channels,
    isEnabled: body.isEnabled,
    now: ctx.clock.now(),
  });
  return toTemplate(event, await repo.findTemplate(ctx.db, event.code));
}

export async function toggleChannel(
  ctx: Ctx,
  params: { code: string; channel: NotificationChannel },
  body: NotificationChannelToggleBody,
): Promise<NotificationTemplate> {
  requirePermission(ctx, notificationPermissions['template:write']);
  const event = requireEvent(params.code);
  await seedMissing(ctx, [event]);

  if (body.enabled && !event.channels.includes(params.channel)) {
    throw new DomainError('NOTIFICATION_CHANNEL_NOT_APPLICABLE', {
      message: `「${CHANNEL_LABELS[params.channel]}」：该通知不支持此渠道`,
    });
  }

  const row = await repo.findTemplate(ctx.db, event.code);
  const current = effectiveChannels(event, row?.channels);
  const existing = current[params.channel];
  // Off, and not on the row: there is nothing to turn off.
  if (existing === undefined) return toTemplate(event, row);

  // Only the switch being flipped is checked: turning one channel off is how
  // an operator gets out of a broken row, and it must not be refused because
  // another channel of the same row is broken too.
  const channels = validateChannels(
    event,
    {
      ...current,
      [params.channel]: { ...existing, enabled: body.enabled },
    } as NotificationChannels,
    params.channel,
  );

  await repo.saveTemplate(ctx.db, event.code, {
    channels,
    isEnabled: row?.isEnabled ?? true,
    now: ctx.clock.now(),
  });
  return toTemplate(event, await repo.findTemplate(ctx.db, event.code));
}

// ---------------------------------------------------------------------------
// the send log
// ---------------------------------------------------------------------------

/**
 * The send log reads the shared effects ledger, pinned to the notification
 * scope: one domain's console must not become everybody's, and a notification
 * operator has no business seeing a parked refund.
 */
const LOG_SCOPES = [NOTIFICATION_SCOPE] as const;

export async function listLogs(
  ctx: Ctx,
  query: NotificationLogListQuery,
): Promise<Paged<NotificationLog>> {
  requirePermission(ctx, notificationPermissions['log:read']);
  const { rows, total } = await listEffects(ctx.db, {
    scopes: LOG_SCOPES,
    status: query.status,
    // The scope id is `<code>:<subject scope>:<subject id>`, so the prefix
    // `code:` is exact for the code and cannot match a different event whose
    // name merely starts the same way.
    ...(query.code === undefined ? {} : { scopeIdPrefix: `${query.code}:` }),
    page: query.page,
    pageSize: query.pageSize,
    withPayload: true,
  });
  return {
    items: await Promise.all(rows.map((row) => toLog(ctx, row))),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

/**
 * 重试: hands a parked send back to the dispatcher. Only a row whose outcome is
 * `unknown` moves, so a delivered notification is never sent a second time;
 * the channels that already went out are skipped by their claims when the
 * handler runs again.
 */
export async function retryLog(
  ctx: Ctx,
  input: { id: string },
): Promise<NotificationLogRetryResult> {
  requirePermission(ctx, notificationPermissions['log:handle']);
  const id = Number(input.id);
  const row = await findEffectById(ctx.db, id, LOG_SCOPES);
  if (!row) throw new DomainError('NOT_FOUND');

  const { won } = await retryEffect(ctx.db, id, ctx.clock.now(), LOG_SCOPES);
  const fresh = (await findEffectById(ctx.db, id, LOG_SCOPES)) ?? row;
  return {
    log: await toLog(ctx, fresh),
    succeeded: won,
    message: retryMessage(won, fresh.status, '该发送记录'),
  };
}

// ---------------------------------------------------------------------------
// mapping
// ---------------------------------------------------------------------------

function requireEvent(code: string): NotificationEvent {
  const event = findNotificationEvent(code);
  if (!event) throw new DomainError('NOTIFICATION_TEMPLATE_NOT_FOUND');
  return event;
}

async function seedMissing(ctx: Ctx, events: readonly NotificationEvent[]): Promise<void> {
  if (events.length === 0) return;
  const existing = new Set(
    (
      await repo.listTemplates(
        ctx.db,
        events.map((event) => event.code),
      )
    ).map((row) => row.code),
  );
  const missing = events.filter((event) => !existing.has(event.code));
  if (missing.length === 0) return;
  await ctx.withTx((tx) =>
    repo.upsertTemplates(
      tx,
      missing.map((event) => ({
        code: event.code,
        name: event.name,
        description: event.description,
        audience: event.audience,
        channels: defaultChannels(event),
        variables: [...event.variables],
      })),
    ),
  );
}

/**
 * Refuses a channel that is switched on with nothing to send, naming every such
 * channel in one go, and drops the switched-off channels the event cannot use.
 *
 * The check happens here rather than at send time on purpose: at send time the
 * only thing that can be done about it is a log line nobody reads, whereas the
 * operator is looking at the form right now.
 *
 * `only` narrows the check to one channel (the per-channel switch); the others
 * are kept as stored.
 */
function validateChannels(
  event: NotificationEvent,
  channels: NotificationChannels,
  only?: NotificationChannel,
): NotificationChannels {
  const problems = channelProblems(event, channels).filter(
    (problem) => only === undefined || problem.channel === only,
  );
  const notApplicable = problems.filter((problem) => problem.kind === 'notApplicable');
  if (notApplicable.length > 0) {
    throw new DomainError('NOTIFICATION_CHANNEL_NOT_APPLICABLE', {
      message: describeRefusal(notApplicable),
      details: { problems: notApplicable },
    });
  }
  if (problems.length > 0) {
    throw new DomainError('NOTIFICATION_CHANNEL_INCOMPLETE', {
      message: describeRefusal(problems),
      details: { problems },
    });
  }

  const out: NotificationChannels = {};
  for (const [name, config] of Object.entries(channels) as [
    NotificationChannel,
    NotificationChannels[NotificationChannel],
  ][]) {
    if (config === undefined) continue;
    if (!event.channels.includes(name) && !config.enabled) continue;
    Object.assign(out, { [name]: config });
  }
  return out;
}

function toTemplate(
  event: NotificationEvent,
  row: { channels: NotificationChannels; isEnabled: boolean; updatedAt: Date } | undefined,
): NotificationTemplate {
  const channels = effectiveChannels(event, row?.channels);
  return {
    code: event.code,
    name: event.name,
    description: event.description,
    audience: event.audience,
    channels: channels as NotificationTemplate['channels'],
    variables: [...event.variables],
    supportedChannels: [...event.channels],
    channelProblems: channelProblems(event, channels),
    isEnabled: row?.isEnabled ?? true,
    updatedAt: (row?.updatedAt ?? new Date(0)).toISOString(),
  };
}

/** `<code>:<subject scope>:<subject id>` back into its parts. */
export function splitScopeId(scopeId: string): { code: string; subject: string } {
  const first = scopeId.indexOf(':');
  if (first < 0) return { code: scopeId, subject: '' };
  return { code: scopeId.slice(0, first), subject: scopeId.slice(first + 1) };
}

async function toLog(ctx: Ctx, row: EffectDetailRow): Promise<NotificationLog> {
  const { code, subject } = splitScopeId(row.scopeId);
  const event = findNotificationEvent(code);

  return {
    id: toId(row.id),
    code,
    name: event?.name ?? code,
    audience: event?.audience ?? 'user',
    subject,
    status: row.status === 'done' ? 'done' : row.status === 'unknown' ? 'unknown' : 'pending',
    attempts: row.attempts,
    channels: event ? await logChannels(ctx, row, event) : [],
    lastError: row.lastError,
    // A row from before `last_error_summary` reads from its raw text.
    lastErrorSummary: row.lastErrorSummary ?? readableError(row.lastError),
    nextRunAt: row.nextRunAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * What the row's last attempt did with each channel the event supports.
 *
 * The fan-out writes its outcome on the effect, and that is the answer. A row
 * without one was written before fan-outs recorded it, and the only other
 * witness is the channel's Redis claim: a claim means it went out, but no claim
 * means skipped, failed **or** sent more than seven days ago, so those read
 * 未知 rather than 已发送 or 失败.
 */
async function logChannels(
  ctx: Ctx,
  row: EffectDetailRow,
  event: NotificationEvent,
): Promise<NotificationLogChannel[]> {
  const outcome = readOutcome(row.outcome);
  if (outcome) return channelsFromOutcome(event.channels, outcome);
  // Never attempted. A parked row an operator re-queued also has 0 attempts,
  // but keeps its last error.
  if (row.status === 'pending' && row.attempts === 0 && row.lastError === null) return [];

  // Admin in-app claims are taken per admin id, which the row does not keep.
  const payload = row.payload as { userId?: number } | null;
  const claimed =
    event.audience === 'user'
      ? await readClaimedChannels(ctx, row.scopeId, [payload?.userId ?? null], event.channels)
      : [];
  return event.channels.map((channel) =>
    claimed.includes(channel)
      ? { channel, outcome: 'sent', note: null }
      : { channel, outcome: 'unknown', note: UNKNOWN_NOTE },
  );
}

const UNKNOWN_NOTE = '这条记录较早，没有逐渠道的发送结果，无法确认是否送达';

export function channelsFromOutcome(
  supported: readonly NotificationChannel[],
  outcome: FanOutOutcome,
): NotificationLogChannel[] {
  return supported.map((channel): NotificationLogChannel => {
    if (outcome.sent.includes(channel)) return { channel, outcome: 'sent', note: null };
    const failed = outcome.failed.find((entry) => entry.channel === channel);
    if (failed) {
      return { channel, outcome: 'failed', note: `发送失败：${explainFailure(failed.reason)}` };
    }
    const skipped = outcome.skipped.find((entry) => entry.channel === channel);
    if (skipped) {
      return { channel, outcome: 'skipped', note: explainSkip(skipped.reason) };
    }
    // A channel the event gained after this row was sent.
    return { channel, outcome: 'unknown', note: '发送时还没有这个渠道' };
  });
}

/**
 * 最后错误, in Chinese. The ledger keeps the raw text (`last_error`), which is
 * either the fan-out's own {@link parseFailureMessage} format — rows from
 * before this read the same way — or something that went wrong outside any
 * channel: the handler missing from a deploy, the database, a bug.
 */
export function readableError(lastError: string | null): string | null {
  if (lastError === null) return null;
  const failed = parseFailureMessage(lastError);
  if (failed) return failedChannelsInWords(failed);
  if (lastError.startsWith('no handler for ')) return '发送程序没有部署，请联系技术人员';
  return '发送程序出错，请联系技术人员查看服务日志';
}

/** The stored outcome, or `null` for a row without one (or one this code cannot read). */
function readOutcome(value: unknown): FanOutOutcome | null {
  if (typeof value !== 'object' || value === null) return null;
  const { sent, skipped, failed } = value as Partial<FanOutOutcome>;
  if (!Array.isArray(sent) || !Array.isArray(skipped) || !Array.isArray(failed)) return null;
  return { sent, skipped, failed };
}
