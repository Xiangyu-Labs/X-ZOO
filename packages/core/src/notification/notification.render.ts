/**
 * Placeholder substitution, and the rules for what a channel may be told.
 *
 * Pure functions with a plain unit test — no database, no clock, no context —
 * because every interesting case here is a string case: a missing variable, a
 * placeholder with spaces in it, a value long enough for WeChat to reject the
 * whole message.
 */

import { storefrontRoute, type StorefrontRoute } from '@shop/contracts/system/storefront-routes';

/** `{{ orderNo }}` and `{{orderNo}}` are the same placeholder. */
const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

/**
 * Substitutes `{{name}}` from `data`.
 *
 * An unknown placeholder renders as the **empty string**, not as itself. A
 * customer reading "您的订单 {{orderNo}} 已发货" learns that the shop is broken;
 * one reading "您的订单 已发货" learns nothing but is not alarmed. The admin form
 * lists every variable an event provides, which is where a typo should be
 * caught.
 */
export function render(template: string, data: Readonly<Record<string, string>>): string {
  return template.replace(PLACEHOLDER, (_match, name: string) => data[name] ?? '');
}

/** Which placeholders a template actually uses. Drives the "unused variable" hint. */
export function placeholdersIn(template: string): string[] {
  const found = new Set<string>();
  for (const match of template.matchAll(PLACEHOLDER)) {
    const name = match[1];
    if (name !== undefined) found.add(name);
  }
  return [...found].sort();
}

/**
 * The old system's `{store_name}` and `{$order_id}`: one brace, optionally a
 * dollar. `render` leaves them alone, so a shopper reads them literally.
 */
const LEGACY_PLACEHOLDER = /\{\s*\$?([A-Za-z_][A-Za-z0-9_]*)\s*\}/g;

/**
 * Single-brace placeholders in a template, as written (`{$order_id}`), with
 * the name inside. A real `{{orderNo}}` is not one of them.
 */
export function legacyPlaceholdersIn(template: string): { token: string; name: string }[] {
  const found = new Map<string, string>();
  for (const match of template.replace(PLACEHOLDER, ' ').matchAll(LEGACY_PLACEHOLDER)) {
    const name = match[1];
    if (name !== undefined && !found.has(match[0])) found.set(match[0], name);
  }
  return [...found].map(([token, name]) => ({ token, name }));
}

/**
 * WeChat rejects a template-message field longer than 200 characters with
 * `errcode 47001`, which reads like a malformed-JSON error and sends everyone
 * looking in the wrong place. Truncating is the lesser evil: the message
 * arrives, slightly short, instead of the effect retrying eight times and
 * parking.
 */
export const WECHAT_FIELD_LIMIT = 200;

export function clampField(value: string, limit = WECHAT_FIELD_LIMIT): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

/**
 * Renders a field map (`{ first: '…', keyword1: '{{orderNo}}' }`) into what a
 * template-message API wants: `{ first: { value: '…' } }`.
 *
 * A field that renders to the empty string is **dropped**, not sent as `""`.
 * WeChat's subscribe-message validator types its fields — `thing3` must be 1-20
 * characters, `amount5` must look like money — and an empty string fails the
 * type check for the whole message (`errcode 47003`), so one missing variable
 * would lose the entire notification instead of one line of it.
 */
export function renderFields(
  fields: Readonly<Record<string, string>> | undefined,
  data: Readonly<Record<string, string>>,
): Record<string, { value: string }> {
  const out: Record<string, { value: string }> = {};
  for (const [key, template] of Object.entries(fields ?? {})) {
    const value = clampField(render(template, data));
    if (value !== '') out[key] = { value };
  }
  return out;
}

/**
 * A mini-program subscribe message types each field by its key's letters
 * (`thing3` is a `thing`, `character_string2` a `character_string`), and a
 * value its type does not accept fails the **whole** message with `47003`.
 * So each value is fitted to its type before it is sent:
 *
 * - `thing` — up to 20 characters, cut with `…`;
 * - `character_string` — up to 32 digits, letters and ASCII symbols; anything
 *   else (a Chinese character, a space) is dropped rather than rejected;
 * - `number`, `letter` — up to 32; `symbol` — up to 5;
 * - `phrase` — up to 5 characters;
 * - `name` — up to 10 characters, or 20 when it is all ASCII;
 * - `phone_number` — up to 17; `car_number` — up to 8.
 *
 * `amount`, `time` and `date` are formats, not lengths: cutting one would only
 * turn a valid value into an invalid one, so they are left as rendered.
 */
