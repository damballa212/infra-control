import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { IncidentPageResponse, OperationalIncident } from './operational-types.js';
import type { Store } from './store.js';

const cursorBytes = 2048;
const shortRefBytes = 16;
const nonceBytes = 12;
const tagBytes = 16;
const lengthBytes = 2;
const frameBytes = (size: number) => nonceBytes + tagBytes + lengthBytes + size;
const wireLength = (size: number) => Math.ceil(frameBytes(size) * 4 / 3);
export const RESTRICTED_CURSOR_MAX = wireLength(cursorBytes);
export const RESTRICTED_SHORT_REF_LENGTH = wireLength(shortRefBytes);

const keySetting = 'restricted-event-projection-key-v1';
function encryptionKey(store: Store): Buffer {
  const getKey = () => store.db.prepare('SELECT value FROM settings WHERE key=?').get(keySetting) as { value: string } | undefined;
  let row = getKey();
  if (!row) {
    store.db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES (?,?)').run(keySetting, randomBytes(32).toString('hex'));
    row = getKey();
  }
  if (!row || !/^[a-f0-9]{64}$/.test(row.value)) throw new Error('restricted_event_key_unavailable');
  return Buffer.from(row.value, 'hex');
}

const embeddedEventId = /^(budget|change|incident|event):\d+(?=:|$)/;
const eventLink = /event_?ids?$/i;
const cursorFields = new Set(['cursor', 'nextCursor', 'after', 'nextAfter', 'firstId', 'lastId', 'latestId']);
function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue);
  return value && typeof value === 'object' ? redactEventLinks(value as Record<string, unknown>) : value;
}

export function redactEventLinks(payload: Record<string, unknown>): Record<string, unknown> {
  const redacted: Array<[string, unknown]> = [];
  for (const [field, value] of Object.entries(payload)) {
    if (field === 'openingEventId' || field === 'lastEventId') redacted.push([field, null]);
    else if (field === 'eventIds') redacted.push([field, []]);
    else if (eventLink.test(field) || cursorFields.has(field)) continue;
    else if (field === 'id' && (typeof value === 'number' || typeof value === 'string' && /^\d+$/.test(value))) redacted.push([field, null]);
    else if (['component', 'key', 'aggregateId'].includes(field) && typeof value === 'string') redacted.push([field, value.replace(embeddedEventId, '$1')]);
    else redacted.push([field, redactValue(value)]);
  }
  return Object.fromEntries(redacted);
}

export function restrictedIncidentState(incident: OperationalIncident): OperationalIncident {
  const { recoveryEventId: _recoveryEventId, sourceContext, ...state } = incident;
  const component = /^(budget|change):\d+$/.test(state.component)
    ? `${state.component.split(':')[0]}:${state.id}` : state.component;
  const key = component === state.component ? state.key
    : state.canonicalResourceId ? `${component}:${state.canonicalResourceId}` : component;
  return { ...state, component, key, openingEventId: null, lastEventId: null,
    ...(sourceContext ? { sourceContext: { ...sourceContext, eventIds: [] } } : {}) };
}

export class RestrictedEventProjection {
  private key: Buffer | undefined;

  constructor(private readonly store: Store, private readonly principal: string) {}

  seal(purpose: string, value: string, compact = false): string {
    const size = compact ? shortRefBytes : cursorBytes;
    const bytes = Buffer.from(value, 'utf8');
    if (bytes.length > size) throw new Error('restricted_event_reference_too_long');
    const plain = Buffer.alloc(size + lengthBytes);
    plain.writeUInt16BE(bytes.length);
    bytes.copy(plain, lengthBytes);
    const nonce = randomBytes(nonceBytes);
    const cipher = createCipheriv('aes-256-gcm', this.key ??= encryptionKey(this.store), nonce);
    cipher.setAAD(Buffer.from(JSON.stringify([this.principal, purpose])));
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64url');
  }

  open(purpose: string, token: string, compact = false): string | undefined {
    const size = compact ? shortRefBytes : cursorBytes;
    if (token.length !== wireLength(size) || !/^[A-Za-z0-9_-]+$/.test(token)) return undefined;
    const wire = Buffer.from(token, 'base64url');
    if (wire.length !== frameBytes(size) || wire.toString('base64url') !== token) return undefined;
    const key = this.key ??= encryptionKey(this.store);
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, wire.subarray(0, nonceBytes));
      decipher.setAAD(Buffer.from(JSON.stringify([this.principal, purpose])));
      decipher.setAuthTag(wire.subarray(nonceBytes, nonceBytes + tagBytes));
      const plain = Buffer.concat([decipher.update(wire.subarray(nonceBytes + tagBytes)), decipher.final()]);
      const length = plain.readUInt16BE();
      return length <= size ? plain.subarray(lengthBytes, lengthBytes + length).toString('utf8') : undefined;
    } catch { return undefined; }
  }

  incidentPage(page: IncidentPageResponse, purpose: string): IncidentPageResponse {
    return { ...page, incidents: page.incidents.map(restrictedIncidentState), nextCursor: page.nextCursor === null ? null : this.seal(purpose, page.nextCursor) };
  }

  historyPage(page: Record<string, unknown>, purpose: string): Record<string, unknown> {
    const projected = redactEventLinks(page);
    for (const field of ['nextCursor', 'cursor'] as const) {
      const value = page[field];
      if (value === null) projected[field] = null;
      else if (typeof value === 'string' || typeof value === 'number' && Number.isSafeInteger(value)) projected[field] = this.seal(purpose, String(value));
    }
    return projected;
  }
}
