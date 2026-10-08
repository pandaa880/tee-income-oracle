// Runs the real entry point (`node --import tsx src/main.ts`) with an empty environment. It must
// load its whole import graph (no ERR_MODULE_NOT_FOUND, ERR_UNSUPPORTED_DIR_IMPORT, syntax or
// type-stripping errors) and then stop on a configuration error before it listens.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const GATEWAY_DIR = fileURLToPath(new URL('../', import.meta.url));
const LOAD_FAILURES =
  /ERR_MODULE_NOT_FOUND|ERR_UNSUPPORTED_DIR_IMPORT|ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX|ERR_UNKNOWN_FILE_EXTENSION|ERR_PACKAGE_PATH_NOT_EXPORTED|SyntaxError|Cannot find (module|package)/;
const REQUIRED_VARS = [
  'ENCLAVE_URL',
  'BANK_URL',
  'SOLANA_RPC_URL',
  'CLUSTER',
  'MEASUREMENT_ID',
  'RELAYER_KEYPAIR',
  'ALLOWED_ORIGIN',
];

describe('node --import tsx src/main.ts with an empty environment', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: GATEWAY_DIR,
    env: {},
    encoding: 'utf8',
    timeout: 30_000,
  });

  it('exits with status 1', () => {
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
  });

  it('loads the whole import graph under tsx', () => {
    expect(result.stderr).not.toMatch(LOAD_FAILURES);
  });

  it('reports a configuration error naming a missing variable', () => {
    expect(result.stderr).toMatch(new RegExp(`\\b(${REQUIRED_VARS.join('|')})\\b`));
  });

  it('does not start listening', () => {
    expect(result.stdout).not.toMatch(/listening/i);
  });
});
