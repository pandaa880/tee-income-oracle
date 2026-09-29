/** Key-exchange error codes, same strings as tio-core (FORMATS §10). */
export type KeyErrorCode = 'bad_key_material' | 'invalid_point';

/** A peer key that can't be used: unknown encoding, or a bad point. */
export class KeyError extends Error {
  override readonly name = 'KeyError';
  readonly code: KeyErrorCode;

  constructor(code: KeyErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.code = code;
  }
}
