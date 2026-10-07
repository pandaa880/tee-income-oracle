// Test code only. Awaits a promise that must reject with a GatewayError and checks its fields.
import { expect } from 'vitest';

import { GatewayError, type Stage } from '../errors.ts';

export type ExpectedError = { code: string; stage: Stage; status?: number };

export async function expectRejected(
  promise: Promise<unknown>,
  expected: ExpectedError,
): Promise<GatewayError> {
  let caught: unknown;
  try {
    await promise;
  } catch (e) {
    caught = e;
  }
  expect(caught, 'expected the promise to reject').toBeInstanceOf(GatewayError);
  if (!(caught instanceof GatewayError)) {
    throw new Error('unreachable: not a GatewayError');
  }
  expect({ code: caught.code, stage: caught.stage }).toEqual({
    code: expected.code,
    stage: expected.stage,
  });
  if (expected.status !== undefined) {
    expect(caught.status).toBe(expected.status);
  }
  return caught;
}

/** Same for a synchronous throw. */
export function expectThrown(fn: () => unknown, expected: ExpectedError): GatewayError {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught, 'expected the call to throw').toBeInstanceOf(GatewayError);
  if (!(caught instanceof GatewayError)) {
    throw new Error('unreachable: not a GatewayError');
  }
  expect({ code: caught.code, stage: caught.stage }).toEqual({
    code: expected.code,
    stage: expected.stage,
  });
  if (expected.status !== undefined) {
    expect(caught.status).toBe(expected.status);
  }
  return caught;
}
