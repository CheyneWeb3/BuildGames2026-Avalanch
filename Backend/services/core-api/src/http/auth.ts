import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { ethers } from 'ethers';

export type JwtClaims = {
  sub: string; // user address (lower)
  roles?: string[];
};

export function makeNonce(): string {
  return crypto.randomBytes(16).toString('hex');
}

export function signJwt(addressLower: string, jwtSecret: string, roles: string[] = []): string {
  const claims: JwtClaims = { sub: addressLower, roles };
  return jwt.sign(claims, jwtSecret, { algorithm: 'HS256', expiresIn: '24h' });
}

export function verifyJwt(token: string, jwtSecret: string): JwtClaims {
  return jwt.verify(token, jwtSecret) as JwtClaims;
}

export function buildLoginMessage(addressLower: string, nonce: string): string {
  // Keep stable to avoid replay across apps.
return `THE HAUS LOGIN\n\nAddress: ${addressLower}\nNonce: ${nonce}`;
}

export function recoverLoginSigner(message: string, signature: string): string {
  return ethers.verifyMessage(message, signature).toLowerCase();
}
