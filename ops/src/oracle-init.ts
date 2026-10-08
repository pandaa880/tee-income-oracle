/**
 * `oracle:init`: creates the oracle `Config` (FORMATS §13) with the registry
 * admin, once per deployment. Only the program's upgrade authority may do it
 * (the program checks), so a stranger can't claim the registry between our
 * deploy and our initialize.
 */
import {
  type Address,
  type KeyPairSigner,
  address,
  getAddressEncoder,
  getProgramDerivedAddress,
} from '@solana/kit';
import {
  ORACLE_PROGRAM_ADDRESS,
  fetchMaybeConfig,
  findConfigPda,
  getInitializeInstructionAsync,
} from '@tio/oracle-client';
import { type Cluster, assertCluster } from './cluster.ts';
import { OpsError } from './errors.ts';
import { type ChainClients, sendInstructions } from './send.ts';

const BPF_LOADER_UPGRADEABLE = address('BPFLoaderUpgradeab1e11111111111111111111111');

export type OracleInitInput = ChainClients & {
  cluster: Cluster;
  /** The oracle program's upgrade authority; pays. */
  authority: KeyPairSigner;
  /** The registry admin to store. */
  admin: Address;
};

/** The upgradeable loader's ProgramData account of `programId`. */
export async function programDataAddress(programId: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: BPF_LOADER_UPGRADEABLE,
    seeds: [getAddressEncoder().encode(programId)],
  });
  return pda;
}

/**
 * Creates the config, or checks the existing one. A re-run with the same
 * admin sends nothing.
 *
 * @throws OpsError `cluster_mismatch`, or `admin_mismatch` if the config
 *   names another admin (changing it is `propose_admin`, a human decision).
 */
export async function runOracleInit(input: OracleInitInput): Promise<{ created: boolean }> {
  await assertCluster(input);
  const [config] = await findConfigPda();
  const found = await fetchMaybeConfig(input.rpc, config);
  if (found.exists) {
    if (found.data.admin !== input.admin) {
      throw new OpsError('admin_mismatch', `oracle config admin is ${found.data.admin}`);
    }
    return { created: false };
  }
  const instruction = await getInitializeInstructionAsync({
    authority: input.authority,
    programData: await programDataAddress(ORACLE_PROGRAM_ADDRESS),
    admin: input.admin,
  });
  await sendInstructions(input, input.authority, [instruction]);
  return { created: true };
}
