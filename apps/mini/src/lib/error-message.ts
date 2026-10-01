import { isApiError } from '@shop/api-client';

/** Han characters: a message we wrote for the shopper, not a runtime's or WeChat's English. */
const CHINESE = /[一-鿿]/;

/**
 * What to tell the shopper about a failed call: the server's own words (an `ApiError` is already
 * Chinese), an `Error` of ours that says something in Chinese, or `fallback`. Never a runtime's
 * `TypeError`, WeChat's `login:fail …` (a plain object: `String()` of it is `[object Object]`)
 * or any other English; that goes to the console for 真机调试.
 */
export function errorMessage(error: unknown, fallback = '操作失败，请稍后再试'): string {
  if (isApiError(error)) return error.message || fallback;
  if (error instanceof Error && CHINESE.test(error.message)) return error.message;
  console.warn(fallback, error);
  return fallback;
}
