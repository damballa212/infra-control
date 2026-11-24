import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const RETAINED = 250;
type Entry<T> = { position: number; value: T };

/** Una instancia por credencial y política. Solo recibe eventos autorizados. */
export class RestrictedEventReplay<T> {
  private readonly key = randomBytes(32);
  private readonly entries: Entry<T>[] = [];
  private position = 0;

  get latest(): number { return this.position; }

  append(value: T): void {
    this.entries.push({ position: ++this.position, value });
    if (this.entries.length > RETAINED) this.entries.shift();
  }

  after(position: number): Entry<T>[] | undefined {
    if (position > this.position || position < this.position - this.entries.length) return undefined;
    return this.entries.filter(entry => entry.position > position);
  }

  encode(position: number): string {
    const iv = randomBytes(12);
    const clear = Buffer.alloc(8);
    clear.writeBigUInt64BE(BigInt(position));
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    return Buffer.concat([iv, cipher.update(clear), cipher.final(), cipher.getAuthTag()]).toString('base64url');
  }

  decode(token: string): number | undefined {
    if (!/^[A-Za-z0-9_-]{48}$/.test(token)) return undefined;
    const wire = Buffer.from(token, 'base64url');
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, wire.subarray(0, 12));
      decipher.setAuthTag(wire.subarray(20));
      const value = Number(Buffer.concat([decipher.update(wire.subarray(12, 20)), decipher.final()]).readBigUInt64BE());
      return Number.isSafeInteger(value) ? value : undefined;
    } catch { return undefined; }
  }
}
