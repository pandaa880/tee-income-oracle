// Builds fetch Responses with an SSE body split at exact chunk boundaries. Not a test file.
const encoder = new TextEncoder();

export function sseResponse(chunks: readonly string[], init: ResponseInit = {}): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    ...init,
  });
}

/** One chunk of text per event, for tests that don't care about splits. */
export const sseEvent = (event: string, data: unknown): string =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/**
 * A stream that emits `first` and then waits; it errors with an AbortError when `signal` aborts,
 * like a real fetch body.
 */
export function hangingSseResponse(
  first: string,
  signal: AbortSignal | null | undefined,
): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(first));
      signal?.addEventListener('abort', () => {
        controller.error(new DOMException('The operation was aborted.', 'AbortError'));
      });
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

export const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export const urlOf = (input: URL | RequestInfo): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

export const bodyOf = (init: RequestInit | undefined): string =>
  typeof init?.body === 'string' ? init.body : '';

export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}
