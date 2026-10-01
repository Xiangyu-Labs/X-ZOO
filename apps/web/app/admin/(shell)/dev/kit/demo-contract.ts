/**
 * Fake contracts for the kit demo.
 *
 * They are real `defineRoute` definitions — same validation, same conventions —
 * but under `/admin-api/dev-demo/*`, which no handler serves. The demo page
 * installs an in-memory fetch that answers them (see `mock-fetch.ts`).
 *
 * Nothing outside `app/admin/(shell)/dev/kit/` may import this file.
 */
import { defineRoute, id, instant, money, paged, pageQuery } from '@shop/contracts';
import { z } from 'zod';

export const demoStatus = z.enum(['draft', 'active', 'paused', 'archived']);

export const demoWidget = z.object({
  id,
  name: z.string(),
  image: z.string().optional(),
  price: money,
  status: demoStatus,
  quantity: z.number().int(),
  createdAt: instant,
});
export type DemoWidget = z.infer<typeof demoWidget>;

export const demoWidgetForm = z.object({
  name: z.string().min(2, '名称至少 2 个字').max(30, '名称最多 30 个字'),
  price: money,
  quantity: z.coerce.number().int().min(0, '数量不能为负').default(0),
  status: demoStatus.default('draft'),
  enabled: z.boolean().default(true),
  categoryId: z.string().optional(),
  area: z.array(z.string()).optional(),
  tags: z.array(z.string()).default([]),
  channel: z.enum(['h5', 'mini', 'oa']).default('h5'),
  image: z.string().optional(),
  gallery: z.array(z.string()).default([]),
  publishedAt: instant.optional(),
  window: z.tuple([instant, instant]).optional(),
  link: z.object({ type: z.string(), label: z.string(), url: z.string() }).optional(),
  slides: z.array(z.object({ title: z.string(), url: z.string() })).default([]),
  note: z.string().max(200, '备注最多 200 字').optional(),
  description: z.string().optional(),
});
export type DemoWidgetForm = z.input<typeof demoWidgetForm>;

const exampleWidget = {
  id: '1',
  name: '示例组件',
  price: '99.00',
  status: 'active',
  quantity: 12,
  createdAt: '2026-03-01T10:00:00+08:00',
};

export const demoWidgetList = defineRoute({
  id: 'devDemo.widgetList',
  method: 'GET',
  path: '/admin-api/dev-demo/widgets',
  auth: 'admin',
  permission: 'dev:demo:list',
  summary: '演示：组件列表',
  tags: ['dev-demo'],
  query: pageQuery.extend({
    keyword: z.string().optional(),
    status: z.union([demoStatus, z.array(demoStatus)]).optional(),
    minQuantity: z.coerce.number().int().optional(),
    createdFrom: instant.optional(),
    createdTo: instant.optional(),
    sortBy: z.string().optional(),
    sortOrder: z.enum(['asc', 'desc']).optional(),
  }),
  response: paged(demoWidget),
  examples: [
    { name: '第一页', response: { items: [exampleWidget], total: 1, page: 1, pageSize: 20 } },
  ],
});

export const demoWidgetCreate = defineRoute({
  id: 'devDemo.widgetCreate',
  method: 'POST',
  path: '/admin-api/dev-demo/widgets',
  auth: 'admin',
  permission: 'dev:demo:create',
  summary: '演示：新建组件',
  tags: ['dev-demo'],
  body: demoWidgetForm,
  response: demoWidget,
  status: 201,
  examples: [{ name: '成功', body: { name: '示例组件', price: '99.00' }, response: exampleWidget }],
});

export const demoWidgetUpdate = defineRoute({
  id: 'devDemo.widgetUpdate',
  method: 'PUT',
  path: '/admin-api/dev-demo/widgets/:id',
  auth: 'admin',
  permission: 'dev:demo:update',
  summary: '演示：编辑组件',
  tags: ['dev-demo'],
  params: z.object({ id }),
  body: demoWidgetForm,
  response: demoWidget,
  examples: [
    {
      name: '成功',
      params: { id: '1' },
      body: { name: '示例组件', price: '99.00' },
      response: exampleWidget,
    },
  ],
});

export const demoWidgetDelete = defineRoute({
  id: 'devDemo.widgetDelete',
  method: 'DELETE',
  path: '/admin-api/dev-demo/widgets/:id',
  auth: 'admin',
  permission: 'dev:demo:delete',
  summary: '演示：删除组件',
  tags: ['dev-demo'],
  params: z.object({ id }),
  response: z.object({ ok: z.literal(true) }),
  examples: [{ name: '成功', params: { id: '1' }, response: { ok: true } }],
});

export const demoConfigGet = defineRoute({
  id: 'devDemo.configGet',
  method: 'GET',
  path: '/admin-api/dev-demo/config/:group',
  auth: 'admin',
  permission: 'dev:demo:config',
  summary: '演示：读取配置组',
  tags: ['dev-demo'],
  params: z.object({ group: z.string() }),
  response: z.object({ group: z.string(), values: z.record(z.string(), z.unknown()) }),
  examples: [
    {
      name: '成功',
      params: { group: 'demo' },
      response: { group: 'demo', values: { siteName: '示例商城' } },
    },
  ],
});

export const demoConfigSave = defineRoute({
  id: 'devDemo.configSave',
  method: 'PUT',
  path: '/admin-api/dev-demo/config/:group',
  auth: 'admin',
  permission: 'dev:demo:config',
  summary: '演示：保存配置组',
  tags: ['dev-demo'],
  params: z.object({ group: z.string() }),
  body: z.object({ values: z.record(z.string(), z.unknown()) }),
  response: z.object({ ok: z.literal(true) }),
  examples: [
    { name: '成功', params: { group: 'demo' }, body: { values: {} }, response: { ok: true } },
  ],
});
