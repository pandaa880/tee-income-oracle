// One place that turns every expected failure into words. Pages never write their own.
import type {
  AmountProblem,
  AppError,
  ClientCode,
  GatewayCode,
  VerifierErrorCode,
} from './types.ts';

/** What the one button under the message does: retry the same call, start the flow over, re-attest, or nothing. */
export type ErrorAction = 'retry' | 'restart' | 'reattest' | 'none';

export type ErrorMessage = { title: string; detail: string; action: ErrorAction };

const msg = (title: string, detail: string, action: ErrorAction = 'none'): ErrorMessage => ({
  title,
  detail,
  action,
});

const SIMPLE: Record<GatewayCode | ClientCode, ErrorMessage> = {
  bad_request: msg('Request rejected', 'The service did not accept this request.'),
  not_found: msg('Not found', 'The service has no such endpoint.'),
  session_not_found: msg(
    'Session ended',
    'This session was already used or closed. Start again; nothing was fetched.',
    'restart',
  ),
  session_expired: msg(
    'Consent window closed',
    'Sessions last 10 minutes. Start again; nothing was fetched.',
    'restart',
  ),
  body_too_large: msg('Request too large', 'The request was larger than the service accepts.'),
  rate_limited: msg(
    'Too many requests',
    'The demo gateway is busy. Wait a minute and try again.',
    'retry',
  ),
  relay_in_flight: msg(
    'Your last transaction is still confirming',
    'One loan transaction at a time per wallet. Wait a few seconds for the previous one to land, then try again.',
    'retry',
  ),
  sponsorship_exhausted: msg(
    "The relayer won't fund another token account for this wallet",
    "The relayer pays for a wallet's token account once. Yours was funded before and is gone, or today's budget is spent. Create the account from your own wallet, or come back in an hour.",
  ),
  internal_error: msg('Service error', 'The service failed unexpectedly.'),
  too_many_sessions: msg(
    'Too many sessions open',
    'The demo has as many open sessions as it allows. Wait a minute and try again.',
    'retry',
  ),
  upstream_unavailable: msg(
    'Bank or enclave unreachable',
    "A service in the chain didn't answer. Nothing was stored. Try again.",
    'retry',
  ),
  enclave_rotated: msg(
    'Enclave is being updated',
    'The enclave restarted with a new key. It must be re-registered on chain before new tiers are issued. Try again in a few minutes.',
    'restart',
  ),
  stale_attestation: msg('Newer result on chain', 'A newer attestation already exists for you.'),
  tx_failed: msg(
    "The transaction didn't confirm",
    "The network didn't confirm it within 100 seconds. If no loan appears on the explorer, try again; if it does, this page picks it up on reload.",
    'retry',
  ),
  enclave_not_registered: msg('Enclave not registered', 'The running enclave is not on chain.'),
  enclave_revoked: msg(
    'Your tier needs refreshing',
    'The enclave build that issued your tier was retired. A fresh one takes under a minute.',
    'reattest',
  ),
  attester_mismatch: msg('Enclave mismatch', 'The enclave key differs from the registry.'),
  protocol_error: msg('Unexpected reply', 'The service answered in a format we do not accept.'),
  cancelled: msg('Cancelled', 'The request was cancelled. Start again when ready.', 'restart'),
  network: msg('Network problem', 'The service could not be reached.', 'retry'),
  rpc_busy: msg('Network busy', 'The Solana RPC is rate-limiting; try again shortly.', 'retry'),
  timeout: msg('Timed out', 'No answer arrived in time.', 'retry'),
  signing_failed: msg('Signing failed', 'The wallet could not sign the request.', 'retry'),
  loan_exists: msg('Loan already open', 'Repay the open loan in this pool before borrowing again.'),
  no_open_loan: msg('No open loan', 'There is no loan in this pool to repay.'),
};

/** demo_pool borrow/repay errors (FORMATS §14) seen in `simulation_failed.custom`. */
const ANCHOR: Record<number, ErrorMessage> = {
  6002: msg('Amount required', 'Enter an amount above zero.', 'retry'),
  6003: msg('No valid attestation', 'The attestation account is not a valid tier record.'),
  6004: msg('Wrong attester', 'The attestation was not written by the oracle.'),
  6005: msg('Attestation expired', 'Your tier has expired. Re-attest to borrow.', 'reattest'),
  6006: msg('Tier not accepted', 'This pool does not lend to your tier.'),
  6007: msg('Over the limit', 'The amount is above what this pool lends to your tier.', 'retry'),
  6008: msg(
    'The pool changed its criteria',
    'Your tier was checked against older criteria. This pool only lends on tiers checked against its current ones, enforced on chain. Re-attest under the new criteria.',
    'reattest',
  ),
  6009: msg(
    'Attestation too old',
    'Your tier is older than this pool accepts. Re-attest.',
    'reattest',
  ),
  6010: msg('Statement too old', 'The statement window is older than this pool accepts.'),
  6011: msg('Statement too short', 'The statement covers less time than this pool requires.'),
  6012: msg(
    'Enclave not approved',
    'This pool does not accept the enclave build that scored you. Re-attest with the current build.',
    'reattest',
  ),
  6013: msg('Enclave record mismatch', 'The enclave record does not match your attestation.'),
  6014: msg(
    'Enclave revoked',
    'The enclave build that scored you was revoked. Re-attest.',
    'reattest',
  ),
};

