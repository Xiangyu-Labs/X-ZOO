import type {
  ConfigFieldDescriptor,
  ConfigGroupDescriptor,
  ConfigGroupSummary,
  ConfigGroupValues,
  ConfigSaveBody,
  ConfigTestBody,
  ConfigTestResult,
} from '@shop/contracts/system/schemas';
import type { Ctx } from '../kernel/context';
import { requireAdminId } from '../kernel/context';
import {
  allConfigGroups,
  getConfigGroup,
  type ConfigFieldType,
  type ConfigFieldUi,
  type ConfigGroupDef,
  type ConfigGroupStatus,
} from '../kernel/config-registry';
import { getConfigTest } from '../kernel/config-test';
import { DomainError } from '../kernel/errors';
import { enforce, fixedWindow } from '../kernel/rate-limit';
import { hasPermission } from '../auth/rbac';
import { invalidateAppConfigCache } from './app-config.service';
import * as repo from './system.repo';
// The gen'd bucket: `defineConfigGroup` registers as a side effect of its
// module being imported, so this is what makes a group exist. `pnpm gen`
// collects every `src/<domain>/*.config.ts`, so adding a settings screen is one
// new file and no shared index to edit.
import '../config-groups.gen';

/**
 * The generic settings screen.
 *
 * A domain declares `defineConfigGroup({ group, schema, ui })` in
 * `core/src/<domain>/<group>.config.ts`, and these three functions serve every
 * group there will ever be — no hand-written page per tab, and no request
 * parameter deciding which tab is being saved.
 *
 * ## Secrets
 *
 * A field marked `secret` is **write-only**. `read` replaces its value with a
 * boolean "is set" flag, and `save` drops the key when the client sends the flag
 * back instead of a new string. There is no code path that returns a stored
 * credential to a browser, and none that logs one.
 */

/** Registry field types the browser cannot render map onto ones it can. */
const FIELD_KIND: Record<ConfigFieldType, ConfigFieldDescriptor['kind']> = {
  text: 'text',
  textarea: 'textarea',
  number: 'number',
  switch: 'switch',
  select: 'select',
  'multi-select': 'select',
  image: 'asset',
  images: 'asset',
  file: 'asset',
  password: 'password',
  json: 'json',
  color: 'color',
  richtext: 'richtext',
  url: 'url',
};

/**
 * A read-only field's help text always says where the value does come from.
 *
 * "You cannot change this here" on its own is an unanswerable screen: the
 * operator still has `http://localhost` in their WeChat links and now no idea
 * where it is written. `source` names the environment variable. A group that
 * also wrote `help` keeps it, with the source appended.
 */
function helpFor(ui: ConfigFieldUi): string | undefined {
  if (ui.readOnly !== true || ui.source === undefined) return ui.help;
  const source = `由部署环境决定：${ui.source}`;
  return ui.help === undefined ? source : `${ui.help}（${source}）`;
}

function fieldDescriptor(key: string, ui: ConfigFieldUi): ConfigFieldDescriptor {
  const secret = ui.secret === true || ui.type === 'password';
  const help = helpFor(ui);
  return {
    key,
    label: ui.label,
    kind: secret ? 'password' : FIELD_KIND[ui.type],
    ...(help === undefined ? {} : { help }),
    ...(ui.placeholder === undefined ? {} : { placeholder: ui.placeholder }),
    ...(ui.options === undefined ? {} : { options: ui.options.map((o) => ({ ...o })) }),
    ...(ui.section === undefined ? {} : { section: ui.section }),
    ...(ui.type === 'images' || ui.type === 'multi-select' ? { multiple: true } : {}),
    ...(ui.visibleWhen === undefined ? {} : { visibleWhen: { ...ui.visibleWhen } }),
    ...(secret ? { secret: true } : {}),
    ...(ui.readOnly === true ? { readOnly: true } : {}),
    ...(ui.unit === undefined ? {} : { unit: ui.unit }),
  };
}

