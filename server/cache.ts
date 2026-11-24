/** Shared across all tabs and agents; failed calls also cool down. */
export class SharedCache {
  private values = new Map<string, { expires: number; promise: Promise<unknown> }>();
  constructor(private readonly now = () => Date.now()) {}
  invalidate(key: string) { this.values.delete(key); }
  get<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
    const existing = this.values.get(key);
    if (existing && existing.expires > this.now()) return existing.promise as Promise<T>;
    const entry = { expires: this.now() + ttl, promise: Promise.resolve().then(load) };
    this.values.set(key, entry);
    return entry.promise;
  }
}
