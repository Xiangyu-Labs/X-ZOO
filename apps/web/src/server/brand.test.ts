import { anonymousActor, createCtx, type Ctx } from '@shop/core/kernel';
import { describe, expect, it, vi } from 'vitest';

import { brandData } from './brand';

/**
 * The logos the admin layout reads for every page, the login page included.
 * The config service is a stand-in: nothing here reaches a database.
 */

function ctxWith(site: Record<string, unknown> | 'down') {
  const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
  const config = {
    get: async (group: { schema: { parse(v: unknown): unknown } }) => {
      if (site === 'down') throw new Error('database down');
      return group.schema.parse(site);
    },
  };
  const ctx = createCtx({
    config,
    logger,
    actor: anonymousActor,
    platform: null,
    requestId: 'test',
  } as unknown as Parameters<typeof createCtx>[0]) as Ctx;
  return { ctx, logger };
}

describe('the admin brand', () => {
  it('hands the layout 后台 Logo, 方形 Logo and 浏览器图标 as configured', async () => {
    const { ctx } = ctxWith({
      logo: ' /uploads/logo.png ',
      logoSquare: '/uploads/square.png',
      loginLogo: '/uploads/mini-login.png',
      favicon: '/uploads/favicon.png',
    });
    expect(await brandData(ctx)).toEqual({
      logo: '/uploads/logo.png',
      square: '/uploads/square.png',
      favicon: '/uploads/favicon.png',
    });
  });

  it('reads an empty field as not set, so the default mark shows', async () => {
    const { ctx } = ctxWith({ logo: '   ' });
    expect(await brandData(ctx)).toEqual({ logo: null, square: null, favicon: null });
  });

  it('falls back to the default mark, with a warning, when the settings cannot be read', async () => {
    const { ctx, logger } = ctxWith('down');
    expect(await brandData(ctx)).toEqual({ logo: null, square: null, favicon: null });
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
