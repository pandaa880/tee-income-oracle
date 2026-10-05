// Shared failure assertion. The helper name is on the oxlint `expect-expect`
// allow-list, so tests that only call it count as asserting.
import { type Failure, failingInstructionIndex } from '@tio/oracle-tests/attest-fixture';
import { expect } from 'vitest';

export {
  ANCHOR_ACCOUNT_NOT_INITIALIZED,
  ANCHOR_CONSTRAINT_SEEDS,
  SYSTEM_ACCOUNT_ALREADY_IN_USE,
} from '@tio/oracle-tests/harness';

// Anchor framework errors.
export const ANCHOR_CONSTRAINT_HAS_ONE = 2001;
export const ANCHOR_CONSTRAINT_TOKEN_MINT = 2014;
export const ANCHOR_CONSTRAINT_TOKEN_OWNER = 2015;
export const ANCHOR_DISCRIMINATOR_MISMATCH = 3002;
export const ANCHOR_ACCOUNT_OWNED_BY_WRONG_PROGRAM = 3007;
export const ANCHOR_ACCOUNT_NOT_SIGNER = 3010;
// SPL Token program error: insufficient funds.
export const SPL_TOKEN_INSUFFICIENT_FUNDS = 1;

/** The harness puts a compute-budget instruction first, so a lone instruction is index 1. */
export const LONE_INSTRUCTION_INDEX = 1;

/**
 * The transaction failed with custom error `code` in instruction
 * `instructionIndex` (default: the lone instruction after the compute budget).
 * Framework, system-program and SPL Token failures use this too: asserting the
 * index keeps an unrelated failure from passing for the wrong reason.
 */
export function expectError(
  failure: Failure,
  code: number,
  instructionIndex = LONE_INSTRUCTION_INDEX,
): void {
  expect(failure.code).toBe(code);
  expect(failingInstructionIndex(failure.error)).toBe(instructionIndex);
}
