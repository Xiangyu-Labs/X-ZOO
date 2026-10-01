import { findRoute, isMultipart } from './catalog';

/**
 * Runs one operation against a shop over HTTP, as the admin the token names.
 *
 * Everything the console gets happens here too, because it is the same route:
 * validation, the permission check, the audit row. Nothing is re-implemented
 * on this side — the input is sent as given and the server's answer, including
 * its Chinese error message and field problems, is handed back verbatim for
 * the agent to read and correct.
 */

export interface OpsClient {
  /** `https://x-zoo.vip`, or `http://127.0.0.1:3000` from inside the app. */
  origin: string;
  /** `shp_…` */
  token: string;
  /** Extra headers, e.g. `x-real-ip` so the audit row keeps the caller's address. */
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}

export interface CallInput {
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: unknown;
}

export interface CallResult {
  ok: boolean;
  status: number;
  /** Parsed JSON, the text of a non-JSON answer (a CSV export), or `null` for 204. */
  data: unknown;
}

export class OperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OperationError';
  }
}

/**
 * `/admin-api/roles/:id` + `{ id: 3 }` → `/admin-api/roles/3`. A key the path
 * has no slot for is refused rather than dropped: it is almost always a query
 * or body field put in the wrong place, and the call would otherwise run
 * without it.
 */
export function fillPath(path: string, params: Record<string, unknown> = {}): string {
  const names = [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => match[1] as string);
  const extra = Object.keys(params).filter((key) => !names.includes(key));
  if (extra.length > 0) {
    throw new OperationError(
      `路径里没有参数 ${extra.join('、')}（这个操作的路径参数：${names.join('、') || '无'}）。筛选条件放 query，提交的内容放 body。`,
    );
  }
  return path.replace(/:([A-Za-z0-9_]+)/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined || value === null || value === '') {
      throw new OperationError(`缺少路径参数 ${name}`);
    }
    return encodeURIComponent(String(value));
  });
}

/** `undefined`, `null` and `{}` say nothing; some assistants send `{}` for every call. */
function isEmptyBody(body: unknown): boolean {
  return (
    body === undefined ||
    body === null ||
    (typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 0)
  );
}

/** Arrays repeat the key (`?tag=a&tag=b`), which is what `handle()` turns back into an array. */
export function toSearch(query: Record<string, unknown> = {}): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      search.append(key, typeof item === 'object' ? JSON.stringify(item) : String(item));
    }
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

const MAX_TEXT = 20_000;

export async function callOperation(
  client: OpsClient,
  id: string,
  input: CallInput = {},
): Promise<CallResult> {
  const route = findRoute(id);
  if (!route) throw new OperationError(`没有这个操作：${id}。先用搜索找到正确的 id。`);
  if (isMultipart(route.id)) {
    throw new OperationError(`${id} 需要上传文件，不能用 JSON 调用。`);
  }
  if (route.method === 'GET' && !isEmptyBody(input.body)) {
    throw new OperationError(`${id} 是读取操作（GET），不接受 body；筛选条件请放 query。`);
  }
  const url = `${client.origin.replace(/\/+$/, '')}${fillPath(route.path, input.params)}${toSearch(input.query)}`;
  const sendsBody = route.method !== 'GET' && input.body !== undefined;
  const response = await (client.fetch ?? fetch)(url, {
    method: route.method,
    headers: {
      authorization: `Bearer ${client.token}`,
      accept: 'application/json',
      ...(sendsBody ? { 'content-type': 'application/json' } : {}),
      ...client.headers,
    },
    ...(sendsBody ? { body: JSON.stringify(input.body) } : {}),
  });
  return { ok: response.ok, status: response.status, data: await readBody(response) };
}

export interface UploadInput {
  bytes: Uint8Array;
  filename: string;
  /** Optional: the server decides the type from the bytes, not from this. */
  contentType?: string;
  categoryId?: string;
  directory?: string;
}

/**
 * `storage.attachmentUpload` — the one operation that takes a file. Sent as
 * `multipart/form-data` with the part named `file`; the options ride in the
 * query string, as the route declares.
 */
export async function uploadFile(client: OpsClient, input: UploadInput): Promise<CallResult> {
  const route = findRoute('storage.attachmentUpload');
  if (!route) throw new OperationError('这个商城不支持上传素材');
  const form = new FormData();
  form.append(
    'file',
    // Copied into a plain ArrayBuffer: a Blob will not take a view of a shared one.
    new Blob([new Uint8Array(input.bytes)], input.contentType ? { type: input.contentType } : {}),
    input.filename,
  );
  const url = `${client.origin.replace(/\/+$/, '')}${route.path}${toSearch({
    categoryId: input.categoryId,
    directory: input.directory,
  })}`;
  const response = await (client.fetch ?? fetch)(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${client.token}`,
      accept: 'application/json',
      ...client.headers,
    },
    body: form,
  });
  return { ok: response.ok, status: response.status, data: await readBody(response) };
}

export async function readBody(response: Response): Promise<unknown> {
  if (response.status === 204) return null;
  const text = await response.text();
  if ((response.headers.get('content-type') ?? '').includes('application/json')) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      // fall through to text
    }
  }
  return text.length > MAX_TEXT
    ? `${text.slice(0, MAX_TEXT)}…（已截断，共 ${text.length} 字符）`
    : text;
}
