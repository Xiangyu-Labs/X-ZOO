/**
 * What the client costs a mini-program, and what it must never bring along.
 *
 * esbuild bundles small consumers of the package the way an app would
 * (minified, ES2017, the package resolved by its own name) and the output is
 * inspected: which source files went in (esbuild's metafile) and what text
 * came out. The validate entry is bundled too, as the control: it *must* pull
 * in zod and the contracts, which proves the checks can see them.
 */
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { build, type Metafile } from 'esbuild';
import { describe, expect, it } from 'vitest';

const pkgRoot = path.resolve(import.meta.dirname, '..');
/** Metafile paths are relative to this, so a contract shows up as `packages/contracts/...`. */
const repoRoot = path.resolve(pkgRoot, '../..');

interface Bundle {
  code: string;
  inputs: string[];
  bytes: number;
  gzip: number;
}

async function bundle(source: string, external: string[] = []): Promise<Bundle> {
  const result = await build({
    stdin: { contents: source, resolveDir: pkgRoot, loader: 'ts', sourcefile: 'consumer.ts' },
    absWorkingDir: repoRoot,
    bundle: true,
    minify: true,
    target: 'es2017',
    format: 'esm',
    platform: 'neutral',
    mainFields: ['module', 'main'],
    external,
    write: false,
    metafile: true,
    logLevel: 'silent',
  });
  const code = result.outputFiles[0]?.text ?? '';
  const inputs = Object.keys((result.metafile as Metafile).inputs);
  return { code, inputs, bytes: Buffer.byteLength(code), gzip: gzipSync(code).byteLength };
}

/** A page's worth of calls: the client, the Taro transport, five routes. */
const SAMPLE = `
import { createApiClient, taroTransport, isApiError } from '@shop/api-client';
declare const wx: { request: any; getStorageSync(key: string): string };
const client = createApiClient({
  baseUrl: 'https://shop.example',
  transport: taroTransport(wx.request),
  platform: 'wechat-mini',
  clientVersion: '1.0.0',
  getToken: () => wx.getStorageSync('token'),
  onUnauthorized: () => wx.getStorageSync('login'),
});
export const home = () => client.call('decor.pageHome');
export const products = (keyword: string) => client.call('catalog.productList', { query: { keyword } });
export const product = (id: string) => client.call('catalog.productDetail', { params: { id } });
export const addToCart = (skuId: string) => client.call('cart.addItem', { body: { skuId, quantity: 1 } });
export const createOrder = (body: any) => client.call('order.create', { body });
export { isApiError };
`;

const EVERYTHING = `export * from '@shop/api-client';`;

const REACT_SAMPLE = `
export { ApiClientProvider, useRouteQuery, useInfiniteRouteQuery, useRouteMutation, invalidateRoutes } from '@shop/api-client/react';
`;

/** The page catalogue alone, the way the mini-program's `platform/nav.ts` takes it. */
const ROUTES_SAMPLE = `
import { storefrontRoutes, type StorefrontRoute } from '@shop/api-client/routes';
export const pathOf = (r: StorefrontRoute) => storefrontRoutes[r.route].path;
export { storefrontRoutes };
`;

const VALIDATE = `export { contractValidator } from '@shop/api-client/validate';`;

/** Things that must not reach a mini-program bundle, by the file they come from. */
const FORBIDDEN_INPUTS: ReadonlyArray<[RegExp, string]> = [
  [/node_modules\/zod\//, 'zod'],
  [/packages\/contracts\//, 'a contract module'],
  [/\/validate\.ts$/, 'the validate entry'],
  [/@tarojs/, 'Taro'],
];

/** ...and by the text they would leave behind. */
const FORBIDDEN_TEXT: ReadonlyArray<[RegExp, string]> = [
  [/_zod|ZodError|\$ZodType/, 'zod'],
  [/\/admin-api/, 'an admin path'],
  [/\/staff\//, 'a staff path'],
  [/new Function\s*\(/, 'new Function'],
  [/(^|[^.\w$])eval\s*\(/, 'eval'],
  // APIs newer than the oldest mini-program JS engines, which esbuild's
  // `target` lowers syntax for but cannot polyfill.
  [
    /Object\.fromEntries|\.flatMap\(|\.replaceAll\(|structuredClone|Promise\.allSettled/,
    'an ES2019+ API',
  ],
  [/URLSearchParams|new URL\(/, 'URL / URLSearchParams (absent in the mini-program runtime)'],
];

function assertMiniSafe(result: Bundle): void {
  for (const [pattern, what] of FORBIDDEN_INPUTS) {
    expect(
      result.inputs.filter((file) => pattern.test(file)),
      `bundle includes ${what}`,
    ).toEqual([]);
  }
  for (const [pattern, what] of FORBIDDEN_TEXT) {
    expect(pattern.exec(result.code)?.[0], `bundle contains ${what}`).toBeUndefined();
  }
}

function report(name: string, result: Bundle): void {
  const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
  console.log(
    `[bundle] ${name.padEnd(34)} ${kb(result.bytes).padStart(9)} min  ${kb(result.gzip).padStart(8)} gzip  (${result.inputs.length} input files)`,
  );
}

describe('bundle', () => {
  it('a sample consumer (client, Taro transport, 5 routes) carries no zod, no contract, no admin or staff path', async () => {
    const result = await bundle(SAMPLE);
    report('sample consumer (5 routes)', result);
    assertMiniSafe(result);
    expect(result.code).toContain('/api/v1/catalog/products');
    expect(result.bytes).toBeLessThan(40 * 1024);
  });

  it('the whole main entry, every export, is just as clean', async () => {
    const result = await bundle(EVERYTHING);
    report('main entry, everything', result);
    assertMiniSafe(result);
    expect(result.code).toContain('packages/order/detail/index');
  });

  it('the page catalogue (`@shop/api-client/routes`) is plain data: no zod, no contract', async () => {
    const result = await bundle(ROUTES_SAMPLE);
    report('page catalogue (routes entry)', result);
    assertMiniSafe(result);
    expect(result.code).toContain('packages/order/detail/index');
    expect(result.code).toContain('packages/account/reviews/index');
    expect(result.bytes).toBeLessThan(8 * 1024);
  });

  it('the react entry, with react and TanStack Query left to the app, is just as clean', async () => {
    const result = await bundle(REACT_SAMPLE, ['react', '@tanstack/react-query']);
    report('react entry (react, tanstack external)', result);
    assertMiniSafe(result);
  });

  it('the validate entry does carry zod and the contracts: the checks above can see them', async () => {
    const result = await bundle(VALIDATE);
    report('validate entry (control)', result);
    expect(result.inputs.some((file) => /node_modules\/zod\//.test(file))).toBe(true);
    expect(result.inputs.some((file) => /packages\/contracts\//.test(file))).toBe(true);
    expect(result.code).toMatch(/\/admin-api/);
  });
});
