import { z } from 'zod';

/*
 * The two identifier shapes of every record. A record id also names its file, so the identifier
 * pattern guards paths as much as it describes a format. Tool parameters reuse the same strings.
 * The pattern text is part of the judge's response schema and so of JUDGE_PROTOCOL: keep it byte-for-byte.
 */
export const identifierPattern = '^[a-zA-Z0-9_-]{1,80}$';
export const sha256Pattern = '^[a-f0-9]{64}$';
const IDENTIFIER = new RegExp(identifierPattern);
const SHA256 = new RegExp(sha256Pattern);
/** Keys an object treats specially: never an id, so an id can always key a map or an object. */
const RESERVED = new Set(['__proto__', 'prototype', 'constructor']);

export const isIdentifier = (value: string): boolean => IDENTIFIER.test(value) && !RESERVED.has(value);
export const isSha256 = (value: string): boolean => SHA256.test(value);
export const identifierSchema = z.string().regex(IDENTIFIER).refine(value => !RESERVED.has(value), 'Reserved identifier');
export const sha256Schema = z.string().regex(SHA256);
