import { callRoute } from '../api/call-route';
import type { AnyRouteDef, ResponseOf } from '../api/contracts';

/**
 * `callRoute` for a single file.
 *
 * The kit's `callRoute` sends a `FormData` body itself, so all
 * this adds is the one-field form an upload route expects. It stays because
 * `uploadFile(route, input, file)` reads better at a call site than building a
 * `FormData` by hand, and because the field name is a server-side convention
 * (`readFilePart` in `core/storage/multipart.ts`), not the caller's choice.
 *
 * The upload routes declare no `body` schema and carry their options in
 * `query`: `handle()` parses only JSON bodies.
 */
export async function uploadFile<R extends AnyRouteDef>(
  route: R,
  input: {
    params?: Record<string, unknown> | undefined;
    query?: Record<string, unknown> | undefined;
  },
  file: File,
  options: { signal?: AbortSignal | undefined; fieldName?: string | undefined } = {},
): Promise<ResponseOf<R>> {
  const formData = new FormData();
  formData.append(options.fieldName ?? 'file', file, file.name);

  return callRoute(
    route,
    {
      ...(input.params === undefined ? {} : { params: input.params as never }),
      ...(input.query === undefined ? {} : { query: input.query as never }),
      formData,
    },
    options.signal ? { signal: options.signal } : {},
  );
}
