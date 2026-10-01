import type { Transport, TransportRequest, TransportResponse } from '../transport';

export interface FakeTransport {
  transport: Transport;
  requests: TransportRequest[];
}

/** A transport that records every request and answers from `respond`. */
export function fakeTransport(
  respond: (request: TransportRequest) => TransportResponse | Promise<TransportResponse>,
): FakeTransport {
  const requests: TransportRequest[] = [];
  return {
    requests,
    transport: async (request) => {
      requests.push(request);
      return respond(request);
    },
  };
}

export function json(status: number, body: unknown): TransportResponse {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  };
}

/** A promise with its resolver exposed, for holding a response until the test says so. */
export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
