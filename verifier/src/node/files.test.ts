// Node-only file helpers used by the CLI: the compose file at a git ref, unreadable files.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { COMPOSE_PATH, expectRejected } from '../test-fixtures.ts';
import { composeAtRef, readFileBytes, readHexDocumentFile } from './files.ts';

describe('composeAtRef', () => {
  it('returns_the_committed_compose_bytes_at_head', async () => {
    // HEAD's compose equals the working tree's (the file is committed and unchanged in CI).
    expect(await composeAtRef('HEAD')).toEqual(new Uint8Array(readFileSync(COMPOSE_PATH)));
  });

  it('rejects_a_ref_that_is_not_in_the_clone_as_file_unreadable', async () => {
    await expectRejected(composeAtRef('v999.0.0'), 'file_unreadable');
  });

  it.each(['--output=/tmp/x', '-v', 'a b', ''])('rejects_%j_as_a_ref', async (ref) => {
    await expectRejected(composeAtRef(ref), 'file_unreadable');
  });
});

describe('file readers', () => {
  it('reports_a_missing_file_as_file_unreadable', async () => {
    await expectRejected(readFileBytes('/nonexistent/path.bin'), 'file_unreadable');
    await expectRejected(readHexDocumentFile('/nonexistent/attestation.hex'), 'file_unreadable');
  });

  it('reports_a_non_hex_file_as_hex_malformed', async () => {
    await expectRejected(readHexDocumentFile(COMPOSE_PATH), 'hex_malformed');
  });
});