const GENERIC_SIMULATION = msg(
  'The pool refused this transaction',
  'The gateway simulates every loan transaction before paying for it, so nothing was sent and no fee was spent.',
);

const AMOUNT: Record<AmountProblem, string> = {
  empty: 'Enter an amount.',
  zero: 'The amount must be above zero.',
  negative: 'The amount cannot be negative.',
  too_many_decimals: 'Use at most 6 decimal places.',
  not_a_number: 'Use digits and one decimal point, like 12.5.',
  over_limit: 'The amount is above your limit.',
};

/**
 * Why the verifier stopped before a verdict. Only the reasons a reader can act on or understand
 * get their own words; a broken document or certificate is "could not run" (the detail lines of
 * the checks say more once there is a verdict).
 */
const VERIFY: Partial<Record<VerifierErrorCode, ErrorMessage>> = {
  attestation_missing: msg(
    'No tier for this wallet',
    'There is no attestation at this wallet’s address on devnet. Only wallets that went through the borrow flow have one.',
  ),
  attestation_malformed: msg(
    'Record not written by the oracle',
    'The account at this wallet’s attestation address is not a tier record the oracle writes.',
  ),
  entry_malformed: msg(
    'Registry entry not written by the oracle',
    'The account at the enclave entry’s address is not a registry entry the oracle writes.',
  ),
  entry_missing: msg(
    'Enclave entry missing',
    'The attestation names an enclave build the registry has no entry for.',
  ),
  deployment_malformed: msg(
    'No archive for this build',
    'The deployment file this page was built with has no usable record for the enclave that issued the tier (no archived document or release tag), or it does not match the oracle program. A newer deploy may.',
  ),
  fetch_failed: msg(
    'GitHub could not be reached',
    'The compose file at the release tag is read from the public repository; the request failed.',
    'retry',
  ),
  hex_malformed: msg(
    'Archived document unreadable',
    'The archived attestation document bundled with this page is not hex.',
  ),
  file_unreadable: msg(
    'Archived document not loaded',
    'This tab runs an older build of the page than the server has, so the archived document could not be loaded. Reload the page.',
  ),
};

const VERIFY_GENERIC = msg(
  'Verification could not run',
  'The verifier stopped before a verdict. Try again; if it repeats, the archived document or the chain record is not what this page expects.',
  'retry',
);

export function messageFor(error: AppError): ErrorMessage {
  if (error.code === 'verify_failed') return VERIFY[error.reason] ?? VERIFY_GENERIC;
  if (error.code === 'bad_transaction') {
    return msg(
      "This page built a transaction the relayer won't sign",
      `A bug in the page, not in your wallet: the relayer signs only a plain borrow or repay for your own wallet (shape rule ${error.rule}). Reload and try again.`,
      'retry',
    );
  }
  if (error.code === 'simulation_failed') {
    return (error.custom !== undefined && ANCHOR[error.custom]) || GENERIC_SIMULATION;
  }
  if (error.code === 'invalid_amount') return msg('Invalid amount', AMOUNT[error.reason], 'retry');
  if (error.code === 'upstream_error') {
    return msg('Service error', 'A service behind the gateway refused the request.');
  }
  // Every remaining code is a plain one; the Record's type makes a missing message a compile
  // error. The `??` covers a value that isn't really an AppError at runtime (a stray throw).
  return SIMPLE[error.code] ?? SIMPLE.protocol_error;
}

const ERROR_CODES = new Set<string>([
  ...Object.keys(SIMPLE),
  'bad_transaction',
  'simulation_failed',
  'invalid_amount',
  'upstream_error',
  'verify_failed',
]);

/**
 * Whatever a query or mutation threw, as an AppError. TanStack's error type is only a cast, so
 * a stray throw (a codec RangeError, a kit signer error, WebCrypto) becomes `protocol_error`
 * instead of reaching a component as an untyped object.
 */
export function toAppError(thrown: unknown): AppError {
  return isAppError(thrown) ? thrown : { code: 'protocol_error' };
}

function isAppError(value: unknown): value is AppError {
  if (typeof value !== 'object' || value === null || !('code' in value)) return false;
  return typeof value.code === 'string' && ERROR_CODES.has(value.code);
}
