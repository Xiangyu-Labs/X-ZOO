/**
 * Runs ESLint with the TypeScript 6 API.
 *
 * WHY THIS EXISTS
 * typescript-eslint 8.70 (the newest release, and the one `eslint-config-next`
 * depends on) throws on startup when `require('typescript').versionMajorMinor`
 * is 7.x:
 *
 *   "typescript-eslint does not support TS 7.0. […] run typescript-eslint using
 *    the TS 6 API." — tracked in typescript-eslint#10940
 *
 * The vendor-recommended fix is exactly what this script does: install
 * TypeScript 6 side by side (here as the `typescript-6` alias) and make the
 * parser resolve *that* copy, while `pnpm typecheck` keeps using TypeScript 7.
 * Only the lint rules' view of the AST comes from TS 6; nothing we ship does.
 *
 * DELETE THIS when typescript-eslint supports TS >= 7.1: drop the shim, the
 * `typescript-6` devDependency, and point `lint` back at `eslint .`.
 *
 * The orchestrator should fold the same workaround into `@shop/config`'s shared
 * ESLint preset rather than copying this file per package.
 */
import Module from 'node:module';
import { createRequire } from 'node:module';
import process from 'node:process';

const require = createRequire(import.meta.url);
const typescript6 = require.resolve('typescript-6');

const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function patched(request, ...rest) {
  if (request === 'typescript') return typescript6;
  if (request.startsWith('typescript/')) {
    return resolveFilename.call(
      this,
      `typescript-6/${request.slice('typescript/'.length)}`,
      ...rest,
    );
  }
  return resolveFilename.call(this, request, ...rest);
};

const { loadESLint } = await import('eslint');
const ESLint = await loadESLint({ useFlatConfig: true });
const eslint = new ESLint({ cwd: process.cwd() });

const targets = process.argv.slice(2);
const results = await eslint.lintFiles(targets.length > 0 ? targets : ['.']);
const formatter = await eslint.loadFormatter('stylish');
const output = await formatter.format(results);
if (output.trim() !== '') process.stdout.write(`${output}\n`);

const errors = results.reduce((sum, result) => sum + result.errorCount, 0);
const warnings = results.reduce((sum, result) => sum + result.warningCount, 0);
process.stdout.write(`eslint: ${results.length} files, ${errors} errors, ${warnings} warnings\n`);
process.exitCode = errors > 0 ? 1 : 0;
