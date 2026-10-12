/** Node-only helpers for the CLI: repo paths, the deployment / document files, the compose at a tag. */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { type Deployment, parseDeployment } from '../deployment.ts';
import { VerifierError } from '../errors.ts';
import { parseHexDocument } from '../sources.ts';

const run = promisify(execFile);
const GIT_TIMEOUT_MS = 15_000;
/** The compose file is read at a tag, so `git show` must get a ref, never an option. */
const GIT_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** `<repo>/<relative>` from this checkout (the CLI's defaults for deployments and the compose file). */
export function repoPath(relative: string): string {
  return fileURLToPath(new URL(`../../../${relative}`, import.meta.url));
}

export type DeploymentFile = { deployment: Deployment; dir: string };

/** @throws VerifierError `file_unreadable` | `deployment_malformed` */
export async function readDeploymentFile(path: string): Promise<DeploymentFile> {
  let json: unknown;
  try {
    json = JSON.parse(await readBytesText(path));
  } catch (error) {
    if (error instanceof VerifierError) throw error;
    throw new VerifierError('deployment_malformed', `${path} is not JSON`);
  }
  return { deployment: parseDeployment(json), dir: dirname(path) };
}

/** @throws VerifierError `file_unreadable` */
export async function readFileBytes(path: string): Promise<Uint8Array> {
  try {
    return new Uint8Array(await readFile(path));
  } catch {
    throw new VerifierError('file_unreadable', `${path} is not readable`);
  }
}

async function readBytesText(path: string): Promise<string> {
  return new TextDecoder().decode(await readFileBytes(path));
}

/** An archived `attestation-<id>.hex` (or any file in that format). @throws `file_unreadable` | `hex_malformed` */
export async function readHexDocumentFile(path: string): Promise<Uint8Array> {
  return parseHexDocument(await readBytesText(path));
}

/** The archived document named by a deployment record, resolved against the deployment file. */
export function archivedDocumentPath(file: DeploymentFile, attestationFile: string): string {
  return join(file.dir, attestationFile);
}

/**
 * `enclave/docker-compose.yml` as committed at `ref` (a release tag) in this
 * clone: the bytes that produced the deployed image, whatever the working tree
 * holds today. PASS on check 3 then means "the enclave runs the tagged release".
 *
 * @throws VerifierError `file_unreadable` if the ref or the file isn't in the clone.
 */
export async function composeAtRef(ref: string): Promise<Uint8Array> {
  if (!GIT_REF.test(ref)) throw new VerifierError('file_unreadable', `${ref} is not a git ref`);
  const root = repoPath('');
  // Pin the repository: `-C` + no inherited GIT_DIR/GIT_WORK_TREE, so git can't be
  // pointed at another clone's history; `--end-of-options` keeps the ref an argument.
  const { GIT_DIR: _dir, GIT_WORK_TREE: _tree, ...env } = process.env;
  try {
    const { stdout } = await run(
      'git',
      ['-C', root, 'show', '--end-of-options', `${ref}:enclave/docker-compose.yml`],
      { env, encoding: 'buffer', timeout: GIT_TIMEOUT_MS, maxBuffer: 1 << 20 },
    );
    return new Uint8Array(stdout);
  } catch {
    throw new VerifierError(
      'file_unreadable',
      `enclave/docker-compose.yml at ${ref} is not in this clone (fetch the tag, or pass --compose)`,
    );
  }
}
