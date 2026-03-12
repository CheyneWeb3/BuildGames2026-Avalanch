import crypto from 'node:crypto';

// Simple AES-256-GCM box for storing session private keys at rest.
// Format: base64( iv(12) | tag(16) | ciphertext )

function keyFromHex(hex: string): Buffer {
  const h = String(hex || '').trim();
  if (!/^[a-f0-9]{64}$/i.test(h)) {
    throw new Error('SESSION_KEY_ENC_SECRET must be 32 bytes hex (openssl rand -hex 32)');
  }
  return Buffer.from(h, 'hex');
}

export function encryptBox(secretHex: string, plaintext: string): string {
  const key = keyFromHex(secretHex);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(String(plaintext), 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

export function decryptBox(secretHex: string, payloadB64: string): string {
  const key = keyFromHex(secretHex);
  const raw = Buffer.from(String(payloadB64 || ''), 'base64');
  if (raw.length < 12 + 16 + 1) throw new Error('bad cipher payload');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ct = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
}
