import { z } from 'zod';

/** Wire shape of every non-2xx response on both surfaces. */
export const errorBody = z.object({
  /** Stable machine code, SCREAMING_SNAKE, e.g. `ORDER_NOT_CANCELLABLE`. Clients branch on this. */
  code: z.string(),
  /** Human-readable, Simplified Chinese, safe to show to the end user. */
  message: z.string(),
  /** Field errors for 422, or domain-specific context. Never secrets, never stack traces. */
  details: z.unknown().optional(),
});
export type ErrorBody = z.infer<typeof errorBody>;

export type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 502 | 503;

export interface ErrorSpec {
  status: ErrorStatus;
  message: string;
}

/**
 * Declares a domain's error codes in `contracts/src/<domain>/errors.ts`.
 * Codes are prefixed by the domain (`COUPON_`, `ORDER_`), which keeps them globally unique.
 */
export function defineErrors<const T extends Record<string, ErrorSpec>>(specs: T): T {
  for (const code of Object.keys(specs)) {
    if (!/^[A-Z][A-Z0-9_]+$/.test(code)) {
      throw new Error(`error code ${code} must be SCREAMING_SNAKE`);
    }
  }
  return specs;
}

/** Codes any route may return without listing them. */
export const commonErrors = defineErrors({
  UNAUTHENTICATED: { status: 401, message: '请先登录' },
  FORBIDDEN: { status: 403, message: '没有权限执行此操作' },
  NOT_FOUND: { status: 404, message: '资源不存在' },
  VALIDATION_FAILED: { status: 422, message: '提交的数据有误' },
  RATE_LIMITED: { status: 429, message: '操作过于频繁，请稍后再试' },
  // A PostgreSQL foreign-key violation no service turned into its own code
  // (`handle()` maps it; the constraint name stays in the log). A domain that
  // can say more — 该分类下还有商品 — still throws its own `*_IN_USE` first.
  REFERENCE_IN_USE: { status: 409, message: '该数据仍被其他记录使用，无法删除' },
  REFERENCE_MISSING: { status: 409, message: '关联的数据不存在或已被删除，请刷新后重试' },
  INTERNAL: { status: 500, message: '服务器开小差了，请稍后再试' },
});
