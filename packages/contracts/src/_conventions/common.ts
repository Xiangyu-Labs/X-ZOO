import { z } from 'zod';

/** Primary keys are bigint identity columns, carried on the wire as decimal strings. */
export const id = z.string().regex(/^[1-9]\d*$/, 'id 格式不正确');

/**
 * A list of ids in a query string: a comma list or the key repeated. At most
 * 100, one full page.
 *
 * `?ids=12,7,31`, `?ids=12&ids=7` and the two mixed all parse to one array,
 * in the order given.
 */
export const idList = z
  .union([z.string(), z.array(z.string())])
  .transform((value) =>
    (Array.isArray(value) ? value : [value])
      .flatMap((part) => part.split(','))
      .map((part) => part.trim())
      .filter((part) => part !== ''),
  )
  .pipe(z.array(id).min(1).max(100));

/**
 * Money is a decimal string with exactly two fraction digits ("12.00"), never a JS number.
 * Stored as numeric(12,2); the domain works in integer fen through `Money` in core/kernel.
 */
export const money = z.string().regex(/^(0|[1-9]\d{0,9})\.\d{2}$/, '金额格式不正确');

/**
 * A password being set. bcrypt reads 72 bytes and ignores the rest, so core
 * refuses anything longer rather than let two long passwords be one secret.
 * The limit is checked here, in bytes, so that is a 422 with a reason and not
 * a 500 — 24 汉字 is already 72 bytes.
 */
export function newPassword(min: number, message?: string) {
  return z
    .string()
    .min(min, message)
    .max(72)
    .refine(
      (value) => new TextEncoder().encode(value).length <= 72,
      '密码过长（最多 72 字节，约 24 个汉字）',
    );
}

/** Instants are ISO-8601 with offset. Stored as timestamptz. */
export const instant = z.iso.datetime({ offset: true });

/**
 * `page` and `pageSize` arrive as strings on the wire; a typed client may hand
 * over numbers. `z.coerce.number<number | string>()` parses exactly as a bare
 * `z.coerce.number()` does, but declares its input as `number | string` rather
 * than `unknown`, so `page: {}` is a compile error in `@shop/api-client`.
 */
export const pageQuery = z.object({
  page: z.coerce.number<number | string>().int().min(1).default(1),
  pageSize: z.coerce.number<number | string>().int().min(1).max(100).default(20),
});
export type PageQuery = z.infer<typeof pageQuery>;

export function paged<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    total: z.number().int().min(0),
    page: z.number().int().min(1),
    pageSize: z.number().int().min(1),
  });
}

/**
 * Sortable lists take `sortBy` + `sortOrder`; merge into the list query with `.extend(...)`.
 * The admin `CrudTable` sends exactly these two keys.
 */
export function sortQuery<const K extends readonly [string, ...string[]]>(keys: K) {
  return z.object({
    sortBy: z.enum(keys).optional(),
    sortOrder: z.enum(['asc', 'desc']).optional(),
  });
}

/** Which storefront client is calling; sent as the `X-Client-Platform` header. */
export const clientPlatform = z.enum(['h5', 'wechat-oa', 'wechat-mini']);
export type ClientPlatform = z.infer<typeof clientPlatform>;

/**
 * The storefront build's release version, sent as `X-Client-Version`
 * (`1.4.0`, `1.4.0-beta.2`). Mini-program releases stay on phones for months,
 * so the DIY resolver reads it to leave out what an old build cannot render.
 * A header that does not parse is ignored, like an unknown platform.
 */
export const clientVersion = z
  .string()
  .max(32)
  .regex(/^\d{1,5}(\.\d{1,5}){0,2}(-[0-9A-Za-z.]{1,20})?$/);

/** A stored file as clients see it. `url` is absolute or site-relative and directly renderable. */
export const asset = z.object({
  id,
  url: z.string(),
  name: z.string(),
  mime: z.string(),
  size: z.number().int().min(0),
});
