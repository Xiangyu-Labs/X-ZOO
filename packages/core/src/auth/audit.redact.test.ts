import { describe, expect, it } from 'vitest';
import { redactPayload } from './audit.repo';

/**
 * What the operation log keeps of a request body, pinned.
 *
 * `configSaveBody` nests every field under `values`, so a redaction that
 * stripped its list of keys at the top level only would let
 * `PUT /admin-api/system/config/payment` write the merchant private key and the
 * APIv3 key into `audit_logs` in the clear, where anybody holding the audit-log
 * read atom can read them. So redaction recurses, and strips every field the
 * config registry marks secret as well as its own key list.
 */

const API_V3_KEY = 'APIV3-MARKER-0123456789abcdef0123';
const PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----MARKER';

describe('what the operation log keeps of a request body', () => {
  it('redacts a credential at the top level', () => {
    const written = redactPayload({ account: 'ops', password: 'hunter2-marker' });
    expect(written).not.toContain('hunter2-marker');
    expect(written).toContain('ops');
  });

  it('redacts the same credential one level down, as the config form sends it', () => {
    const written = redactPayload({
      values: { mchId: '1900000109', apiV3Key: API_V3_KEY, merchantPrivateKey: PRIVATE_KEY },
    });
    expect(written).not.toContain(API_V3_KEY);
    expect(written).not.toContain(PRIVATE_KEY);
  });

  it('redacts inside arrays and at any depth up to the cap', () => {
    const written = redactPayload({
      rows: [{ nested: { deeper: { secret: 'arr-marker-1' } } }, { apiV3Key: 'arr-marker-2' }],
      keep: [1, 'two', { three: 3 }],
    });
    expect(written).not.toContain('arr-marker-1');
    expect(written).not.toContain('arr-marker-2');
    expect(written).toContain('"keep":[1,"two",{"three":3}]');
  });

  it('matches credential names case-insensitively and by shape', () => {
    const written = redactPayload({ Password: 'p-marker', smtp: { userPassword: 'u-marker' } });
    expect(written).not.toContain('p-marker');
    expect(written).not.toContain('u-marker');
  });

  it('strips a field the config registry marks secret, whatever it is called', async () => {
    const { defineConfigGroup, getConfigGroup } = await import('../kernel/config-registry');
    const { z } = await import('zod');
    if (!getConfigGroup('redact-probe')) {
      defineConfigGroup({
        group: 'redact-probe',
        title: 'probe',
        schema: z.object({ opaqueField: z.string().default(''), plain: z.string().default('') }),
        ui: {
          opaqueField: { label: 'x', type: 'text', secret: true },
          plain: { label: 'y', type: 'text' },
        },
      });
    }
    const written = redactPayload({ values: { opaqueField: 'reg-marker', plain: 'visible' } });
    expect(written).not.toContain('reg-marker');
    expect(written).toContain('visible');
  });

  it('caps the depth instead of walking a hostile body for ever', () => {
    let deep: Record<string, unknown> = { leaf: 'x' };
    for (let level = 0; level < 50; level += 1) deep = { d: deep };
    expect(redactPayload(deep)).toContain('[truncated]');
  });
});
