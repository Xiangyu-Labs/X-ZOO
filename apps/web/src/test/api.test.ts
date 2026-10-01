import { defineRoute, id, pageQuery } from '@shop/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { callRoute } from '@/admin/api/call-route';
import { resetApiConfig } from '@/admin/api/config';

import { on, respondWith, respondWithError, stubRoutes, takeFixtureFailures } from './api';

const widget = z.object({ id, name: z.string(), note: z.string().nullable() });

const widgetDetail = defineRoute({
  id: 'test.widgetDetail',
  method: 'GET',
  path: '/admin-api/widgets/:id',
  auth: 'admin',
  permission: 'test:widget:read',
  summary: '详情',
  tags: ['test'],
  params: z.object({ id }),
  response: widget,
  examples: [{ name: 'ok', params: { id: '1' }, response: { id: '1', name: 'a', note: null } }],
});

const widgetDelete = defineRoute({
  id: 'test.widgetDelete',
  method: 'DELETE',
  path: '/admin-api/widgets/:id',
  auth: 'admin',
  permission: 'test:widget:delete',
  summary: '删除',
  tags: ['test'],
  params: z.object({ id }),
  response: z.void(),
  status: 204,
  examples: [{ name: 'ok', params: { id: '1' }, response: undefined }],
});

const widgetRename = defineRoute({
  id: 'test.widgetRename',
  method: 'PUT',
  path: '/admin-api/widgets/:id',
  auth: 'admin',
  permission: 'test:widget:write',
  summary: '改名',
  tags: ['test'],
  params: z.object({ id }),
  body: z.object({ name: z.string().min(1) }),
  response: widget,
  examples: [
    {
      name: 'ok',
      params: { id: '1' },
      body: { name: 'b' },
      response: { id: '1', name: 'b', note: null },
    },
  ],
});

const widgetList = defineRoute({
  id: 'test.widgetList',
  method: 'GET',
  path: '/admin-api/widgets',
  auth: 'admin',
  permission: 'test:widget:read',
  summary: '列表',
  tags: ['test'],
  query: pageQuery,
  response: z.object({ items: z.array(widget) }),
  errors: ['WIDGET_LOCKED'],
  examples: [{ name: 'ok', response: { items: [] } }],
});

afterEach(() => {
  resetApiConfig();
  // These tests provoke failures on purpose; do not let `setup.ts` report them.
  takeFixtureFailures();
});

describe('respondWith', () => {
  it('answers with the fixture when it matches the contract', async () => {
    const response = respondWith(widgetDetail, { id: '7', name: '组件', note: null });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: '7', name: '组件', note: null });
  });

  it('names the missing field when the fixture does not match', () => {
    // @ts-expect-error -- the point: `note` is required
    expect(() => respondWith(widgetDetail, { id: '7', name: '组件' })).toThrow(
      /test\.widgetDetail does not match its contract:\n {2}- note:/,
    );
    expect(takeFixtureFailures()).toHaveLength(1);
  });

  it('names a key the contract does not declare', () => {
    const fixture = { id: '7', name: '组件', note: null, retiredCode: 'x' };
    expect(() => respondWith(widgetDetail, fixture)).toThrow(
      /does not declare:\n {2}- retiredCode/,
    );
  });

  it('sends no body for a 204 route', async () => {
    const response = respondWith(widgetDelete, undefined);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
  });

  it('checks an error body against the error envelope', async () => {
    const response = respondWithError(409, { code: 'WIDGET_TAKEN', message: '已存在' });
    expect(response.status).toBe(409);
    // @ts-expect-error -- `message` is required on every error
    expect(() => respondWithError(500, { code: 'INTERNAL' })).toThrow(/a 500 error/);
  });
});

