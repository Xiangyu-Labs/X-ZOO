#!/usr/bin/env tsx
/**
 * `pnpm --filter @shop/testing mock -- --port 4010`
 *
 * Serves every registered contract from its examples. The mini program and admin
 * clients develop against this before any handler exists.
 */
import { allRoutes } from '@shop/contracts/routes';
import { startMockServer } from './index';

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string): string | undefined => {
  const at = args.indexOf(`--${name}`);
  if (at >= 0 && args[at + 1]) return args[at + 1];
  const inline = args.find((a) => a.startsWith(`--${name}=`));
  return inline ? inline.slice(name.length + 3) : fallback;
};

const port = Number(flag('port', process.env.MOCK_PORT ?? '4010'));
const host = flag('host', '127.0.0.1')!;
const verbose = args.includes('--verbose');

const running = await startMockServer({ port, host, verbose });

console.log(`mock server listening on ${running.url}`);
console.log(`  ${allRoutes.length} route(s); GET ${running.url}/__mock/routes lists them`);
console.log(`  select an example with the  X-Mock-Example: <name>  request header`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void running.close().then(() => process.exit(0));
  });
}
