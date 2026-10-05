// Event decoders for the tests. The generated client (renderers-js 2.3.x, the
// last kit-7 line) doesn't render events, so decode them here: discriminators
// come from the Anchor IDL, fields follow the `#[event]` structs in
// programs/oracle/src/events.rs.
import { readFileSync } from 'node:fs';
import {
  type Address,
  type ReadonlyUint8Array,
  fixDecoderSize,
  getAddressDecoder,
  getBooleanDecoder,
  getBytesDecoder,
  getI64Decoder,
  getStructDecoder,
  getU8Decoder,
} from '@solana/kit';

const IDL_PATH = new URL('../../../../target/idl/oracle.json', import.meta.url);

/** The 8-byte discriminator of an event, read from the Anchor IDL. */
function idlDiscriminator(name: string): readonly number[] {
  const idl: unknown = JSON.parse(readFileSync(IDL_PATH, 'utf8'));
  const events: unknown =
    typeof idl === 'object' && idl !== null && 'events' in idl ? idl.events : [];
  for (const event of Array.isArray(events) ? (events as unknown[]) : []) {
    if (typeof event !== 'object' || event === null) continue;
    if (!('name' in event) || event.name !== name || !('discriminator' in event)) continue;
    const { discriminator } = event;
    if (Array.isArray(discriminator) && discriminator.length === 8) {
      return discriminator.map(Number);
    }
  }
  throw new Error(`event ${name} not in the IDL`);
}

export type EnclaveRegisteredEvent = {
  measurementId: number;
  measurementKind: number;
  measurement: ReadonlyUint8Array;
  attester: ReadonlyUint8Array;
  attestationDocHash: ReadonlyUint8Array;
};

export type EnclaveRevokedEvent = { measurementId: number };

const enclaveRegisteredDecoder = getStructDecoder([
  ['measurementId', getU8Decoder()],
  ['measurementKind', getU8Decoder()],
  ['measurement', fixDecoderSize(getBytesDecoder(), 32)],
  ['attester', fixDecoderSize(getBytesDecoder(), 20)],
  ['attestationDocHash', fixDecoderSize(getBytesDecoder(), 32)],
]);

const enclaveRevokedDecoder = getStructDecoder([['measurementId', getU8Decoder()]]);

/** Strip and check the 8-byte event discriminator; throws if it is another event. */
function eventBody(name: string, payload: Uint8Array, bodyLength: number): Uint8Array {
  const expected = idlDiscriminator(name);
  if (payload.length !== 8 + bodyLength) {
    throw new Error(`${name} payload is ${payload.length} bytes, expected ${8 + bodyLength}`);
  }
  const actual = Array.from(payload.subarray(0, 8));
  if (actual.some((byte, i) => byte !== expected[i])) {
    throw new Error(`payload is not a ${name} event`);
  }
  return payload.subarray(8);
}

// Body sizes: u8 + u8 + 32 + 20 + 32, and u8.
const ENCLAVE_REGISTERED_LEN = 86;
const ENCLAVE_REVOKED_LEN = 1;

export function parseEnclaveRegisteredEvent(payload: Uint8Array): EnclaveRegisteredEvent {
  return enclaveRegisteredDecoder.decode(
    eventBody('EnclaveRegistered', payload, ENCLAVE_REGISTERED_LEN),
  );
}

export function parseEnclaveRevokedEvent(payload: Uint8Array): EnclaveRevokedEvent {
  return enclaveRevokedDecoder.decode(eventBody('EnclaveRevoked', payload, ENCLAVE_REVOKED_LEN));
}

export type AdminProposedEvent = { admin: Address; pendingAdmin: Address };
export type AdminChangedEvent = { oldAdmin: Address; newAdmin: Address };

const adminProposedDecoder = getStructDecoder([
  ['admin', getAddressDecoder()],
  ['pendingAdmin', getAddressDecoder()],
]);
const adminChangedDecoder = getStructDecoder([
  ['oldAdmin', getAddressDecoder()],
  ['newAdmin', getAddressDecoder()],
]);
// Both admin events are two Pubkeys.
const ADMIN_EVENT_LEN = 64;

export function parseAdminProposedEvent(payload: Uint8Array): AdminProposedEvent {
  return adminProposedDecoder.decode(eventBody('AdminProposed', payload, ADMIN_EVENT_LEN));
}

export function parseAdminChangedEvent(payload: Uint8Array): AdminChangedEvent {
  return adminChangedDecoder.decode(eventBody('AdminChanged', payload, ADMIN_EVENT_LEN));
}

export type AttestationSubmittedEvent = {
  subject: Address;
  measurementId: number;
  tier: number;
  issuedAt: bigint;
  refreshed: boolean;
};

const attestationSubmittedDecoder = getStructDecoder([
  ['subject', getAddressDecoder()],
  ['measurementId', getU8Decoder()],
  ['tier', getU8Decoder()],
  ['issuedAt', getI64Decoder()],
  ['refreshed', getBooleanDecoder()],
]);
// Pubkey + u8 + u8 + i64 + bool.
const ATTESTATION_SUBMITTED_LEN = 43;

export function parseAttestationSubmittedEvent(payload: Uint8Array): AttestationSubmittedEvent {
  return attestationSubmittedDecoder.decode(
    eventBody('AttestationSubmitted', payload, ATTESTATION_SUBMITTED_LEN),
  );
}
