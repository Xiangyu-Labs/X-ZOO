import { commonErrors, type ErrorStatus } from '@shop/contracts/conventions';
import { errorRegistry } from '@shop/contracts/errors';

/**
 * The only error type domain code throws on purpose.
 *
 * A `DomainError` carries a *code*; the HTTP status and the Chinese message
 * come from the contracts error registry (`defineErrors` in
 * `contracts/src/<domain>/errors.ts`), which is also what the OpenAPI document
 * and the clients read. So a service never picks a status code, and a message
 * is never written twice.
 *
 * Anything else that escapes a handler is a bug and becomes a 500 `INTERNAL`
 * with no detail leaked — see `apps/web/src/server/handle.ts`.
 */
export class DomainError extends Error {
  readonly code: string;
  readonly details: unknown;
  /** Set when the code is not in the registry, so `handle()` can log loudly. */
  readonly unregistered: boolean;

  constructor(
    code: string,
    options: { details?: unknown; message?: string; cause?: unknown } = {},
  ) {
    const spec = errorRegistry[code];
    super(options.message ?? spec?.message ?? code, { cause: options.cause });
    this.name = 'DomainError';
    this.code = code;
    this.details = options.details;
    this.unregistered = spec === undefined;
  }

  get status(): ErrorStatus {
    return errorRegistry[this.code]?.status ?? 500;
  }

  /** The `{code, message, details?}` body both surfaces return. */
  toBody(): { code: string; message: string; details?: unknown } {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details };
  }

  static is(error: unknown): error is DomainError {
    return error instanceof DomainError;
  }
}

/** `throw notFound()` reads better than remembering the common code strings. */
export const unauthenticated = (details?: unknown) =>
  new DomainError('UNAUTHENTICATED', details === undefined ? {} : { details });
export const forbidden = (details?: unknown) =>
  new DomainError('FORBIDDEN', details === undefined ? {} : { details });
export const notFound = (details?: unknown) =>
  new DomainError('NOT_FOUND', details === undefined ? {} : { details });
export const validationFailed = (details?: unknown) =>
  new DomainError('VALIDATION_FAILED', details === undefined ? {} : { details });
export const rateLimited = (details?: unknown) =>
  new DomainError('RATE_LIMITED', details === undefined ? {} : { details });

export { commonErrors, errorRegistry };

/**
 * Resolves a code to its status/message without constructing an error, for the
 * places that report rather than throw (the mock server, the OpenAPI build).
 */
export function resolveError(code: string): { status: ErrorStatus; message: string } {
  return errorRegistry[code] ?? { status: 500, message: commonErrors.INTERNAL.message };
}
