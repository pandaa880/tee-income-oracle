// Document and compose sources over an injected `fetch`: URL shapes, hex parsing, error codes.
import { describe, expect, it } from 'vitest';
import { expectRejected, expectThrown, loadDocumentHex, loadDocument } from './test-fixtures.ts';
import { type EnclaveRecord } from './deployment.ts';
import {
  fetchArchivedDocument,
  fetchComposeAtTag,
  fetchLiveDocument,
  parseHexDocument,
} from './sources.ts';

const RECORD: EnclaveRecord = {
  measurementId: 1,
  imageId: '7dd33d974511a825c871f267ebdc6b34fb9cdc2c63210e27a31a8c7cfb96daff',
  attester: '0xb6dda6eed87322334ba37809bd451a852ae6574c',
  attestationFile: 'devnet/attestation-1.hex',
};

type Capture = { urls: string[]; inits: (RequestInit | undefined)[] };

function fakeFetch(respond: () => Response | Promise<Response>): {
  fetchFn: typeof fetch;
  seen: Capture;
} {
  const seen: Capture = { urls: [], inits: [] };
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.urls.push(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    seen.inits.push(init);
    return respond();
  }) as typeof fetch;
  return { fetchFn, seen };
}

const hexResponse = (hex: string) => () => new Response(`${hex}\n`, { status: 200 });

describe('parseHexDocument', () => {
  it('decodes_hex_text', () => {
    expect(parseHexDocument('00ff10')).toEqual(Uint8Array.of(0x00, 0xff, 0x10));
  });

  it('ignores_surrounding_whitespace_and_a_trailing_newline', () => {
    expect(parseHexDocument('  00ff10\n')).toEqual(Uint8Array.of(0x00, 0xff, 0x10));
  });

  it('decodes_an_archived_document_file', () => {
    expect(parseHexDocument(`${loadDocumentHex(1)}\n`)).toEqual(loadDocument(1));
  });

  it('rejects_non_hex_characters', () => {
    expectThrown(() => parseHexDocument('00zz'), 'hex_malformed');
  });

  it('rejects_an_odd_number_of_digits', () => {
    expectThrown(() => parseHexDocument('abc'), 'hex_malformed');
  });

  it('rejects_html_such_as_an_error_page', () => {
    expectThrown(() => parseHexDocument('<html>502 Bad Gateway</html>'), 'hex_malformed');
  });
});

describe('fetchArchivedDocument', () => {
  const BASE = 'https://example.test/deployments';

  it('requests_base_url_slash_attestation_file', async () => {
    const { fetchFn, seen } = fakeFetch(hexResponse('00ff'));
    const bytes = await fetchArchivedDocument(BASE, RECORD, fetchFn);
    expect(seen.urls).toEqual(['https://example.test/deployments/devnet/attestation-1.hex']);
    expect(bytes).toEqual(Uint8Array.of(0x00, 0xff));
  });

  it('passes_an_abort_signal_so_a_stalled_server_times_out', async () => {
    const { fetchFn, seen } = fakeFetch(hexResponse('00'));
    await fetchArchivedDocument(BASE, RECORD, fetchFn);
    expect(seen.inits[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('rejects_a_non_hex_body_as_hex_malformed', async () => {
    const { fetchFn } = fakeFetch(() => new Response('not hex at all', { status: 200 }));
    await expectRejected(fetchArchivedDocument(BASE, RECORD, fetchFn), 'hex_malformed');
  });

  it('rejects_status_500_as_fetch_failed', async () => {
    const { fetchFn } = fakeFetch(() => new Response('00ff', { status: 500 }));
    await expectRejected(fetchArchivedDocument(BASE, RECORD, fetchFn), 'fetch_failed');
  });

  it('rejects_status_404_as_fetch_failed', async () => {
    const { fetchFn } = fakeFetch(() => new Response('', { status: 404 }));
    await expectRejected(fetchArchivedDocument(BASE, RECORD, fetchFn), 'fetch_failed');
  });

  it('rejects_a_network_error_as_fetch_failed', async () => {
    const { fetchFn } = fakeFetch(() => {
      throw new TypeError('network down');
    });
    await expectRejected(fetchArchivedDocument(BASE, RECORD, fetchFn), 'fetch_failed');
  });
});

describe('fetchComposeAtTag', () => {
  it('requests_raw_github_enclave_docker_compose_at_the_tag', async () => {
    const { fetchFn, seen } = fakeFetch(() => new Response('services: {}\n', { status: 200 }));
    const bytes = await fetchComposeAtTag('some-owner/some-repo', 'v0.3.0', fetchFn);
    expect(seen.urls).toEqual([
      'https://raw.githubusercontent.com/some-owner/some-repo/v0.3.0/enclave/docker-compose.yml',
    ]);
    expect(new TextDecoder().decode(bytes)).toBe('services: {}\n');
  });

  it('returns_the_body_bytes_unmodified', async () => {
    const body = Uint8Array.of(0, 1, 2, 250, 251, 252);
    const { fetchFn } = fakeFetch(() => new Response(body, { status: 200 }));
    expect(await fetchComposeAtTag('o/r', 'v1', fetchFn)).toEqual(body);
  });

  it('rejects_status_404_as_fetch_failed', async () => {
    const { fetchFn } = fakeFetch(() => new Response('', { status: 404 }));
    await expectRejected(fetchComposeAtTag('o/r', 'v1', fetchFn), 'fetch_failed');
  });

  it('rejects_a_network_error_as_fetch_failed', async () => {
    const { fetchFn } = fakeFetch(() => {
      throw new TypeError('network down');
    });
    await expectRejected(fetchComposeAtTag('o/r', 'v1', fetchFn), 'fetch_failed');
  });
});

describe('fetchLiveDocument', () => {
  const ENDPOINT = 'http://13.127.229.5:1301';

  it('requests_endpoint_slash_attestation_slash_hex', async () => {
    const { fetchFn, seen } = fakeFetch(hexResponse('abcd'));
    const bytes = await fetchLiveDocument(ENDPOINT, fetchFn);
    expect(seen.urls).toEqual(['http://13.127.229.5:1301/attestation/hex']);
    expect(bytes).toEqual(Uint8Array.of(0xab, 0xcd));
  });

  it('passes_an_abort_signal', async () => {
    const { fetchFn, seen } = fakeFetch(hexResponse('ab'));
    await fetchLiveDocument(ENDPOINT, fetchFn);
    expect(seen.inits[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('rejects_a_non_hex_body_as_hex_malformed', async () => {
    const { fetchFn } = fakeFetch(() => new Response('gg', { status: 200 }));
    await expectRejected(fetchLiveDocument(ENDPOINT, fetchFn), 'hex_malformed');
  });

  it('rejects_status_500_as_fetch_failed', async () => {
    const { fetchFn } = fakeFetch(() => new Response('ab', { status: 500 }));
    await expectRejected(fetchLiveDocument(ENDPOINT, fetchFn), 'fetch_failed');
  });
});
