#!/usr/bin/env node
// Container healthcheck for the `web` image.
//
// Liveness, not readiness: it asks the Next server whether it is serving, and
// nothing else. `apps/web/src/server/health.ts` explains why — a healthcheck
// that opens a PostgreSQL connection restarts the container when the database
// blips, turning a degradation into an outage. The deep check that gates a
// release lives in `deploy/lib/readiness.sh`, and nothing restarts a
// container on its answer.
//
// Zero dependencies on purpose: the runtime image holds only the Next
// standalone trace, so anything this script imports has to come from node
// itself.
import { get } from 'node:http';

const port = process.env.PORT ?? '3000';
const host = process.env.HEALTHCHECK_HOST ?? '127.0.0.1';
const path = process.env.HEALTHCHECK_PATH ?? '/api/v1/health';
const timeoutMs = Number(process.env.HEALTHCHECK_TIMEOUT_MS ?? '4000');

function fail(message) {
  process.stderr.write(`web healthcheck: ${message}\n`);
  process.exit(1);
}

const request = get({ host, port, path, timeout: timeoutMs }, (response) => {
  if (response.statusCode !== 200) {
    response.resume();
    fail(`GET ${path} answered ${response.statusCode}`);
    return;
  }
  let body = '';
  response.setEncoding('utf8');
  response.on('data', (chunk) => {
    body += chunk;
    // A health endpoint that streams megabytes is itself the fault.
    if (body.length > 8192) request.destroy(new Error('health response too large'));
  });
  response.on('end', () => {
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      fail(`GET ${path} did not answer JSON`);
      return;
    }
    if (payload?.status !== 'ok') {
      fail(`GET ${path} answered status=${String(payload?.status)}`);
      return;
    }
    process.stdout.write(`ok version=${String(payload.version)}\n`);
  });
});

request.on('timeout', () => request.destroy(new Error(`no answer within ${timeoutMs}ms`)));
request.on('error', (error) => fail(error.message));