export function describeGroup(def: ConfigGroupDef): ConfigGroupDescriptor {
  const fields: ConfigFieldDescriptor[] = [];
  // Declaration order, then `order`, so a group reads the way it was written.
  const entries = Object.keys(def.schema.shape).map((key, index) => {
    const ui = (def.ui as Record<string, ConfigFieldUi | undefined>)[key];
    return { key, ui, index };
  });
  entries.sort((a, b) => (a.ui?.order ?? a.index) - (b.ui?.order ?? b.index));
  for (const entry of entries) {
    // A key with no `ui` entry is deliberately not editable in the admin: it is
    // a value a job or the code writes, not an operator.
    if (!entry.ui) continue;
    fields.push(fieldDescriptor(entry.key, entry.ui));
  }
  const test = getConfigTest(def.group);
  return {
    group: def.group,
    title: def.title,
    ...(def.description === undefined ? {} : { description: def.description }),
    ...(def.category === undefined ? {} : { category: def.category }),
    permission: def.permission ?? 'system:config:read',
    fields,
    ...(test === undefined
      ? {}
      : {
          test: {
            label: test.label,
            ...(test.confirm === undefined ? {} : { confirm: test.confirm }),
            inputs: Object.entries(test.inputUi ?? {}).map(([key, ui]) => fieldDescriptor(key, ui)),
            optional: Object.keys(test.inputUi ?? {}).filter(
              (key) => test.input?.shape[key]?.safeParse(undefined).success === true,
            ),
          },
        }),
  };
}

/** Which keys of a group are secret. The one list both `read` and `save` use. */
function secretKeys(def: ConfigGroupDef): Set<string> {
  const out = new Set<string>();
  for (const [key, ui] of Object.entries(def.ui as Record<string, ConfigFieldUi | undefined>)) {
    if (ui && (ui.secret === true || ui.type === 'password')) out.add(key);
  }
  return out;
}

/**
 * Which keys of a group the deployment decides rather than an operator.
 *
 * The screen renders these as plain text and never submits them; this is the
 * half that holds for a stale tab or a hand-made request.
 */
function readOnlyKeys(def: ConfigGroupDef): Set<string> {
  const out = new Set<string>();
  for (const [key, ui] of Object.entries(def.ui as Record<string, ConfigFieldUi | undefined>)) {
    if (ui?.readOnly === true) out.add(key);
  }
  return out;
}

/**
 * Which keys `configSave` accepts: those with a `ui` entry. Deliberately the
 * same rule `describeGroup` uses to decide what the form shows, so the screen
 * and the write path cannot disagree about what an operator may set.
 */
function writableKeys(def: ConfigGroupDef): Set<string> {
  const ui = def.ui as Record<string, ConfigFieldUi | undefined>;
  return new Set(Object.keys(def.schema.shape).filter((key) => ui[key] !== undefined));
}

function requireGroup(name: string): ConfigGroupDef {
  const def = getConfigGroup(name);
  if (!def) throw new DomainError('SYSTEM_CONFIG_GROUP_NOT_FOUND');
  return def;
}

export async function configGroupList(ctx: Ctx): Promise<{ groups: ConfigGroupSummary[] }> {
  const summaries = allConfigGroups()
    .map((def) => {
      const descriptor = describeGroup(def);
      return {
        group: descriptor.group,
        title: descriptor.title,
        ...(descriptor.description === undefined ? {} : { description: descriptor.description }),
        ...(descriptor.category === undefined ? {} : { category: descriptor.category }),
        permission: descriptor.permission,
        fieldCount: descriptor.fields.length,
        writable: hasPermission(ctx.actor, writePermissionFor(descriptor.permission)),
        testable: descriptor.test !== undefined,
        fieldIndex: descriptor.fields.map((field) => ({
          key: field.key,
          label: field.label,
          ...(field.section === undefined ? {} : { section: field.section }),
        })),
      };
    })
    // A group the caller may not read is not listed at all: a settings index
    // that names screens you cannot open is just a list of 403s.
    .filter((summary) => hasPermission(ctx.actor, summary.permission));
  const testable = summaries.filter((summary) => summary.testable);
  const last =
    testable.length === 0
      ? []
      : await ctx.redis.mget(...testable.map((summary) => lastTestKey(summary.group)));
  const lastByGroup = new Map(testable.map((summary, i) => [summary.group, last[i] ?? null]));
  const statuses = await Promise.all(
    summaries.map((summary) => groupStatus(ctx, requireGroup(summary.group))),
  );
  const groups = summaries.map((summary, i) => {
    const raw = lastByGroup.get(summary.group);
    const status = statuses[i];
    return {
      ...summary,
      ...(raw ? { lastTest: parseLastTest(raw) } : {}),
      ...(status === undefined ? {} : { status }),
    };
  });
  return { groups };
}

/**
 * The group's own status line, from its saved values.
 *
 * Only the index calls this, and the index still has to render when a stored
 * value no longer parses (say, after a schema change). So a failure means the
 * card shows no status, not that the page fails.
 */
