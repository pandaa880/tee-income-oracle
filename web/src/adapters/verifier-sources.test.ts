// @vitest-environment node
import { readFileSync } from 'node:fs';
import { parseDeployment } from '@tio/verifier/deployment';
import { VerifierError, type VerifierErrorCode } from '@tio/verifier/errors';
import { describe, expect, it, vi } from 'vitest';
import devnet from '../../../deployments/devnet.json';
import { hexBytes } from '../test-support/fixtures.ts';
import { createSources, REPO } from './verifier-sources.ts';

const [RECORD_0, RECORD_1] = parseDeployment(devnet).enclaves;
if (RECORD_0 === undefined || RECORD_1 === undefined)
  throw new Error('devnet.json lists no builds');

const COMPOSE_URL =
  'https://raw.githubusercontent.com/pandaa880/tee-income-oracle/v0.3.0/enclave/docker-compose.yml';
const signal = () => new AbortController().signal;
type FetchFn = typeof fetch;

const archived = (id: 0 | 1): Uint8Array =>
  hexBytes(
    readFileSync(
      new URL(`../../../deployments/devnet/attestation-${id}.hex`, import.meta.url),
      'utf8',
    ).trim(),
  );

async function expectRejected(promise: Promise<unknown>, code: VerifierErrorCode): Promise<void> {
  const failure = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(VerifierError);
  expect(failure).toMatchObject({ code });
}

const text = (body: string, status = 200) => new Response(body, { status });

describe('REPO', () => {
  it('is the published repository', () => {
    expect(REPO).toBe('pandaa880/tee-income-oracle');
  });
});

describe('archivedDocument', () => {
  it.each([
    [0, RECORD_0],
    [1, RECORD_1],
  ] as const)(
    'resolves the bundled document of build %i to the archived bytes',
    async (id, record) => {
      const bytes = await createSources().archivedDocument(record);
      expect(Array.from(bytes)).toEqual(Array.from(archived(id)));
    },
  );

  it('never touches the network for the archived document', async () => {
    const fetchFn = vi.fn<FetchFn>();
    await createSources(fetchFn).archivedDocument(RECORD_1);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('rejects a record whose archive file is not bundled with deployment_malformed', async () => {
    const record = { ...RECORD_1, attestationFile: 'devnet/attestation-9.hex' };
    await expectRejected(createSources().archivedDocument(record), 'deployment_malformed');
  });

  it('does not read outside the bundled files (a path climbing out of the deployments folder)', async () => {
    const record = { ...RECORD_1, attestationFile: '../devnet.json' };
    await expectRejected(createSources().archivedDocument(record), 'deployment_malformed');
  });

  it('is file_unreadable when the bundled chunk fails to load (a tab on an older build)', async () => {
    const archive = {
      [`../../../deployments/${RECORD_1.attestationFile}`]: async (): Promise<string> => {
        throw new TypeError('Failed to fetch dynamically imported module');
      },
    };
    await expectRejected(
      createSources(fetch, archive).archivedDocument(RECORD_1),
      'file_unreadable',
    );
  });
});

describe('composeAtTag', () => {
  it('reads enclave/docker-compose.yml at the release tag of the record from raw.githubusercontent.com', async () => {
    const fetchFn = vi.fn<FetchFn>(async () => text('services: {}'));
    const bytes = await createSources(fetchFn).composeAtTag(RECORD_1, signal());
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0]?.[0]).toBe(COMPOSE_URL);
    expect(new TextDecoder().decode(bytes)).toBe('services: {}');
  });

  it('uses the tag of the record it is given', async () => {
    const fetchFn = vi.fn<FetchFn>(async () => text('x'));
    await createSources(fetchFn).composeAtTag({ ...RECORD_1, release: 'v1.2.3' }, signal());
    expect(fetchFn.mock.calls[0]?.[0]).toBe(COMPOSE_URL.replace('v0.3.0', 'v1.2.3'));
  });

  it('returns the body byte for byte', async () => {
    const body = new Uint8Array([0, 255, 10, 13, 128]);
    const fetchFn = vi.fn<FetchFn>(async () => new Response(body));
    const bytes = await createSources(fetchFn).composeAtTag(RECORD_1, signal());
    expect(Array.from(bytes)).toEqual(Array.from(body));
  });

  it('rejects a record without a release tag with deployment_malformed, without fetching', async () => {
    const { release: _release, ...untagged } = RECORD_1;
    const fetchFn = vi.fn<FetchFn>(async () => text('x'));
    await expectRejected(
      createSources(fetchFn).composeAtTag(untagged, signal()),
      'deployment_malformed',
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('rejects a non-2xx reply with fetch_failed', async () => {
    const fetchFn = vi.fn<FetchFn>(async () => text('not found', 404));
    await expectRejected(createSources(fetchFn).composeAtTag(RECORD_1, signal()), 'fetch_failed');
  });

  it('rejects a network error with fetch_failed', async () => {
    const fetchFn = vi.fn<FetchFn>(async () => Promise.reject(new TypeError('Failed to fetch')));
    await expectRejected(createSources(fetchFn).composeAtTag(RECORD_1, signal()), 'fetch_failed');
  });

  it('aborts the request when the caller aborts, and that ends as fetch_failed', async () => {
    let requestSignal: AbortSignal | null | undefined;
    const fetchFn = vi.fn<FetchFn>(
      (_, init) =>
        new Promise<Response>((_resolve, reject) => {
          requestSignal = init?.signal;
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('x', 'AbortError')),
          );
        }),
    );
    const controller = new AbortController();
    const pending = createSources(fetchFn).composeAtTag(RECORD_1, controller.signal);
    await vi.waitFor(() => expect(requestSignal).toBeDefined());
    expect(requestSignal?.aborted).toBe(false);
    controller.abort();
    await expectRejected(pending, 'fetch_failed');
    expect(requestSignal?.aborted).toBe(true);
  });

  it('hands the request a signal that is already aborted when the caller was', async () => {
    let requestSignal: AbortSignal | null | undefined;
    const fetchFn = vi.fn<FetchFn>(async (_, init) => {
      requestSignal = init?.signal;
      return text('x');
    });
    const controller = new AbortController();
    controller.abort();
    await createSources(fetchFn)
      .composeAtTag(RECORD_1, controller.signal)
      .catch(() => undefined);
    expect(requestSignal?.aborted).toBe(true);
  });
});
