import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { MINI_MUTATIONS, type MiniMutation } from '../../scripts/mutations/mini';
import { miniApp, repoRoot, storefrontBlocksSrc } from '../lib/paths';
import { MINI_RULES, checkMini } from './mini';

/**
 * The `mini` guard, proved by mutation (the MUT-001 idea, applied to a guard).
 *
 * Every mutant in `scripts/mutations/mini.ts` is applied to its own scratch
 * copy of `apps/mini` and the guard must answer with a `fail` finding tagged
 * with the mutant's rule. The unmutated copy must pass, so a kill is the
 * mutation's doing and not the copy's. The live tree is never written.
 *
 * The copy sits at `<scratch>/apps/mini` next to a copy of `tsconfig.base.json`
 * so its `tsconfig.json` still resolves, and borrows the live `node_modules`
 * through a symlink.
 */

// Every test copies `apps/mini` and runs the whole guard over the copy: about
// five seconds on an idle runner, which is vitest's default limit. On a busy one
// (CI runs every package's unit tests side by side) the limit is what fails.
vi.setConfig({ testTimeout: 60_000 });

const SKIP = new Set(['node_modules', 'dist', '.swc', '.bundle-stats', '.turbo', 'coverage']);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'shop-mini-guard-'));

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

function copyApp(name: string): string {
  const target = path.join(scratch, name, 'apps/mini');
  fs.cpSync(miniApp, target, {
    recursive: true,
    filter: (source) => !SKIP.has(path.basename(source)),
  });
  fs.symlinkSync(path.join(miniApp, 'node_modules'), path.join(target, 'node_modules'), 'dir');
  // `extends: ../../tsconfig.base.json` from the copy.
  fs.copyFileSync(
    path.join(repoRoot, 'tsconfig.base.json'),
    path.join(scratch, name, 'tsconfig.base.json'),
  );
  return target;
}

function occurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) {
    count += 1;
  }
  return count;
}

function apply(app: string, mutation: MiniMutation): void {
  for (const edit of mutation.edits) {
    const file = path.join(app, edit.file);
    if ('create' in edit) {
      if (fs.existsSync(file)) {
        throw new Error(`${mutation.id}: ${edit.file} exists in the tree now — pick another name`);
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, edit.create);
      continue;
    }
    const source = fs.readFileSync(file, 'utf8');
    const found = occurrences(source, edit.search);
    if (found !== 1) {
      throw new Error(
        `${mutation.id}: "${edit.search}" occurs ${found} times in ${edit.file}, not once — update the anchor`,
      );
    }
    fs.writeFileSync(file, source.replace(edit.search, edit.replace));
  }
}

const failures = (findings: Awaited<ReturnType<typeof checkMini>>['findings']): string[] =>
  findings.filter((f) => f.level === 'fail').map((f) => `${f.where}: ${f.message}`);

describe('the mini guard, by mutation', () => {
  it('passes the unmutated copy', async () => {
    const report = await checkMini({ app: copyApp('baseline') });
    expect(failures(report.findings).join('\n')).toBe('');
  });

  // The live tree commits the shop's own AppID (the baseline covers it); the tourist
  // placeholder is the other id a committed file may carry.
  it('accepts the tourist placeholder, committed in the project config and a shared env file', async () => {
    const app = copyApp('tourist-appid');
    apply(app, {
      id: 'tourist-appid',
      rule: 'config',
      summary: "WeChat DevTools' tourist AppID",
      edits: [
        {
          file: 'project.config.json',
          search: '"appid": "wx4f4b772125e155ed"',
          replace: '"appid": "touristappid"',
        },
        {
          file: '.env.production',
          search: 'TARO_APP_ID="wx4f4b772125e155ed"',
          replace: 'TARO_APP_ID="touristappid"',
        },
      ],
      expect: /$^/,
    });
    const report = await checkMini({ app });
    expect(failures(report.findings).join('\n')).toBe('');
  });

  it('has at least one mutant per rule, each id once', () => {
    for (const rule of MINI_RULES) {
      expect(
        MINI_MUTATIONS.some((m) => m.rule === rule),
        rule,
      ).toBe(true);
    }
    expect(new Set(MINI_MUTATIONS.map((m) => m.id)).size).toBe(MINI_MUTATIONS.length);
  });

  it('kills a block that calls Taro, imports NutUI and links to a retired page [platform, nutui, retired]', async () => {
    const blocks = path.join(scratch, 'blocks-src');
    fs.cpSync(storefrontBlocksSrc, blocks, { recursive: true });
    fs.writeFileSync(
      path.join(blocks, 'blocks/mutant.tsx'),
      [
        "import Taro from '@tarojs/taro';",
        "import NutButton from '@nutui/nutui-react-taro/dist/es/packages/button';",
        '',
        "export const open = () => Taro.navigateTo({ url: '/packages/promo/bargain/index' });",
        'export { NutButton };',
        '',
      ].join('\n'),
    );
    const found = failures(
      (await checkMini({ app: copyApp('blocks'), packages: [blocks] })).findings,
    );
    for (const [rule, pattern] of [
      ['platform', /Taro\.navigateTo outside src\/platform\//],
      ['nutui', /imports @nutui\/nutui-react-taro\/dist\/es\/packages\/button; NutUI is not used/],
      ['retired', /bargain\/index is a URL for the retired 砍价/],
    ] as const) {
      expect(
        found.some((line) => line.includes(`[${rule}]`) && pattern.test(line)),
        `${rule}:\n${found.join('\n')}`,
      ).toBe(true);
    }
  });

  for (const mutation of MINI_MUTATIONS) {
    it(`kills ${mutation.id} [${mutation.rule}]: ${mutation.summary}`, async () => {
      const app = copyApp(mutation.id);
      apply(app, mutation);
      const found = failures((await checkMini({ app })).findings);
      const killed = found.some(
        (line) => line.includes(`[${mutation.rule}]`) && mutation.expect.test(line),
      );
      expect(
        killed,
        `no [${mutation.rule}] failure matching ${mutation.expect}:\n${found.join('\n')}`,
      ).toBe(true);
    });
  }
});
