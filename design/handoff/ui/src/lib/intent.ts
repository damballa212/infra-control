import type { OperationRequest } from "../contract.ts";
import { ProviderError } from "../../../integration/provider.ts";
import { newIdempotencyKey } from "./idempotency.ts";
/** One in-memory intent. Ambiguous writes are recovered explicitly using the identical payload/key. */
export class IntentController<T> {
  private pending: { request: OperationRequest; key: string } | null = null;
  private sending = false;
  ambiguous = false;
  constructor(
    private readonly send: (
      request: OperationRequest,
      key: string,
    ) => Promise<T>,
  ) {}
  get resourceId() {
    return this.pending?.request.resourceId ?? null;
  }
  async submit(request: OperationRequest): Promise<T> {
    if (this.sending || this.pending)
      throw new Error("Comprueba la orden anterior antes de enviar otra");
    this.pending = { request: { ...request }, key: newIdempotencyKey() };
    return this.execute();
  }
  async recover(): Promise<T> {
    if (this.sending || !this.pending || !this.ambiguous)
      throw new Error("No hay un envío pendiente que recuperar");
    return this.execute();
  }
  private async execute(): Promise<T> {
    const pending = this.pending;
    if (!pending) throw new Error("Falta la intención");
    this.sending = true;
    try {
      const operation = await this.send(pending.request, pending.key);
      this.pending = null;
      this.ambiguous = false;
      return operation;
    } catch (error) {
      this.ambiguous =
        this.ambiguous || (error instanceof ProviderError && error.ambiguous);
      if (!this.ambiguous) this.pending = null;
      throw error;
    } finally {
      this.sending = false;
    }
  }
}
