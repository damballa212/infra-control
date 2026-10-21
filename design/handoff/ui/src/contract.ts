// COPIA TIPADA del contrato público (../../../../contracts/api.ts + server/types.ts + server/costs.ts).
// La UI no importa nada de server/. `checks/contract-sync.ts` comprueba en tiempo de compilación que esta copia
// sigue siendo idéntica al contrato real; si el backend cambia, ese check falla y hay que actualizar este archivo.

export type Action = "start" | "stop" | "refresh" | "boot-windows" | "boot-cachyos";

export type ResourceKind = "ec2" | "service" | "router" | "computer";

export type Resource = {
  id: string;
  name: string;
  kind: ResourceKind;
  state: string;
  location: string;
  account: string;
  detail: string;
  actions: Action[];
  observedAt: string | null;
  note?: string;
  system?: "windows" | "cachyos";
};

export type OperationState =
  "accepted" | "running" | "succeeded" | "failed" | "uncertain";

export type Operation = {
  id: string;
  resourceId: string;
  resourceName: string;
  action: Action;
  actor: string;
  state: OperationState;
  message: string;
  createdAt: string;
  updatedAt: string;
};

export type CostAccount = {
  account: string;
  status: "available" | "partial" | "unavailable";
  net: number | null;
  usage: number | null;
  adjustments: number | null;
  currency: string;
  estimated: boolean;
  services: { name: string; amount: number }[];
  daily: { date: string; amount: number }[];
  budgetsStatus: "available" | "unavailable" | "partial";
  budgets: {
    name: string;
    limit: number | null;
    actual: number | null;
    forecast: number | null;
    currency: string;
    updatedAt: string | null;
  }[];
  fetchedAt: string;
};

export type CostReport = {
  accounts: CostAccount[];
  fetchedAt: string;
  nextRefreshAt: string;
  periodStart: string;
  periodEnd: string;
  policy: string;
};

export type ResourcesResponse = {
  resources: Resource[];
  fetchedAt: string;
  refreshSeconds: number;
};
export type OperationsResponse = { operations: Operation[] };
export type OperationRequest = {
  resourceId: string;
  action: Action;
  confirmed?: boolean;
};
export type ApiError = { error: string };
export type AuthUser = {
  name: string;
  agent?: boolean;
  scopes?: ("read" | "operate")[];
};

export type BootSystem = "windows" | "cachyos";

/** Sistema que la PC arranca sola (corte de luz, encendido remoto). Copia de DesktopBootPreferenceResponse. */
export type BootPreference = {
  desired: BootSystem | null;
  effective: BootSystem | null;
  state: "unknown" | "pending" | "applying" | "applied" | "uncertain" | "failed" | "drift";
  version: number;
  requestedAt?: string;
  verifiedAt?: string;
  observedAt?: string;
  message?: string;
};
