/**
 * In-memory server for the kit demo.
 *
 * Installed through `configureApi({ fetch })` when this module is imported on
 * the client — i.e. only on `/admin/dev/kit`, because that is the only route
 * that imports it. Anything that is not a `/admin-api/dev-demo/` URL is passed
 * straight to the previously configured fetch, so the rest of the admin (the
 * session, the notification stream) keeps working while the demo is open.
 */
import { configureApi, getApiConfig } from '@/admin/api/config';

import type { DemoWidget } from './demo-contract';

const NAMES = [
  '轮播图',
  '商品列表',
  '优惠券组件',
  '标题栏',
  '富文本块',
  '图片魔方',
  '公告栏',
  '拼团位',
];

function placeholder(label: string, hue: number): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="hsl(${hue} 55% 78%)"/><text x="50%" y="54%" font-family="sans-serif" font-size="16" fill="hsl(${hue} 70% 22%)" text-anchor="middle">${label}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const STATUSES = ['draft', 'active', 'paused', 'archived'] as const;

let nextId = 1;
const widgets: DemoWidget[] = Array.from({ length: 37 }, (_, index) => {
  const id = String(nextId++);
  return {
    id,
    name: `${NAMES[index % NAMES.length]} ${index + 1}`,
    image: placeholder(String(index + 1), (index * 41) % 360),
    price: `${10 + index * 3}.${String((index * 7) % 100).padStart(2, '0')}`,
    status: STATUSES[index % STATUSES.length] ?? 'draft',
    quantity: (index * 13) % 120,
    createdAt: new Date(Date.UTC(2026, 0, 1 + index, 2, 0, 0)).toISOString(),
  };
});

const configValues: Record<string, unknown> = {
  siteName: '示例商城',
  contactPhone: '400-000-0000',
  // A `password` field's value is a boolean "is set" flag — never the secret.
  apiSecret: true,
  smsSecret: false,
  deliveryMode: 'express',
  freeShippingOver: '99.00',
  enableInvoice: true,
  maxPerOrder: 5,
  logo: placeholder('LOGO', 210),
  extra: '{\n  "demo": true\n}',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function fail(status: number, code: string, message: string, details?: unknown): Response {
  return json(details === undefined ? { code, message } : { code, message, details }, status);
}

function compare(a: DemoWidget, b: DemoWidget, field: string): number {
  if (field === 'price') return Number(a.price) - Number(b.price);
  if (field === 'quantity') return a.quantity - b.quantity;
  if (field === 'createdAt') return a.createdAt.localeCompare(b.createdAt);
  if (field === 'name') return a.name.localeCompare(b.name);
  return Number(a.id) - Number(b.id);
}

function handle(url: URL, init: RequestInit | undefined): Response | null {
  const path = url.pathname;
  const method = (init?.method ?? 'GET').toUpperCase();
  const body =
    typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;

  if (path === '/admin-api/dev-demo/widgets' && method === 'GET') {
    const q = url.searchParams;
    const page = Number(q.get('page') ?? '1');
    const pageSize = Number(q.get('pageSize') ?? '20');
    const keyword = q.get('keyword')?.trim();
    const statuses = q.getAll('status');
    const minQuantity = q.get('minQuantity');
    const from = q.get('createdFrom');
    const to = q.get('createdTo');

    let items = widgets.filter((widget) => {
      if (keyword && !widget.name.includes(keyword)) return false;
      if (statuses.length > 0 && !statuses.includes(widget.status)) return false;
      if (minQuantity && widget.quantity < Number(minQuantity)) return false;
      if (from && widget.createdAt < from) return false;
      if (to && widget.createdAt > to) return false;
      return true;
    });

    const sortBy = q.get('sortBy');
    if (sortBy) {
      const dir = q.get('sortOrder') === 'desc' ? -1 : 1;
      items = items.slice().sort((a, b) => compare(a, b, sortBy) * dir);
    }

    const start = (page - 1) * pageSize;
    return json({
      items: items.slice(start, start + pageSize),
      total: items.length,
      page,
      pageSize,
    });
  }

  if (path === '/admin-api/dev-demo/widgets' && method === 'POST') {
    const invalid = validate(body);
    if (invalid) return invalid;
    const created: DemoWidget = {
      id: String(nextId++),
      name: String(body?.['name'] ?? ''),
      image: typeof body?.['image'] === 'string' ? body['image'] : placeholder('新', 140),
      price: String(body?.['price'] ?? '0.00'),
      status: (body?.['status'] as DemoWidget['status']) ?? 'draft',
      quantity: Number(body?.['quantity'] ?? 0),
      createdAt: new Date().toISOString(),
    };
    widgets.unshift(created);
    return json(created, 201);
  }

  const single = /^\/admin-api\/dev-demo\/widgets\/(\d+)$/.exec(path);
  if (single) {
    const widgetId = single[1]!;
    const index = widgets.findIndex((widget) => widget.id === widgetId);
    if (index < 0) return fail(404, 'NOT_FOUND', '资源不存在');

    if (method === 'PUT') {
      const invalid = validate(body);
      if (invalid) return invalid;
      const existing = widgets[index]!;
      const updated: DemoWidget = {
        ...existing,
        name: String(body?.['name'] ?? existing.name),
        price: String(body?.['price'] ?? existing.price),
        status: (body?.['status'] as DemoWidget['status']) ?? existing.status,
        quantity: Number(body?.['quantity'] ?? existing.quantity),
        ...(typeof body?.['image'] === 'string' ? { image: body['image'] } : {}),
      };
      widgets[index] = updated;
      return json(updated);
    }

    if (method === 'DELETE') {
      widgets.splice(index, 1);
      return json({ ok: true });
    }
  }

  const config = /^\/admin-api\/dev-demo\/config\/([\w-]+)$/.exec(path);
  if (config) {
    const group = config[1]!;
    if (method === 'GET') return json({ group, values: configValues });
    if (method === 'PUT') {
      const patch = (body?.['values'] ?? {}) as Record<string, unknown>;
      for (const [key, value] of Object.entries(patch)) {
        // Mirrors the real behaviour: a secret arrives only when retyped, and
        // what we store back into `values` is the boolean "is set" flag.
        configValues[key] = key.endsWith('Secret') ? value !== '' : value;
      }
      return json({ ok: true });
    }
  }

  return null;
}

/** The demo's one deliberate failure path, to show 422 mapping onto fields. */
function validate(body: Record<string, unknown> | undefined): Response | null {
  if (body?.['name'] === '422') {
    return fail(422, 'VALIDATION_FAILED', '提交的数据有误', [
      { field: 'name', message: '这个名称已被占用（来自服务端的 422 演示）' },
    ]);
  }
  return null;
}

let installed = false;

export function installDemoFetch(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const previous = getApiConfig().fetch;

  configureApi({
    async fetch(input, init) {
      const href =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(href, window.location.origin);
      if (url.pathname.startsWith('/admin-api/dev-demo/')) {
        // A little latency so loading states are visible.
        await new Promise((resolve) => setTimeout(resolve, 180));
        const response = handle(url, init);
        if (response) return response;
        return fail(404, 'NOT_FOUND', '资源不存在');
      }
      return previous(input, init);
    },
  });
}
