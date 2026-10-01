import { z } from 'zod';

/**
 * Makes zod speak Simplified Chinese.
 *
 * Error messages are human-readable, Simplified Chinese and safe to show to the
 * end user (`docs/conventions.md`). A 422 body carries per-field messages
 * straight from zod, so without this every validation failure would show the
 * shopper "Invalid input: expected string, received undefined".
 *
 * zod's own zh-CN locale is a translation of the developer's message —
 * 「无效输入：期望 string，实际接收 undefined」, 「数值过大：期望 string <=5 字符」
 * — so the issues a person actually meets are phrased here first, and the
 * locale answers only the rest.
 *
 * Importing this module is the whole API — it configures the global zod
 * instance. Anything that turns a `ZodError` into a message imports it:
 * `handle()` in apps/web, the admin console, and the mock server. A domain
 * that wants a better message than the generic one still passes its own to
 * the schema; a schema's own message always wins over this one.
 */

type Issue = Parameters<NonNullable<z.core.$ZodConfig['customError']>>[0];

function isEmpty(input: unknown): boolean {
  return input === undefined || input === null || input === '';
}

function bound(value: unknown): string {
  return typeof value === 'bigint' ? value.toString() : String(value);
}

/** The message a person reads for `issue`, or `undefined` to let the locale answer. */
export function plainMessage(issue: Issue): string | undefined {
  switch (issue.code) {
    case 'invalid_type':
      if (isEmpty(issue.input)) return '请填写此项';
      if (issue.expected === 'int') return '请输入整数';
      if (issue.expected === 'number') return '请输入数字';
      return undefined;
    case 'invalid_value':
      return isEmpty(issue.input) ? '请选择此项' : '请选择有效的选项';
    case 'too_small': {
      const min = bound(issue.minimum);
      if (issue.origin === 'string') {
        return issue.minimum === 1 ? '请填写此项' : `至少 ${min} 个字`;
      }
      if (issue.origin === 'array' || issue.origin === 'set') {
        return issue.minimum === 1 ? '请至少选择一项' : `至少 ${min} 项`;
      }
      if (issue.origin === 'number' || issue.origin === 'int' || issue.origin === 'bigint') {
        return issue.inclusive === false ? `必须大于 ${min}` : `不能小于 ${min}`;
      }
      return undefined;
    }
    case 'too_big': {
      const max = bound(issue.maximum);
      if (issue.origin === 'string') return `最多 ${max} 个字`;
      if (issue.origin === 'array' || issue.origin === 'set') return `最多 ${max} 项`;
      if (issue.origin === 'number' || issue.origin === 'int' || issue.origin === 'bigint') {
        return issue.inclusive === false ? `必须小于 ${max}` : `不能大于 ${max}`;
      }
      return undefined;
    }
    case 'invalid_format':
      // The locale would print the regular expression itself.
      return issue.format === 'regex' ||
        issue.format === 'starts_with' ||
        issue.format === 'ends_with' ||
        issue.format === 'includes'
        ? '格式不正确'
        : undefined;
    default:
      return undefined;
  }
}

z.config({ ...z.locales.zhCN(), customError: plainMessage });

export const zodLocale = 'zh-CN';
