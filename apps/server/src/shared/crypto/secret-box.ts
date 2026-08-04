import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { APP_ENV, type AppEnv } from '../../config/env';

/**
 * AES-256-GCM secret encryption (§12). Layout: iv(12) | authTag(16) | ciphertext.
 * The key comes from AGENTFORGE_SECRET_KEY (32-byte base64); plaintext exists
 * only in worker memory at provisioning time.
 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(keyBase64: string) {
    const key = Buffer.from(keyBase64, 'base64');
    if (key.length !== 32) {
      throw new Error('AGENTFORGE_SECRET_KEY must be 32 bytes of base64');
    }
    this.key = key;
  }

  encrypt(plaintext: string): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
  }

  decrypt(box: Buffer): string {
    const iv = box.subarray(0, 12);
    const tag = box.subarray(12, 28);
    const ciphertext = box.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }
}

@Injectable()
export class SecretBoxService extends SecretBox {
  constructor(@Inject(APP_ENV) env: AppEnv) {
    super(env.AGENTFORGE_SECRET_KEY);
  }
}
