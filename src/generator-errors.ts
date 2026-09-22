/** A complete provider reply was received and charged, but none of its attempts passed validation. */
export class InvalidGeneratorResponse extends Error {
  readonly code = 'GENERATOR_INVALID_RESPONSE';
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = 'InvalidGeneratorResponse'; }
}
