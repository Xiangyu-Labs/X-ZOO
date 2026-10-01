// @vitest-environment node
import path from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

/**
 * The mini's own eslint.config.mjs, run on snippets placed where they would live: the weapp
 * preset covers the phone's code (AGENTS.md 14, 17, 1), and tests answer requests only through
 * serveApi (AGENTS.md 20). packages/config/src/weapp.test.js tests the rules themselves; this
 * proves they are switched on here, for the right files.
 */

const eslint = new ESLint({ cwd: path.resolve(import.meta.dirname, '../..') });

async function rules(code: string, filePath: string): Promise<Array<string | null>> {
  const [result] = await eslint.lintText(code, { filePath });
  // The snippets share an import header; what one of them leaves unused is not the point.
  return (result?.messages ?? [])
    .map((message) => message.ruleId)
    .filter((rule) => rule !== '@typescript-eslint/no-unused-vars');
}

describe('apps/mini lint', () => {
  it('holds the pages to what the phone has (AGENTS 14, 17, 1)', async () => {
    const page = 'src/pages/cart/probe.tsx';
    expect(await rules('export const q = Object.fromEntries([]);\n', page)).toEqual([
      'no-restricted-properties',
    ]);
    expect(await rules('export const r = /(?<=¥)\\d+/;\n', page)).toEqual([
      'weapp/no-unsupported-regex',
    ]);
    expect(
      await rules(
        'export const B = ({ pay }: { pay: () => Promise<void> }) => <view onClick={() => void pay()} />;\n',
        page,
      ),
    ).toEqual(['weapp/no-void-handler']);
    expect(
      await rules(
        'declare const toast: { text(t: string): void };\nexport const f = (error: Error) => toast.text(error.message);\n',
        page,
      ),
    ).toEqual(['weapp/no-raw-error-text']);
  });

  it('leaves tests and the build config to Node', async () => {
    expect(
      await rules('export const q = Object.fromEntries([]);\n', 'src/pages/cart/probe.test.ts'),
    ).toEqual([]);
  });

  it('makes tests answer requests through serveApi (AGENTS 20)', async () => {
    const test = 'src/pages/cart/probe.test.ts';
    const header =
      "import { vi } from 'vitest';\nimport { taroFake } from '@/test/taro-fake/taro';\n";
    expect(
      await rules(`${header}taroFake.onRequest = () => ({ statusCode: 200, data: '{}' });\n`, test),
    ).toEqual(['no-restricted-syntax']);
    expect(await rules(`${header}vi.stubGlobal('fetch', vi.fn());\n`, test)).toEqual([
      'no-restricted-syntax',
    ]);
    expect(await rules(`${header}vi.mock('@shop/api-client/react');\n`, test)).toEqual([
      'no-restricted-syntax',
    ]);
    // Reading the handler is fine; so is a spy on a navigation API.
    expect(
      await rules(
        `${header}import Taro from '@tarojs/taro';\nexport const h = taroFake.onRequest;\nvi.spyOn(Taro, 'navigateTo');\n`,
        test,
      ),
    ).toEqual([]);
    // The helper itself assigns the handler.
    expect(
      await rules(
        `import { taroFake } from './taro-fake/taro';\ntaroFake.onRequest = () => ({ statusCode: 200, data: '{}' });\n`,
        'src/test/probe.ts',
      ),
    ).toEqual([]);
  });
});
