/** Contrato con la bóveda de secretos. Vaultwarden (vía `bw`) lo implementará en la fase F1. */
export type VaultItem = { itemRef: string; name: string; updatedAt: string };
export type VaultTarget = { collection: string; name: string };

export interface VaultAdapter {
  /** Crea o actualiza el ítem `name` de la colección y devuelve su referencia estable. */
  put(target: VaultTarget, value: string): Promise<string>;
  /** Devuelve el valor. Lanza si el ítem no existe o la bóveda no responde. */
  get(itemRef: string): Promise<string>;
  /** Lista metadatos (nunca valores) de una colección. */
  list(collection: string): Promise<VaultItem[]>;
}

/** Bóveda en memoria para pruebas y desarrollo local; no persiste nada. */
export class MemoryVault implements VaultAdapter {
  putCount = 0;
  failNextGet = false;
  private readonly items = new Map<string, { collection: string; name: string; value: string; updatedAt: string }>();
  private sequence = 0;

  constructor(private readonly clock: () => string = () => new Date().toISOString()) {}

  async put(target: VaultTarget, value: string): Promise<string> {
    this.putCount += 1;
    for (const [itemRef, item] of this.items) {
      if (item.collection === target.collection && item.name === target.name) {
        this.items.set(itemRef, { ...item, value, updatedAt: this.clock() });
        return itemRef;
      }
    }
    this.sequence += 1;
    const itemRef = `item-${this.sequence}`;
    this.items.set(itemRef, { ...target, value, updatedAt: this.clock() });
    return itemRef;
  }

  async get(itemRef: string): Promise<string> {
    if (this.failNextGet) {
      this.failNextGet = false;
      throw new Error('vault down');
    }
    const item = this.items.get(itemRef);
    if (!item) throw new Error('item not found');
    return item.value;
  }

  async list(collection: string): Promise<VaultItem[]> {
    return [...this.items.entries()]
      .filter(([, item]) => item.collection === collection)
      .map(([itemRef, item]) => ({ itemRef, name: item.name, updatedAt: item.updatedAt }));
  }
}