describe('stubRoutes', () => {
  it('routes by method and path and records path params', async () => {
    const calls = stubRoutes([
      on(widgetDelete, undefined),
      on(widgetDetail, (call) => ({ id: call.params.id ?? '', name: '组件', note: null })),
    ]);

    await expect(callRoute(widgetDetail, { params: { id: '9' } })).resolves.toEqual({
      id: '9',
      name: '组件',
      note: null,
    });
    await callRoute(widgetDelete, { params: { id: '9' } });

    expect(calls.map((call) => [call.method, call.routeId, call.params])).toEqual([
      ['GET', 'test.widgetDetail', { id: '9' }],
      ['DELETE', 'test.widgetDelete', { id: '9' }],
    ]);
  });

  it('fails the test when a request has no stub, even though the client swallows it', async () => {
    stubRoutes([on(widgetDelete, undefined)]);
    await expect(callRoute(widgetDetail, { params: { id: '9' } })).rejects.toMatchObject({
      status: 502,
    });
    expect(takeFixtureFailures()).toEqual(['no stub answers GET /admin-api/widgets/9']);
  });

  it('records a wrong fixture even when the client turns the throw into a network error', async () => {
    // @ts-expect-error -- `note` is missing
    stubRoutes([on(widgetDetail, { id: '1', name: '组件' })]);
    await expect(callRoute(widgetDetail, { params: { id: '1' } })).rejects.toMatchObject({
      status: 0,
    });
    expect(takeFixtureFailures()).toEqual([expect.stringContaining('- note:')]);
  });

  describe('request bodies', () => {
    const renamed = { id: '1', name: 'b', note: null };

    it('passes a body the contract accepts through to the stub', async () => {
      const calls = stubRoutes([on(widgetRename, renamed)]);
      await expect(
        callRoute(widgetRename, { params: { id: '1' }, body: { name: 'b' } }),
      ).resolves.toEqual(renamed);
      expect(calls[0]?.body).toEqual({ name: 'b' });
      expect(takeFixtureFailures()).toEqual([]);
    });

    it('fails the test, and answers 422, when the body breaks the contract', async () => {
      stubRoutes([on(widgetRename, renamed)]);
      await expect(
        callRoute(widgetRename, { params: { id: '1' }, body: { name: '' } }),
      ).rejects.toMatchObject({ status: 422 });
      expect(takeFixtureFailures()).toEqual([
        expect.stringMatching(/request body for test\.widgetRename does not match[\s\S]*- name:/),
      ]);
    });

    it('fails the test when the body carries a key the contract does not declare', async () => {
      stubRoutes([on(widgetRename, renamed)]);
      const body = { name: 'b', retiredCode: 'x' } as { name: string };
      await expect(callRoute(widgetRename, { params: { id: '1' }, body })).rejects.toMatchObject({
        status: 422,
      });
      expect(takeFixtureFailures()).toEqual([
        expect.stringMatching(/does not declare:\n {2}- retiredCode/),
      ]);
    });
  });

  describe('query strings and path params', () => {
    it('passes a query the contract accepts', async () => {
      stubRoutes([on(widgetList, { items: [] })]);
      await callRoute(widgetList, { query: { page: 1, pageSize: 100 } });
      expect(takeFixtureFailures()).toEqual([]);
    });

    it('fails the test, and answers 422, for a pageSize over the cap', async () => {
      stubRoutes([on(widgetList, { items: [] })]);
      await expect(
        callRoute(widgetList, { query: { page: 1, pageSize: 200 } }),
      ).rejects.toMatchObject({ status: 422 });
      expect(takeFixtureFailures()).toEqual([
        expect.stringMatching(/query for test\.widgetList does not match[\s\S]*- pageSize:/),
      ]);
    });

    it('fails the test for a path param the contract refuses', async () => {
      stubRoutes([on(widgetDetail, { id: '1', name: 'a', note: null })]);
      await expect(callRoute(widgetDetail, { params: { id: 'abc' } })).rejects.toMatchObject({
        status: 422,
      });
      expect(takeFixtureFailures()).toEqual([
        expect.stringMatching(/path params for test\.widgetDetail/),
      ]);
    });
  });

  describe('error replies', () => {
    it('accepts a declared code, and a code any route may give', async () => {
      stubRoutes([
        on(widgetList, () => respondWithError(409, { code: 'WIDGET_LOCKED', message: '锁定' })),
        on(widgetDetail, () => respondWithError(404, { code: 'NOT_FOUND', message: '不存在' })),
      ]);
      await expect(callRoute(widgetList, { query: {} })).rejects.toMatchObject({ status: 409 });
      await expect(callRoute(widgetDetail, { params: { id: '1' } })).rejects.toMatchObject({
        status: 404,
      });
      expect(takeFixtureFailures()).toEqual([]);
    });

    it('fails the test for a code the route does not declare', async () => {
      stubRoutes([
        on(widgetDetail, () => respondWithError(409, { code: 'WIDGET_LOCKED', message: '锁定' })),
      ]);
      await expect(callRoute(widgetDetail, { params: { id: '1' } })).rejects.toMatchObject({
        status: 409,
      });
      expect(takeFixtureFailures()).toEqual([
        expect.stringMatching(/test\.widgetDetail does not declare WIDGET_LOCKED/),
      ]);
    });

    it('fails the test for a registered code answered with another status', async () => {
      stubRoutes([
        on(widgetDetail, () => respondWithError(500, { code: 'NOT_FOUND', message: '不存在' })),
      ]);
      await expect(callRoute(widgetDetail, { params: { id: '1' } })).rejects.toMatchObject({
        status: 500,
      });
      expect(takeFixtureFailures()).toEqual([expect.stringMatching(/NOT_FOUND is a 404/)]);
    });
  });
});
