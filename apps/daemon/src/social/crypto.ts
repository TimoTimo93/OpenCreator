/**
 * Mã hóa nhị phương AES-256-GCM cho secrets lưu tại máy (Page Access Token...).
 * Key 32 byte lưu tại `<dataDir>/social/secret.key`, tạo 1 lần rồi dùng lại.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

let cachedKey: Buffer | undefined;

function ensureKey(keyPath: string): Buffer {
  if (cachedKey !== undefined) return cachedKey;
  if (existsSync(keyPath)) {
    const raw = readFileSync(keyPath);
    if (raw.length === 32) {
      cachedKey = raw;
      return cachedKey;
    }
  }
  mkdirSync(dirname(keyPath), { recursive: true });
  const generated = randomBytes(32);
  writeFileSync(keyPath, generated, { mode: 0o600 });
  cachedKey = generated;
  return cachedKey;
}

export function encryptSecret(plain: string, keyPath: string): string {
  if (plain.trim() === '') return '';
  const key = ensureKey(keyPath);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

export function decryptSecret(value: string | null, keyPath: string): string {
  if (value === null || value === '') return '';
  const parts = value.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') return '';
  try {
    const iv = Buffer.from(parts[1]!, 'base64');
    const tag = Buffer.from(parts[2]!, 'base64');
    const data = Buffer.from(parts[3]!, 'base64');
    const key = ensureKey(keyPath);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}