const SUBSCRIBE_LIMITS: Readonly<Record<string, number>> = {
  thing: 20,
  character_string: 32,
  number: 32,
  letter: 32,
  symbol: 5,
  phrase: 5,
  phone_number: 17,
  car_number: 8,
};

export function subscribeFieldType(key: string): string {
  return key.replace(/\d+$/, '');
}

export function fitSubscribeField(key: string, value: string): string {
  const type = subscribeFieldType(key);
  // Characters, not UTF-16 units: an emoji is one character to WeChat.
  let chars = [...value];
  if (type === 'character_string') chars = chars.filter((char) => /^[\x21-\x7e]$/.test(char));
  if (type === 'thing') {
    return chars.length <= 20 ? chars.join('') : `${chars.slice(0, 19).join('')}…`;
  }
  if (type === 'name') {
    const limit = chars.every((char) => char.charCodeAt(0) < 0x80) ? 20 : 10;
    return chars.slice(0, limit).join('');
  }
  const limit = SUBSCRIBE_LIMITS[type];
  return limit === undefined ? value : chars.slice(0, limit).join('');
}

/** `renderFields` for a subscribe message: each value fitted to its field's type. */
export function renderSubscribeFields(
  fields: Readonly<Record<string, string>> | undefined,
  data: Readonly<Record<string, string>>,
): Record<string, { value: string }> {
  const out: Record<string, { value: string }> = {};
  for (const [key, { value }] of Object.entries(renderFields(fields, data))) {
    const fitted = fitSubscribeField(key, value);
    if (fitted !== '') out[key] = { value: fitted };
  }
  return out;
}

/**
 * An SMS template's variables, rendered, in the operator's order — and only
 * those. Tencent fills `{1}`, `{2}`… positionally and refuses a count that
 * differs from the approved template, so the event's payload is never sent as
 * such; an empty list (a template with no variables) stays empty. An empty
 * value is kept, not dropped: dropping it would shift every later variable
 * into the wrong slot.
 */
export function renderSmsParams(
  params: readonly { name?: string | undefined; value: string }[] | undefined,
  data: Readonly<Record<string, string>>,
): { name: string; value: string }[] {
  return (params ?? []).map((param) => ({
    name: (param.name ?? '').trim(),
    value: render(param.value, data),
  }));
}

/**
 * Everything in the payload flattened to strings, because a template is text.
 *
 * `null` and `undefined` become the empty string (so the placeholder
 * disappears), numbers and booleans are stringified, and anything structured is
 * dropped rather than rendered as `[object Object]` — which is the one output
 * that would certainly be wrong in a customer's inbox.
 */
export function toTemplateData(payload: unknown): Record<string, string> {
  if (typeof payload !== 'object' || payload === null) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (value === null || value === undefined) {
      out[key] = '';
    } else if (typeof value === 'string') {
      out[key] = value;
    } else if (
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      typeof value === 'bigint'
    ) {
      out[key] = String(value);
    }
  }
  return out;
}

const shopDay = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const shopClock = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Shanghai',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/**
 * An instant as a shopper reads it: the shop's own calendar, not UTC.
 *
 * A template is text, so a domain that puts a time into `data` formats it
 * first; an ISO string in a customer's inbox (`2026-06-01T16:00:00.000Z`) is
 * both unreadable and, eight hours out, wrong about which day it is.
 *
 * `'day'` → `2026-06-02`; `'minute'` → `2026-06-02 00:00`.
 */
export function formatShopTime(at: Date, precision: 'day' | 'minute'): string {
  const day = shopDay.format(at);
  return precision === 'day' ? day : `${day} ${shopClock.format(at)}`;
}

/**
 * An event's route template, filled in from `data` and then validated against
 * the key's params — in that order, because `{{orderId}}` is not an id until it
 * is substituted. `null` when the result is not a valid route (a variable the
 * payload did not carry renders empty, which no id accepts): the caller sends
 * the message without a destination rather than with a wrong one.
 */
export function renderRoute(
  template: { route: string; params: Readonly<Record<string, string>> },
  data: Readonly<Record<string, string>>,
): StorefrontRoute | null {
  const params = Object.fromEntries(
    Object.entries(template.params).map(([name, value]) => [name, render(value, data)]),
  );
  const parsed = storefrontRoute.safeParse({ route: template.route, params });
  return parsed.success ? parsed.data : null;
}
