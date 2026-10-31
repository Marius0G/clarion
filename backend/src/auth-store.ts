import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AuthStore } from './auth.js';
/** Node's local store also holds the WhatsApp profiles and pending join tokens. */
export class FileAuthStore implements AuthStore {
  private values: Map<string, unknown>;
  constructor(private file: string) {
    this.values = new Map(existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : []);
    // Expired auth/join records need not survive a restart.
    for (const [key, value] of this.values) {
      const expiry = (value as { expiresAt?: number })?.expiresAt;
      if (expiry !== undefined && expiry <= Date.now()) this.values.delete(key);
    }
  }
  private save() {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileSync(this.file + '.tmp', JSON.stringify([...this.values]), { mode: 0o600 });
    renameSync(this.file + '.tmp', this.file);
  }
  async get<T>(key: string) { return structuredClone(this.values.get(key)) as T | undefined; }
  async put(key: string, value: unknown) { this.values.set(key, structuredClone(value)); this.save(); }
  async delete(key: string) { const deleted = this.values.delete(key); if (deleted) this.save(); return deleted; }
  async list<T>({ prefix }: { prefix: string }) {
    return new Map([...this.values].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v) as T]));
  }
}