async function groupStatus(ctx: Ctx, def: ConfigGroupDef): Promise<ConfigGroupStatus | undefined> {
  if (def.status === undefined) return undefined;
  try {
    return def.status(await ctx.config.get(def));
  } catch (error) {
    ctx.logger.warn({ err: error, group: def.group }, 'config group status failed');
    return undefined;
  }
}

/**
 * A group declaring `system:config:read` is written with `system:config:write`.
 * A group that narrows its permission (say `payment:config:read`) is written
 * with the matching `:write` atom, which its own domain declares.
 */
/**
 * Groups guarded by the payment configuration atom hold the merchant keys and
 * say where the money goes. Like admin and role management they are changed
 * from the console only, never with an API token (the `consoleOnly` rule of
 * the routes, applied per group because one route saves every group).
 */
const CONSOLE_ONLY_GROUP_ATOMS: ReadonlySet<string> = new Set(['payment:config:write']);

function refuseTokenForConsoleGroup(ctx: Ctx, writePermission: string): void {
  if (ctx.actor.apiTokenId !== undefined && CONSOLE_ONLY_GROUP_ATOMS.has(writePermission)) {
    throw new DomainError('AUTH_TOKEN_CONSOLE_ONLY');
  }
}

function writePermissionFor(readPermission: string): string {
  return readPermission.endsWith(':read')
    ? `${readPermission.slice(0, -':read'.length)}:write`
    : readPermission;
}

export async function configGet(ctx: Ctx, params: { group: string }): Promise<ConfigGroupValues> {
  const def = requireGroup(params.group);
  const descriptor = describeGroup(def);
  if (!hasPermission(ctx.actor, descriptor.permission)) {
    throw new DomainError('FORBIDDEN', { details: { permission: descriptor.permission } });
  }

  const effective = (await ctx.config.get(def)) as Record<string, unknown>;
  const secrets = secretKeys(def);
  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(effective)) {
    // The flag, never the secret. This is the whole rule, in one line.
    values[key] = secrets.has(key) ? typeof value === 'string' && value.length > 0 : value;
  }

  const updatedAt = await repo.configGroupUpdatedAt(ctx.db, def.group);
  return { descriptor, values, updatedAt: updatedAt ? updatedAt.toISOString() : null };
}

export async function configSave(
  ctx: Ctx,
  params: { group: string },
  body: ConfigSaveBody,
): Promise<ConfigGroupValues> {
  const def = requireGroup(params.group);
  const descriptor = describeGroup(def);
  const writePermission = writePermissionFor(descriptor.permission);
  if (!hasPermission(ctx.actor, writePermission)) {
    throw new DomainError('FORBIDDEN', { details: { permission: writePermission } });
  }
  refuseTokenForConsoleGroup(ctx, writePermission);

  // The keys the form shows, not every key of the schema. A schema key with no
  // `ui` entry is written by a job or `ctx.config.set` — `wechat.apiBaseUrl` /
  // `payment.apiBaseUrl` exist so a test can point a client at a fake — and
  // accepting it here would let a `payment:config:write` holder repoint the
  // WeChat client at their own host and read the write-only AppSecret off the
  // next token refresh. "Not on the screen" means "not writable from the
  // screen"; a group that ever needs a hidden writable key has to say so in its
  // `ui`, not inherit it from the schema.
  refuseForeignKeys(def, body.values);
  const patch = secretSafePatch(def, body.values);

  // `set` validates the *whole* merged group, so a patch that would leave the
  // group invalid is refused rather than half-written.
  await ctx.config.set(def, patch as never, { updatedBy: adminIdOrNull(ctx) });
  // The mini-program's `GET /api/v1/app/config` is a 60-second Redis cache over
  // a few of these groups (`appConfigSourceGroups`); saving one of them drops
  // it, so the operator sees their change in the app now rather than within
  // the minute.
  await invalidateAppConfigCache(ctx, def.group);
  const secrets = secretKeys(def);
  ctx.logger.info(
    { group: def.group, keys: Object.keys(patch).filter((k) => !secrets.has(k)) },
    'config group saved',
  );
  return configGet(ctx, params);
}

