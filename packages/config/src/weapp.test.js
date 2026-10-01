import { Linter, RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import { uiConfig } from '../eslint/ui.js';
import { weappConfig } from '../eslint/weapp.js';
import { hasLookbehind, weappPlugin } from '../eslint/weapp-rules.js';

/**
 * The weapp preset is what makes AGENTS.md 14 (only what WeChat and iOS 12 have), 17 (handlers
 * return their promise) and 1 (no raw error text for the shopper) fail at lint time in
 * apps/mini, @shop/storefront-blocks and @shop/api-client. Each rule is shown firing on the
 * shape that shipped, and staying quiet on the look-alikes the tree is full of.
 */

const tester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    ecmaVersion: 2023,
    sourceType: 'module',
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

const FILE = '/repo/apps/mini/src/pages/cart/index.tsx';

describe('weapp/no-unsupported-regex (AGENTS 14)', () => {
  it('reads the pattern as the engine does', () => {
    expect(hasLookbehind('(?<=a)b')).toBe(true);
    expect(hasLookbehind('(?<!a)b')).toBe(true);
    expect(hasLookbehind('(?<name>a)')).toBe(false);
    expect(hasLookbehind('\\(?<=')).toBe(false);
    expect(hasLookbehind('[(?<=]')).toBe(false);
    expect(hasLookbehind('[\\]](?<=x)')).toBe(true);
  });

  it('refuses lookbehind and the d / v flags, literal or constructed', () => {
    tester.run('no-unsupported-regex', weappPlugin.rules['no-unsupported-regex'], {
      valid: [
        { code: 'const re = /(?<year>\\d{4})-(\\d{2})/u;', filename: FILE },
        { code: 'const re = /\\(?<=/;', filename: FILE },
        { code: "const re = new RegExp('^a+$', 'gi');", filename: FILE },
        { code: 'const re = new RegExp(source);', filename: FILE },
      ],
      invalid: [
        {
          code: 'const re = /(?<![\\w$.])eval/;',
          filename: FILE,
          errors: [{ messageId: 'lookbehind' }],
        },
        {
          code: "const re = new RegExp('(?<=¥)\\\\d+');",
          filename: FILE,
          errors: [{ messageId: 'lookbehind' }],
        },
        {
          code: 'const re = RegExp(`(?<=a)`);',
          filename: FILE,
          errors: [{ messageId: 'lookbehind' }],
        },
        { code: 'const re = /a/d;', filename: FILE, errors: [{ messageId: 'flag' }] },
        {
          code: "const re = new RegExp('a', 'v');",
          filename: FILE,
          errors: [{ messageId: 'flag' }],
        },
      ],
    });
  });
});

describe('weapp/no-void-handler (AGENTS 17)', () => {
  it('refuses a handler prop that throws its promise away, and fixes it', () => {
    tester.run('no-void-handler', weappPlugin.rules['no-void-handler'], {
      valid: [
        { code: '<Button onClick={() => pay()} />', filename: FILE },
        { code: '<Button onClick={pay} />', filename: FILE },
        { code: '<Button onClick={async () => { await pay(); }} />', filename: FILE },
        // Not a handler prop.
        { code: '<List render={() => void 0} />', filename: FILE },
        // Outside JSX, `void` is how a fire-and-forget effect says so.
        { code: 'useEffect(() => { void refetch(); }, []);', filename: FILE },
        // antd's toast settles when it closes: dropping it is right.
        { code: '<Form onSuccess={() => void message.success("已保存")} />', filename: FILE },
        {
          code: '<Form onSuccess={() => { void notification.info({ message: "x" }); close(); }} />',
          filename: FILE,
        },
      ],
      invalid: [
        {
          code: '<Button onClick={() => void pay()} />',
          output: '<Button onClick={() => pay()} />',
          filename: FILE,
          errors: [{ messageId: 'void' }],
        },
        {
          code: '<ErrorBlock onRetry={() => void query.refetch()} />',
          output: '<ErrorBlock onRetry={() => query.refetch()} />',
          filename: FILE,
          errors: [{ messageId: 'void' }],
        },
        {
          code: '<Cell onTap={() => { setOpen(false); void navigate(to); }} />',
          output: '<Cell onTap={() => { setOpen(false); return navigate(to); }} />',
          filename: FILE,
          errors: [{ messageId: 'void' }],
        },
        {
          // Not the last statement: reported, not fixed.
          code: '<Cell onTap={() => { void save(); close(); }} />',
          output: null,
          filename: FILE,
          errors: [{ messageId: 'void' }],
        },
      ],
    });
  });
});

describe('weapp/no-raw-error-text (AGENTS 1)', () => {
  it('refuses an error’s own text where a shopper reads it', () => {
    tester.run('no-raw-error-text', weappPlugin.rules['no-raw-error-text'], {
      valid: [
        { code: 'toast.text(errorMessage(error, "提交失败"));', filename: FILE },
        { code: 'console.warn(error.message);', filename: FILE },
        { code: 'throw new Error(error.message, { cause: error });', filename: FILE },
        { code: 'if (error.message.includes("timeout")) retry();', filename: FILE },
        // Data, not an error.
        { code: '<Text>{refund.reason}</Text>', filename: FILE },
        { code: 'toast.text(`原因：${refund.reason}`);', filename: FILE },
        { code: '<Text>{session.message}</Text>', filename: FILE },
        // An ApiError's message is the server's Chinese.
        { code: 'toast.text(isApiError(error) ? error.message : "上传失败");', filename: FILE },
        {
          code: 'if (isApiError(error, "auth.changePassword")) { if (error.code === "X") setErrors({ old: error.message }); }',
          filename: FILE,
        },
        {
          code: 'function f(error) { if (!isApiError(error) || error.status !== 409) return null; return { title: error.message }; }',
          filename: FILE,
        },
        { code: 'toast.text(error instanceof ApiError ? error.message : "失败");', filename: FILE },
        // The admin's guard, and the negated form.
        {
          code: '<Result subTitle={ApiError.is(error) ? error.message : "加载失败"} />',
          filename: FILE,
        },
        {
          code: 'const banner = !ApiError.is(error) ? null : ok ? null : { message: error.message };',
          filename: FILE,
        },
        {
          code: 'if (!isApiError(error)) { toast.text("失败"); } else { toast.text(error.message); }',
          filename: FILE,
        },
        // A log line built from it.
        { code: 'const line = `${error}`; log(line);', filename: FILE },
      ],
      invalid: [
        {
          code: 'mutate(x, { onError: (error) => toast.text(error.message) });',
          filename: FILE,
          errors: [{ messageId: 'raw' }],
        },
        {
          code: 'toast.text(error instanceof Error ? error.message : "提交失败，请稍后重试");',
          filename: FILE,
          errors: [{ messageId: 'raw' }],
        },
        {
          code: '<Text>{query.error.message}</Text>',
          filename: FILE,
          errors: [{ messageId: 'raw' }],
        },
        { code: '<Text>{String(err)}</Text>', filename: FILE, errors: [{ messageId: 'raw' }] },
        {
          code: 'showModal({ title: "失败", content: `${e}` });',
          filename: FILE,
          errors: [{ messageId: 'raw' }],
        },
        {
          code: 'showToast({ title: result.errMsg });',
          filename: FILE,
          errors: [{ messageId: 'raw' }],
        },
        {
          code: 'setErrorText(cause.message.slice(0, 20));',
          filename: FILE,
          errors: [{ messageId: 'raw' }],
        },
        {
          code: 'setPhase({ kind: "failed", message: error.message });',
          filename: FILE,
          errors: [{ messageId: 'raw' }],
        },
        {
          code: 'const codeError = code.isError ? code.error.message : null;',
          filename: FILE,
          errors: [{ messageId: 'raw' }],
        },
        { code: 'toast.text("失败：" + error);', filename: FILE, errors: [{ messageId: 'raw' }] },
        {
          code: '<Result subTitle={ApiError.is(other) ? error.message : "加载失败"} />',
          filename: FILE,
          errors: [{ messageId: 'raw' }],
        },
        {
          code: '<Result subTitle={!ApiError.is(error) ? error.message : "加载失败"} />',
          filename: FILE,
          errors: [{ messageId: 'raw' }],
        },
        {
          code: '<Result description={JSON.stringify(loadError)} />',
          filename: FILE,
          errors: [{ messageId: 'raw' }],
        },
      ],
    });
  });
});

describe('weappConfig', () => {
  const linter = new Linter({ configType: 'flat' });
  const config = [
    {
      files: ['**/*.ts', '**/*.tsx'],
      languageOptions: {
        parser: tseslint.parser,
        parserOptions: { ecmaFeatures: { jsx: true } },
      },
    },
    ...weappConfig({
      files: ['src/**/*.ts', 'src/**/*.tsx'],
      ignores: ['src/**/*.test.ts'],
      uiIgnores: ['src/platform/**'],
      extraGlobals: [{ name: 'Buffer', message: 'no Buffer' }],
    }),
  ];
  const lint = (code, filename = 'src/pages/a.tsx') =>
    linter.verify(code, config, filename).map((m) => m.ruleId);

  it('bans what iOS 12 or the WeChat runtime lack (AGENTS 14)', () => {
    expect(lint('Object.fromEntries(pairs);')).toEqual(['no-restricted-properties']);
    expect(lint('new URLSearchParams(q);')).toEqual(['no-restricted-globals']);
    expect(lint("'a'.matchAll(/a/g);")).toEqual(['no-restricted-properties']);
    expect(lint('list.findLast((x) => x);')).toEqual(['no-restricted-properties']);
    expect(lint('Promise.allSettled([]);')).toEqual(['no-restricted-properties']);
    expect(lint('rows.at(-1);')).toEqual(['no-restricted-syntax']);
    expect(lint('const n = 10n;')).toEqual(['no-restricted-syntax']);
    expect(lint('new Function("x");')).toEqual(['no-restricted-syntax']);
    expect(lint('globalThis.x = 1;')).toEqual(['no-restricted-globals']);
    expect(lint('/(?<=a)b/.test(s);')).toEqual(['weapp/no-unsupported-regex']);
    expect(lint('Buffer.from(s);')).toEqual(['no-restricted-globals']);
  });

  it('bans void handlers and raw error text (AGENTS 17, 1)', () => {
    expect(lint('<Button onClick={() => void pay()} />')).toEqual(['weapp/no-void-handler']);
    expect(lint('<Text>{error.message}</Text>')).toEqual(['weapp/no-raw-error-text']);
  });

  it('leaves out what does not run on the phone, and the error-translating layer', () => {
    expect(lint('Object.fromEntries(pairs);', 'src/a.test.ts')).toEqual([]);
    expect(lint('Object.fromEntries(pairs);', 'scripts/a.ts')).toEqual([]);
    expect(lint('toast.text(error.message);', 'src/platform/a.ts')).toEqual([]);
    expect(lint('Object.fromEntries(pairs);', 'src/platform/a.ts')).toEqual([
      'no-restricted-properties',
    ]);
  });

  it('passes what the phone has', () => {
    expect(lint('rows.flatMap((r) => r.items).includes(x);')).toEqual([]);
    expect(lint("Object.entries(o).map(([k, v]) => `${k}=${v}`).join('&');")).toEqual([]);
    expect(lint('rows[rows.length - 1];')).toEqual([]);
  });
});

describe('uiConfig (the admin)', () => {
  const linter = new Linter({ configType: 'flat' });
  const config = [
    {
      files: ['**/*.ts', '**/*.tsx'],
      languageOptions: {
        parser: tseslint.parser,
        parserOptions: { ecmaFeatures: { jsx: true } },
      },
    },
    ...uiConfig({
      files: ['app/**/*.tsx', 'src/**/*.tsx'],
      ignores: ['**/*.test.tsx'],
      uiIgnores: ['src/admin/api/**'],
    }),
  ];
  const lint = (code, filename = 'app/admin/a.tsx') =>
    linter.verify(code, config, filename).map((m) => m.ruleId);

  it('bans void handlers and raw error text under ui/, and nothing about iOS 12', () => {
    expect(lint('<Button onClick={() => void run()} />')).toEqual(['ui/no-void-handler']);
    expect(lint('<Alert message={query.error.message} />')).toEqual(['ui/no-raw-error-text']);
    expect(lint('<Alert message={errorMessage(query.error, "加载失败")} />')).toEqual([]);
    expect(lint('Object.fromEntries(pairs);')).toEqual([]);
  });

  it('leaves out tests and the error-translating layer', () => {
    expect(lint('<Alert message={error.message} />', 'app/admin/a.test.tsx')).toEqual([]);
    expect(lint('<Alert message={error.message} />', 'src/admin/api/a.tsx')).toEqual([]);
    expect(lint('<B onClick={() => void run()} />', 'src/admin/api/a.tsx')).toEqual([
      'ui/no-void-handler',
    ]);
  });
});
