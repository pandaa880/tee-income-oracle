// One place that turns every expected failure into words. Pages never write their own.
import type { AmountProblem, AppError, ClientCode, GatewayCode } from './types.ts';

export type ErrorMessage = { title: string; detail: string; retry: boolean };

const msg = (title: string, detail: string, retry = false): ErrorMessage => ({
  title,
  detail,
  retry,
});

const SIMPLE: Record<GatewayCode | ClientCode, ErrorMessage> = {
  bad_request: msg('Request rejected', 'The service did not accept this request.'),
  not_found: msg('Not found', 'The service has no such endpoint.'),
  session_not_found: msg('Session ended', 'This session was already used or closed. Start again.'),
  session_expired: msg('Session expired', 'The consent window closed. Start again.'),
  body_too_large: msg('Request too large', 'The request was larger than the service accepts.'),
  rate_limited: msg('Too many requests', 'Wait a moment and try again.', true),
  relay_in_flight: msg('Already sending', 'A loan transaction for this wallet is in flight.', true),
  sponsorship_exhausted: msg(
    'Sponsorship used up',
    'The demo has funded its hourly quota of new token accounts. Try later.',
  ),
  internal_error: msg('Service error', 'The service failed unexpectedly.'),
  too_many_sessions: msg('Busy', 'Too many sessions are open right now. Try again shortly.'),
  upstream_unavailable: msg('Bank or enclave unreachable', 'A service behind the gateway is down.'),
  enclave_rotated: msg('Enclave restarted', 'The enclave key changed mid-session. Start again.'),
  stale_attestation: msg('Newer result on chain', 'A newer attestation already exists for you.'),
  tx_failed: msg('Transaction failed', 'The transaction did not confirm on chain.'),
  enclave_not_registered: msg('Enclave not registered', 'The running enclave is not on chain.'),
  enclave_revoked: msg('Enclave revoked', 'The enclave build was revoked; results are refused.'),
  attester_mismatch: msg('Enclave mismatch', 'The enclave key differs from the registry.'),
  protocol_error: msg('Unexpected reply', 'The service answered in a format we do not accept.'),
  cancelled: msg('Cancelled', 'The request was cancelled.'),
  network: msg('Network problem', 'The service could not be reached.', true),
  rpc_busy: msg('Network busy', 'The Solana RPC is rate-limiting; retrying shortly.', true),
  timeout: msg('Timed out', 'No confirmation arrived in time.', true),
  signing_failed: msg('Signing failed', 'The wallet could not sign the request.', true),
  loan_exists: msg('Loan already open', 'Repay the open loan in this pool before borrowing again.'),
  no_open_loan: msg('No open loan', 'There is no loan in this pool to repay.'),
};

/** demo_pool borrow/repay errors (FORMATS §14) seen in `simulation_failed.custom`. */
const ANCHOR: Record<number, ErrorMessage> = {
  6002: msg('Amount required', 'Enter an amount above zero.'),
  6003: msg('No valid attestation', 'The attestation account is not a valid tier record.'),
  6004: msg('Wrong attester', 'The attestation was not written by the oracle.'),
  6005: msg('Attestation expired', 'Your tier has expired. Re-attest to borrow.'),
  6006: msg('Tier not accepted', 'This pool does not lend to your tier.'),
  6007: msg('Over the limit', 'The amount is above what this pool lends to your tier.'),
  6008: msg(
    'Policy changed',
    'The lender changed its rules since your tier was issued. Re-attest under the new policy.',
  ),
  6009: msg('Attestation too old', 'Your tier is older than this pool accepts. Re-attest.'),
  6010: msg('Statement too old', 'The statement window is older than this pool accepts.'),
  6011: msg('Statement too short', 'The statement covers less time than this pool requires.'),
  6012: msg('Enclave not approved', 'This pool does not accept the enclave build that scored you.'),
  6013: msg('Enclave record mismatch', 'The enclave record does not match your attestation.'),
  6014: msg('Enclave revoked', 'The enclave build that scored you was revoked. Re-attest.'),
};

const GENERIC_SIMULATION = msg(
  'Transaction refused',
  'The program refused the transaction in simulation; nothing was spent.',
);

const AMOUNT: Record<AmountProblem, string> = {
  empty: 'Enter an amount.',
  zero: 'The amount must be above zero.',
  negative: 'The amount cannot be negative.',
  too_many_decimals: 'Use at most 6 decimal places.',
  not_a_number: 'Use digits and one decimal point, like 12.5.',
  over_limit: 'The amount is above your limit.',
};

export function messageFor(error: AppError): ErrorMessage {
  if (error.code === 'bad_transaction') {
    return msg('Transaction rejected', `The relayer refused it (shape rule ${error.rule}).`);
  }
  if (error.code === 'simulation_failed') {
    return (error.custom !== undefined && ANCHOR[error.custom]) || GENERIC_SIMULATION;
  }
  if (error.code === 'invalid_amount') return msg('Invalid amount', AMOUNT[error.reason]);
  if (error.code === 'upstream_error') {
    return msg('Service error', 'A service behind the gateway refused the request.');
  }
  // Every remaining code is a plain one; the Record's type makes a missing message a compile error.
  return SIMPLE[error.code];
}
