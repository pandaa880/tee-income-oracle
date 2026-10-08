/**
 * ReBIT `ErrorResponse` (AA API 2.0.0): `{ ver, txnid, timestamp, errorCode,
 * errorMsg }`. Messages are fixed per code, so they never echo request
 * data, key ids or internal error text.
 */

import { REBIT_VERSION } from '../rebit/fi-request.ts';
import { isoUtc } from '../rebit/key-material.ts';

export type RebitCode =
  | 'InvalidRequest'
  | 'SignatureDoesNotMatch'
  | 'InvalidKey'
  | 'InvalidDateRange'
  | 'InvalidConsentId'
  | 'InvalidConsentStatus'
  | 'InvalidConsentDetail'
  | 'InvalidConsentUse'
  | 'InvalidSessionId'
  | 'Unauthorized'
  | 'DataGone'
  | 'InternalError'
  | 'ServiceUnavailable';

export type RebitStatus = 400 | 401 | 404 | 410 | 413 | 500 | 503;

const ERRORS: Readonly<Record<RebitCode, { status: RebitStatus; message: string }>> = {
  InvalidRequest: { status: 400, message: 'The request body is not valid.' },
  SignatureDoesNotMatch: {
    status: 400,
    message: 'The request signature is missing, invalid or from an unregistered key.',
  },
  InvalidKey: { status: 400, message: 'A key or key binding in the request is not valid.' },
  InvalidDateRange: { status: 400, message: 'The FI data range is not valid for this consent.' },
  InvalidConsentId: { status: 400, message: 'No such consent.' },
  InvalidConsentStatus: { status: 400, message: 'The consent is not active.' },
  InvalidConsentDetail: { status: 400, message: 'The consent details do not match.' },
  InvalidConsentUse: { status: 400, message: 'The consent has already been used.' },
  InvalidSessionId: { status: 400, message: 'No such session, or it has expired.' },
  Unauthorized: { status: 401, message: 'The caller or key is not authorized.' },
  DataGone: { status: 410, message: 'The data for this session was already fetched.' },
  InternalError: { status: 500, message: 'Internal error.' },
  ServiceUnavailable: { status: 503, message: 'Service temporarily unavailable.' },
};

export interface ErrorReply {
  readonly status: RebitStatus;
  readonly body: {
    readonly ver: string;
    readonly txnid: string;
    readonly timestamp: string;
    readonly errorCode: RebitCode;
    readonly errorMsg: string;
  };
}

/** `status` overrides the code's own (413 oversize body, 404 unknown route: `InvalidRequest`). */
export function errorReply(
  code: RebitCode,
  txnid: string,
  nowUnix: number,
  status?: RebitStatus,
): ErrorReply {
  const { status: own, message } = ERRORS[code];
  return {
    status: status ?? own,
    body: {
      ver: REBIT_VERSION,
      txnid,
      timestamp: isoUtc(nowUnix),
      errorCode: code,
      errorMsg: message,
    },
  };
}
