import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dedupeServerChunks } from './dedupe-server-chunks';

let dist: string;

async function put(rel: string, body: string) {
  const file = path.join(dist, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, body);
}

const read = (rel: string) => readFile(path.join(dist, rel), 'utf8');
const graph = 'module.exports=[1,t=>{t.s(["getContainer",0,()=>1])}];';

beforeEach(async () => {
  dist = await mkdtemp(path.join(tmpdir(), 'dedupe-'));
});
afterEach(async () => {
  await rm(dist, { recursive: true, force: true });
});

describe('dedupeServerChunks', () => {
  it('keeps one copy of chunks that differ only in their source map comment and repoints references', async () => {
    await put('server/chunks/_a._.js', `${graph}\n\n//# sourceMappingURL=_a._.js.map`);
    await put('server/chunks/_a._.js.map', '{}');
    await put('server/chunks/_b._.js', `${graph}\n\n//# sourceMappingURL=_b._.js.map`);
    await put('server/chunks/_b._.js.map', '{}');
    await put('server/chunks/ssr/_c._.js', `${graph}\n//# sourceMappingURL=_c._.js.map\n`);
    await put('server/chunks/_other._.js', 'module.exports=[2,t=>{}];');
    await put(
      'server/app/api/v1/x/route.js',
      'R.c("server/chunks/_b._.js")\nR.c("server/chunks/_other._.js")\nR.c("server/chunks/ssr/_c._.js")',
    );
    await put(
      'server/app/api/v1/x/route.js.nft.json',
      JSON.stringify({
        version: 1,
        files: ['../../../../chunks/_a._.js', '../../../../chunks/_b._.js'],
      }),
    );

    const result = await dedupeServerChunks(dist);

    expect(result.removed).toBe(2);
    expect(existsSync(path.join(dist, 'server/chunks/_a._.js'))).toBe(true);
    expect(existsSync(path.join(dist, 'server/chunks/_b._.js'))).toBe(false);
    expect(existsSync(path.join(dist, 'server/chunks/_b._.js.map'))).toBe(false);
    expect(existsSync(path.join(dist, 'server/chunks/ssr/_c._.js'))).toBe(false);
    expect(await read('server/app/api/v1/x/route.js')).toBe(
      'R.c("server/chunks/_a._.js")\nR.c("server/chunks/_other._.js")\nR.c("server/chunks/_a._.js")',
    );
    expect(JSON.parse(await read('server/app/api/v1/x/route.js.nft.json'))).toEqual({
      version: 1,
      files: ['../../../../chunks/_a._.js'],
    });
  });

  it('does not touch a name that only ends like a duplicate', async () => {
    await put('server/chunks/_a._.js', graph);
    await put('server/chunks/_b._.js', graph);
    await put('server/chunks/x_b._.js', 'module.exports=[3,t=>{}];');
    await put('server/app/route.js', 'R.c("server/chunks/x_b._.js")');

    await dedupeServerChunks(dist);

    expect(await read('server/app/route.js')).toBe('R.c("server/chunks/x_b._.js")');
  });

  it('changes nothing when every chunk is distinct', async () => {
    await put('server/chunks/_a._.js', graph);
    await put('server/app/route.js', 'R.c("server/chunks/_a._.js")');

    expect(await dedupeServerChunks(dist)).toEqual({ removed: 0, bytes: 0 });
  });
});
