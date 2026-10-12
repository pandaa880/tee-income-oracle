// tio-verify: check a borrower's tier end to end, from a clone of the repo.
//
// Usage: pnpm --filter @tio/verifier verify -- <wallet> --cluster <devnet|localnet>
//          [--deployment <file>] [--rpc <url>] [--doc <file>] [--compose <file>]
//
// The document defaults to the archive named by the deployment record of the
// attestation's build; the compose file defaults to `enclave/docker-compose.yml`
// at that record's `release` tag (git). Exit 0 only when the verdict is PASS; 1
// on FAIL; 2 for a usage, I/O or chain error (`error: <code>: <message>` on stderr).
import { parseArgs } from 'node:util';
import { type Address, createSolanaRpc, isAddress } from '@solana/kit';
import { kitChainReader } from './chain/kit.ts';
import { type Deployment, type EnclaveRecord, enclaveRecordOf } from './deployment.ts';
import { VerifierError } from './errors.ts';
import {
  type DeploymentFile,
  archivedDocumentPath,
  composeAtRef,
  readDeploymentFile,
  readFileBytes,
  readHexDocumentFile,
  repoPath,
} from './node/files.ts';
import { formatReport } from './report.ts';
import { verifyWallet } from './verify.ts';

const RPC_BY_CLUSTER: Record<string, string> = {
  devnet: 'https://api.devnet.solana.com',
  localnet: 'http://127.0.0.1:8899',
};

type Options = {
  wallet: Address;
  cluster: string;
  deploymentPath: string;
  rpcUrl: string;
  docPath: string | undefined;
  composePath: string | undefined;
};

class UsageError extends Error {}

const ARG_OPTIONS = {
  cluster: { type: 'string' },
  deployment: { type: 'string' },
  rpc: { type: 'string' },
  doc: { type: 'string' },
  compose: { type: 'string' },
} as const;

/** `parseArgs` failures (unknown option, missing value) are usage errors, not crashes. */
function parsedArgs(argv: string[]) {
  try {
    return parseArgs({ args: argv, allowPositionals: true, options: ARG_OPTIONS });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : 'invalid arguments');
  }
}

function parseOptions(argv: string[]): Options {
  const { values, positionals } = parsedArgs(argv);
  const [wallet] = positionals;
  if (wallet === undefined || !isAddress(wallet)) {
    throw new UsageError('<wallet> must be a base58 address');
  }
  const cluster = values.cluster;
  if (cluster === undefined) throw new UsageError('--cluster is required');
  const rpcUrl = values.rpc ?? RPC_BY_CLUSTER[cluster];
  if (rpcUrl === undefined) throw new UsageError(`--rpc is required for cluster ${cluster}`);
  return {
    wallet,
    cluster,
    deploymentPath: values.deployment ?? repoPath(`deployments/${cluster}.json`),
    rpcUrl,
    docPath: values.doc,
    composePath: values.compose,
  };
}

function recordOf(file: DeploymentFile, measurementId: number): EnclaveRecord {
  const record = enclaveRecordOf(file.deployment, measurementId);
  if (record === undefined) {
    throw new VerifierError(
      'deployment_malformed',
      `no enclaves[] record for measurement id ${measurementId}: pass --doc and --compose`,
    );
  }
  return record;
}

/** The compose at the record's release tag, unless `--compose` names a file. */
async function composeFor(options: Options, file: DeploymentFile, measurementId: number) {
  if (options.composePath !== undefined) return readFileBytes(options.composePath);
  const record = recordOf(file, measurementId);
  if (record.release === undefined) {
    throw new VerifierError(
      'deployment_malformed',
      `record ${measurementId} has no release tag: pass --compose`,
    );
  }
  return composeAtRef(record.release);
}

/** The document from `--doc`, else the archive named by the record. */
async function documentFor(options: Options, file: DeploymentFile, measurementId: number) {
  if (options.docPath !== undefined) return readHexDocumentFile(options.docPath);
  const record = recordOf(file, measurementId);
  return readHexDocumentFile(archivedDocumentPath(file, record.attestationFile));
}

async function main(argv: string[]): Promise<number> {
  const options = parseOptions(argv);
  const file = await readDeploymentFile(options.deploymentPath);
  const deployment: Deployment = file.deployment;
  if (deployment.cluster !== options.cluster) {
    throw new UsageError(
      `${options.deploymentPath} is for ${deployment.cluster}, not ${options.cluster}`,
    );
  }
  const report = await verifyWallet({
    chain: kitChainReader(createSolanaRpc(options.rpcUrl)),
    deployment,
    wallet: options.wallet,
    // Both depend on the attestation's measurement id, so they load once it is known.
    document: (measurementId) => documentFor(options, file, measurementId),
    composeBytes: (measurementId) => composeFor(options, file, measurementId),
  });
  process.stdout.write(formatReport(report));
  return report.verdict === 'PASS' ? 0 : 1;
}

function errorLine(error: unknown): string {
  if (error instanceof VerifierError) return `error: ${error.message}`;
  if (error instanceof UsageError) return `error: usage: ${error.message}`;
  // Anything else is a bug; its text is not ours to print (CODING-GUIDELINES §1.11).
  return `error: unexpected: ${error instanceof Error ? error.name : 'non-error thrown'}`;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${errorLine(error)}\n`);
    process.exitCode = 2;
  },
);
