import type { ReactNode } from 'react';
import { isApiError } from '@shop/api-client';
import { ActionBar } from '@/ui/action-bar';
import './form.scss';

/**
 * The fixed bottom bar of a form page (design.md §5 D): one large block button. The page's
 * `PageShell withBar` leaves room for it.
 */
export function SubmitBar({ children }: { children: ReactNode }) {
  return <ActionBar className="account-submit-bar">{children}</ActionBar>;
}

/** What to tell the shopper about a failed call (one helper app-wide, re-exported for the forms). */
export { errorMessage } from '@/lib/error-message';

/**
 * A failed save's per-field messages: the 422's `details`, plus the codes that name one field
 * (`USER_NICKNAME_REJECTED` → `nickname`). `null` when the error is about no field.
 */
export function fieldErrorsOf(
  error: unknown,
  byCode: Readonly<Record<string, string>> = {},
): Record<string, string> | null {
  if (!isApiError(error)) return null;
  const field = byCode[error.code];
  if (field) return { [field]: error.message };
  return error.fieldErrors;
}

/** The first of `order` that has an error, for focusing it. */
export function firstError<K extends string>(
  errors: { [P in K]?: string | undefined },
  order: readonly K[],
): K | null {
  return order.find((key) => Boolean(errors[key])) ?? null;
}
