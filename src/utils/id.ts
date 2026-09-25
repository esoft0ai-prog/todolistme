import * as Crypto from 'expo-crypto';

/** RFC 4122 v4 UUID from the platform CSPRNG. */
export function newId(): string {
  return Crypto.randomUUID();
}

export function nowISO(): string {
  return new Date().toISOString();
}
