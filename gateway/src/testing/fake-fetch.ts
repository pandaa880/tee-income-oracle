// Test code only. A fake `fetch` that records requests and answers from a function.
export type RecordedRequest = {
  url: string;
  method: string;
  headers: Headers;
  body: Uint8Array | undefined;
  signal: AbortSignal | undefined;
};

export type FakeFetch = { fetch: typeof fetch; requests: RecordedRequest[] };

export function fakeFetch(
  respond: (request: RecordedRequest) => Response | Promise<Response>,
): FakeFetch {
  const requests: RecordedRequest[] = [];
  const fakeFn: typeof fetch = async (input, init) => {
    const body =
      init?.body === undefined || init.body === null
        ? undefined
        : new Uint8Array(await new Response(init.body).arrayBuffer());
    const request: RecordedRequest = {
      url: input instanceof Request ? input.url : String(input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body,
      signal: init?.signal ?? undefined,
    };
    requests.push(request);
    return respond(request);
  };
  return { fetch: fakeFn, requests };
}

export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export function bytesResponse(
  status: number,
  body: Uint8Array,
  headers: Record<string, string> = {},
): Response {
  return new Response(body, { status, headers });
}

export function firstRequest(f: FakeFetch): RecordedRequest {
  const request = f.requests[0];
  if (request === undefined) throw new Error('no request was made');
  return request;
}

export function requestObject(request: RecordedRequest): Record<string, unknown> {
  const parsed = requestJson(request);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('request body is not a JSON object');
  }
  return Object.fromEntries(Object.entries(parsed));
}

export function requestJson(request: RecordedRequest): unknown {
  if (request.body === undefined) throw new Error('request has no body');
  const parsed: unknown = JSON.parse(new TextDecoder().decode(request.body));
  return parsed;
}
