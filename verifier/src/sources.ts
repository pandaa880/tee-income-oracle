/**
 * Where a document and a compose file come from, over `fetch` (browser and Node):
 * the archived document next to the deployment file, the enclave's live
 * attestation server, and the compose file at the release tag on GitHub. None of
 * these sources is trusted: the document is signed by AWS and its hash is on
 * chain, and the compose file only has to reproduce PCR16.
 */
import { fromHex } from '@tio/encoding';
import type { EnclaveRecord } from './deployment.ts';
import { VerifierError } from './errors.ts';

const FETCH_TIMEOUT_MS = 15_000;
const HEX = /^(?:[0-9a-f]{2})+$/;

/** @throws VerifierError `hex_malformed` */
export function parseHexDocument(text: string): Uint8Array {
  const hex = text.trim().toLowerCase();
  if (!HEX.test(hex)) throw new VerifierError('hex_malformed', 'body is not hex');
  return fromHex(hex);
}

/** @throws VerifierError `fetch_failed` on a network error or a non-2xx status. */
async function fetchBytes(url: string, fetchFn: typeof fetch): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetchFn(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch {
    throw new VerifierError('fetch_failed', `GET ${url} failed`);
  }
  if (!response.ok) throw new VerifierError('fetch_failed', `GET ${url}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function fetchHexDocument(url: string, fetchFn: typeof fetch): Promise<Uint8Array> {
  return parseHexDocument(new TextDecoder().decode(await fetchBytes(url, fetchFn)));
}

/** `<baseUrl>/<record.attestationFile>`, where `baseUrl` serves the deployments directory. */
export function fetchArchivedDocument(
  baseUrl: string,
  record: EnclaveRecord,
  fetchFn: typeof fetch = fetch,
): Promise<Uint8Array> {
  return fetchHexDocument(`${baseUrl}/${record.attestationFile}`, fetchFn);
}

/**
 * `<endpoint>/attestation/hex`: the Oyster attestation server of a running enclave.
 * Every call returns a freshly signed document (new timestamp, new leaf), so its
 * hash never equals the registry's `attestation_doc_hash`: a live document
 * cross-checks the attester and image id, it does not replace the archived one.
 */
export function fetchLiveDocument(
  endpoint: string,
  fetchFn: typeof fetch = fetch,
): Promise<Uint8Array> {
  return fetchHexDocument(`${endpoint}/attestation/hex`, fetchFn);
}

/** `enclave/docker-compose.yml` at `tag` from `raw.githubusercontent.com/<repo>`, byte for byte. */
export function fetchComposeAtTag(
  repo: string,
  tag: string,
  fetchFn: typeof fetch = fetch,
): Promise<Uint8Array> {
  return fetchBytes(
    `https://raw.githubusercontent.com/${repo}/${tag}/enclave/docker-compose.yml`,
    fetchFn,
  );
}
