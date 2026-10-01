import { DomainError } from '../kernel/errors';
import type { IncomingFile } from './storage.service';

/**
 * Pulling the one file part out of a `multipart/form-data` request.
 *
 * `handle()` parses JSON bodies and nothing else, which is why the upload
 * contracts declare no `body` and carry their options in the query string. The
 * route therefore reads the form itself, and this is the shared half so that
 * four routes do not each invent their own field name and their own error.
 *
 * It lives in `core` rather than in the route because `FormData`, `File` and
 * `Blob` are web standards available in Node, not `next/*` imports — the
 * `boundaries` rule is about framework coupling, and there is none here.
 *
 * The field is `file` and only `file`. Accepting `image` and `multipart` too
 * would mean the contract could not state a name, and a client sending the
 * wrong one would silently work here and nowhere else. Extra file parts under
 * other names are ignored; a file under *only* another name is
 * `STORAGE_UPLOAD_FIELD_MISSING`.
 *
 * The filename is read but never used as a path: `Storage.put` takes it as a
 * *hint* and honours only a whitelisted extension.
 */

/**
 * The one field name the contract names. Anything else is a client bug, and
 * saying so beats the shopper re-picking the same photo.
 */
const FIELD_NAME = 'file';

/** Structural: any part that can hand back bytes is a file part. */
const isFilePart = (value: unknown): value is { arrayBuffer(): Promise<ArrayBuffer> } =>
  value !== null && typeof value === 'object' && 'arrayBuffer' in value;

/**
 * Room for the boundaries, the part headers and the odd text field on top of
 * the file itself. A form carrying more than this besides the file is not one
 * of ours.
 */
export const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

/** What `readFilePart` needs of a request. `Request`/`NextRequest` fit. */
export interface MultipartRequest {
  formData(): Promise<FormData>;
  headers?: { get(name: string): string | null };
  body?: ReadableStream<Uint8Array> | null;
}

export interface ReadFilePartOptions {
  /** The file ceiling that applies to this caller; the body may carry this plus the overhead. */
  maxBytes: number;
}

/**
 * Reads the body — and **refuses before buffering it** when it cannot fit.
 *
 * `formData()` holds the whole body in memory, and the edge accepts 100 MB, so
 * checking the size after parsing lets anybody with an upload route make the
 * process allocate 100 MB per request. A `Content-Length` over the ceiling is
 * refused without reading a byte. A body with no length (chunked) is read with
 * a counter and abandoned the moment it passes the ceiling. A length that is
 * present is enforced by Node's HTTP parser, which stops at that many bytes.
 */
export async function readFilePart(
  request: MultipartRequest,
  options?: ReadFilePartOptions,
): Promise<IncomingFile> {
  const form = await readForm(request, options);

  // The part is narrowed structurally rather than with `instanceof File`: this
  // package does not load the DOM lib, and a `Blob` without a filename is still
  // a perfectly good upload.
  const part: unknown = form.get(FIELD_NAME);
  if (!isFilePart(part)) {
    // A file under another name is a different failure from no file at all: it
    // is one word away from working, and the caller is told which word.
    const misnamed = [...form.keys()].filter(
      (name) => name !== FIELD_NAME && isFilePart(form.get(name)),
    );
    if (misnamed.length > 0) {
      throw new DomainError('STORAGE_UPLOAD_FIELD_MISSING', {
        details: { expected: FIELD_NAME, received: misnamed },
      });
    }
    throw new DomainError('STORAGE_NO_FILE');
  }
  const blob = part as { arrayBuffer(): Promise<ArrayBuffer>; name?: unknown; type?: unknown };

  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.byteLength === 0) throw new DomainError('STORAGE_NO_FILE');

  const filename = typeof blob.name === 'string' && blob.name !== '' ? blob.name : undefined;
  const declaredMime = typeof blob.type === 'string' && blob.type !== '' ? blob.type : undefined;
  return { bytes, filename, declaredMime };
}

function tooLarge(maxBytes: number, size?: number): DomainError {
  return new DomainError('STORAGE_FILE_TOO_LARGE', {
    details: size === undefined ? { maxBytes } : { maxBytes, size },
  });
}

async function readForm(
  request: MultipartRequest,
  options: ReadFilePartOptions | undefined,
): Promise<FormData> {
  if (!options) return parseForm(() => request.formData());
  const ceiling = options.maxBytes + MULTIPART_OVERHEAD_BYTES;

  const declared = request.headers?.get('content-length');
  if (declared !== null && declared !== undefined && declared.trim() !== '') {
    const length = Number(declared);
    if (!Number.isFinite(length) || length < 0) throw new DomainError('STORAGE_NO_FILE');
    if (length > ceiling) throw tooLarge(options.maxBytes, length);
    return parseForm(() => request.formData());
  }

  // No length: count while reading, and stop at the ceiling.
  const body = request.body;
  if (!body) return parseForm(() => request.formData());
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > ceiling) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge(options.maxBytes);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const contentType = request.headers?.get('content-type') ?? '';
  return parseForm(() =>
    new Response(bytes, { headers: { 'content-type': contentType } }).formData(),
  );
}

async function parseForm(read: () => Promise<FormData>): Promise<FormData> {
  try {
    return await read();
  } catch {
    // A malformed or absent multipart body is a client error, not a 500.
    throw new DomainError('STORAGE_NO_FILE');
  }
}
