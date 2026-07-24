import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface SessionCipher {
  protect(plaintext: string): string;
  unprotect(ciphertext: string): string;
}

export class AesGcmSessionCipher implements SessionCipher {
  constructor(private readonly key: Buffer) {
    if (key.byteLength !== 32) {
      throw new Error('SESSION_ENCRYPTION_KEY must decode to exactly 32 bytes.');
    }
  }

  protect(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [
      'v1',
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      encrypted.toString('base64url'),
    ].join('.');
  }

  unprotect(ciphertext: string): string {
    const [version, encodedIv, encodedTag, encodedPayload] = ciphertext.split('.');
    if (
      version !== 'v1' ||
      encodedIv === undefined ||
      encodedTag === undefined ||
      encodedPayload === undefined
    ) {
      throw new Error('SESSION_CIPHERTEXT_INVALID');
    }
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(encodedIv, 'base64url'));
    decipher.setAuthTag(Buffer.from(encodedTag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(encodedPayload, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }
}
