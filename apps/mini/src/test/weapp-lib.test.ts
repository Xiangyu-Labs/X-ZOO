// @vitest-environment node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * tsconfig.weapp.json types the phone's code against iOS 12's library (AGENTS.md 14). This
 * compiles a scratch file with exactly its `lib` and `types`, so a newer library slipping back
 * in (by hand, or through a `types` entry that references one, as @types/node does) fails here.
 */

const appRoot = path.resolve(import.meta.dirname, '../..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'weapp-lib-'));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

/** tsconfig.weapp.json, comments and all. */
function weappOptions(): { lib: string[]; types: string[] } {
  const text = fs.readFileSync(path.join(appRoot, 'tsconfig.weapp.json'), 'utf8');
  const json = JSON.parse(text.replace(/^\s*\/\/.*$/gm, '')) as {
    compilerOptions: { lib: string[]; types: string[] };
  };
  return json.compilerOptions;
}

function compile(source: string): string {
  const dir = fs.mkdtempSync(path.join(scratch, 'probe-'));
  fs.writeFileSync(path.join(dir, 'probe.ts'), `${source}\nexport {};\n`);
  const { lib, types } = weappOptions();
  fs.writeFileSync(
    path.join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { lib, types, target: 'ES2018', strict: true, noEmit: true },
      files: ['probe.ts'],
    }),
  );
  const run = spawnSync(path.join(appRoot, 'node_modules/.bin/tsc'), ['-p', dir], {
    encoding: 'utf8',
  });
  return `${run.stdout}${run.stderr}`;
}

describe('tsconfig.weapp.json (AGENTS 14)', () => {
  it('leaves @types/node out: it would bring the ES2020 library back', () => {
    expect(weappOptions().types).toEqual([]);
    expect(weappOptions().lib.filter((lib) => !/^(ES2018|ES2019\.|DOM)/.test(lib))).toEqual([]);
  });

  it('refuses what iOS 12 lacks', () => {
    const out = compile(
      [
        "'a'.matchAll(/a/g);",
        "'a'.replaceAll('a', 'b');",
        '[1].at(-1);',
        '[1].findLast((x) => x > 0);',
        'void Promise.allSettled([]);',
        "Object.hasOwn({}, 'a');",
      ].join('\n'),
    );
    for (const name of ['matchAll', 'replaceAll', "'at'", 'findLast', 'allSettled', 'hasOwn']) {
      expect(out).toContain(name);
    }
  });

  it('accepts what iOS 12 has', () => {
    expect(compile("[[1]].flatMap((x) => x).includes(1);\n' a'.trimStart();")).toBe('');
  });
});