/** What `configSave` refuses before it looks at a single value. `configTest` refuses the same. */
function refuseForeignKeys(def: ConfigGroupDef, values: Record<string, unknown>): void {
  const known = writableKeys(def);
  const unknown = Object.keys(values).filter((key) => !known.has(key));
  if (unknown.length > 0) {
    throw new DomainError('SYSTEM_CONFIG_UNKNOWN_KEY', { details: { keys: unknown } });
  }

  // Refused on presence, not on difference. "You may send it as long as it
  // matches" would mean the value is settable the moment the environment
  // changes underneath a tab that is still open, and it would hide the bug
  // this exists to surface: a caller that thinks `site.publicOrigin` is its to
  // write is wrong even when it happens to send the right string.
  const frozen = readOnlyKeys(def);
  const attempted = Object.keys(values).filter((key) => frozen.has(key));
  if (attempted.length > 0) {
    throw new DomainError('CONFIG_FIELD_READ_ONLY', { details: { keys: attempted } });
  }
}

/**
 * The browser round-trips a secret's "is set" flag. Anything that is not a
 * non-empty string means "leave it alone", so saving the site name can never
 * blank out a credential.
 */
function secretSafePatch(
  def: ConfigGroupDef,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const secrets = secretKeys(def);
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (secrets.has(key) && (typeof value !== 'string' || value.length === 0)) continue;
    patch[key] = value;
  }
  return patch;
}

/** Tests per admin per minute. A test can send an SMS, which is billed. */
const TESTS_PER_MINUTE = 6;
/** How long the index remembers a group's last test. */
const LAST_TEST_TTL_MS = 30 * 24 * 3600 * 1000;

const lastTestKey = (group: string): string => `config:test:last:${group}`;

function parseLastTest(raw: string): { ok: boolean; at: string } | null {
  try {
    const parsed = JSON.parse(raw) as { ok?: unknown; at?: unknown };
    return typeof parsed.ok === 'boolean' && typeof parsed.at === 'string'
      ? { ok: parsed.ok, at: parsed.at }
      : null;
  } catch {
    return null;
  }
}

/**
 * 「测试」: runs the group's test hook against the form as it stands.
 *
 * The values are the stored group with the form's patch on top — the same merge
 * `configSave` would validate — so an empty password box tests the stored
 * secret. Nothing is written back except "last tested at", which the settings
 * index shows.
 */
export async function configTest(
  ctx: Ctx,
  params: { group: string },
  body: ConfigTestBody,
): Promise<ConfigTestResult> {
  const def = requireGroup(params.group);
  const descriptor = describeGroup(def);
  const writePermission = writePermissionFor(descriptor.permission);
  if (!hasPermission(ctx.actor, writePermission)) {
    throw new DomainError('FORBIDDEN', { details: { permission: writePermission } });
  }
  refuseTokenForConsoleGroup(ctx, writePermission);
  const hook = getConfigTest(def.group);
  if (!hook) throw new DomainError('SYSTEM_CONFIG_TEST_UNSUPPORTED');

  refuseForeignKeys(def, body.values);
  const stored = await ctx.config.getRaw(def.group);
  const merged = def.schema.safeParse({ ...stored, ...secretSafePatch(def, body.values) });
  if (!merged.success) {
    throw new DomainError('VALIDATION_FAILED', {
      details: merged.error.issues.map((i) => ({
        field: `values.${i.path.join('.')}`,
        message: i.message,
      })),
    });
  }
  let input: Record<string, unknown> = {};
  if (hook.input) {
    const parsed = hook.input.safeParse(body.input);
    if (!parsed.success) {
      throw new DomainError('VALIDATION_FAILED', {
        details: parsed.error.issues.map((i) => ({
          field: `input.${i.path.join('.')}`,
          message: i.message,
        })),
      });
    }
    input = parsed.data as Record<string, unknown>;
  }

  const nowMs = ctx.clock.now().getTime();
  await enforce(
    fixedWindow(ctx.redis, {
      key: `config:test:${adminIdOrNull(ctx) ?? 'anon'}`,
      limit: TESTS_PER_MINUTE,
      windowMs: 60_000,
      nowMs,
    }),
  );

  const result = await hook.run(ctx, merged.data, input);
  await ctx.redis.set(
    lastTestKey(def.group),
    JSON.stringify({ ok: result.ok, at: ctx.clock.now().toISOString() }),
    'PX',
    LAST_TEST_TTL_MS,
  );
  ctx.logger.info(
    { group: def.group, ok: result.ok, steps: result.steps.map((s) => [s.name, s.ok]) },
    'config group tested',
  );
  return result;
}

function adminIdOrNull(ctx: Ctx): number | null {
  try {
    return requireAdminId(ctx);
  } catch {
    return null;
  }
}
