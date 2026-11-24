import {
  useCallback,
  useSyncExternalStore,
  type AnchorHTMLAttributes,
  type MouseEvent,
  type ReactNode,
} from "react";

export type InventoryView = "services" | "devices" | "map";
export type MeTab = "system" | "devices" | "settings";

/** Seis ramas: Hoy · Inventario · Actividad · Costes · Agentes · Tú. Las rutas viejas se siguen aceptando
 *  porque las usan los avisos push y el cliente infra-secrets. */
export type Route =
  | { name: "login" }
  | { name: "control" }
  | { name: "inventory"; view: InventoryView; problems?: boolean }
  | { name: "resource"; id: string }
  | { name: "activity" }
  | { name: "operation"; id: string }
  | { name: "costs" }
  | { name: "agents" }
  | { name: "secretRequest"; id: string }
  | { name: "me"; tab: MeTab }
  | { name: "password" }
  | { name: "install" }
  | { name: "catalog" }
  | { name: "notFound" };

const INVENTORY_SEGMENT: Readonly<Record<InventoryView, string | undefined>> = {
  services: undefined,
  devices: "equipos",
  map: "mapa",
};
const ME_SEGMENT: Readonly<Record<MeTab, string | undefined>> = {
  system: undefined,
  devices: "dispositivos",
  settings: "ajustes",
};

export function parseRoute(pathname: string): Route {
  const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const [first, second, third] = parts;
  if (first === undefined) return { name: "control" };
  if (first === "acceso") return { name: "login" };
  if (first === "inventario") {
    // «problemas» filtra por lo que requiere atención; va en la ruta para que los enlaces de Hoy abran la lista filtrada.
    if (second === undefined) return { name: "inventory", view: "services" };
    if (second === "problemas" && third === undefined) return { name: "inventory", view: "services", problems: true };
    if (second === "equipos" || second === "mapa") {
      const view = second === "equipos" ? "devices" : "map";
      if (third === undefined) return { name: "inventory", view };
      if (third === "problemas" && parts.length === 3) return { name: "inventory", view, problems: true };
    }
    return { name: "notFound" };
  }
  if (first === "buscar") return { name: "inventory", view: "devices" };
  if (first === "equipo" && second !== undefined)
    return { name: "resource", id: second };
  if (first === "actividad")
    return second === undefined
      ? { name: "activity" }
      : { name: "operation", id: second };
  if (first === "costes") return { name: "costs" };
  if (first === "agentes") {
    if (second === undefined) return { name: "agents" };
    if (second === "peticion" && third !== undefined) return { name: "secretRequest", id: third };
    return { name: "notFound" };
  }
  // Enlace que imprime infra-secrets y que llevan los avisos push: se conserva tal cual.
  if (first === "secretos")
    return second === undefined ? { name: "agents" } : { name: "secretRequest", id: second };
  if (first === "tu") {
    if (second === undefined) return { name: "me", tab: "system" };
    if (second === "dispositivos" && third === undefined) return { name: "me", tab: "devices" };
    if (second === "ajustes" && third === undefined) return { name: "me", tab: "settings" };
    if (second === "contrasena" && third === undefined) return { name: "password" };
    if (second === "instalar" && third === undefined) return { name: "install" };
    return { name: "notFound" };
  }
  if (first === "ajustes") {
    if (second === undefined) return { name: "me", tab: "settings" };
    // Piloto de credenciales retirado (#200) y antigua página de agentes: llevan a Agentes.
    if (second === "credenciales" || (second === "agentes" && third === undefined)) return { name: "agents" };
    if (second === "contrasena" && third === undefined)
      return { name: "password" };
    if (second === "instalar" && third === undefined)
      return { name: "install" };
    return { name: "notFound" };
  }
  if (first === "__catalogo") return { name: "catalog" };
  return { name: "notFound" };
}

export function pathFor(route: Route): string {
  switch (route.name) {
    case "login":
      return "/acceso";
    case "control":
      return "/";
    case "inventory": {
      const segment = INVENTORY_SEGMENT[route.view];
      const base = segment ? `/inventario/${segment}` : "/inventario";
      return route.problems ? `${base}/problemas` : base;
    }
    case "resource":
      return `/equipo/${encodeURIComponent(route.id)}`;
    case "activity":
      return "/actividad";
    case "operation":
      return `/actividad/${encodeURIComponent(route.id)}`;
    case "costs":
      return "/costes";
    case "agents":
      return "/agentes";
    case "secretRequest":
      return `/secretos/${encodeURIComponent(route.id)}`;
    case "me": {
      const segment = ME_SEGMENT[route.tab];
      return segment ? `/tu/${segment}` : "/tu";
    }
    case "password":
      return "/tu/contrasena";
    case "install":
      return "/tu/instalar";
    case "catalog":
      return "/__catalogo";
    case "notFound":
      return "/";
  }
}

/** Rama de la navegación a la que pertenece una ruta. */
export type Branch = "control" | "inventory" | "activity" | "costs" | "agents" | "me";
export function branchOf(route: Route): Branch | null {
  switch (route.name) {
    case "control":
    case "login":
      return "control";
    case "inventory":
    case "resource":
      return "inventory";
    case "activity":
    case "operation":
      return "activity";
    case "costs":
      return "costs";
    case "agents":
    case "secretRequest":
      return "agents";
    case "me":
    case "password":
    case "install":
      return "me";
    default:
      return null;
  }
}

export interface LocationSnapshot {
  pathname: string;
  /** Identifica la entrada del historial (para restaurar scroll). */
  key: string;
}

interface HistoryState {
  key: string;
}

function newKey(): string {
  return Math.random().toString(36).slice(2, 10);
}

function readKey(): string {
  const state = window.history.state as Partial<HistoryState> | null;
  if (state?.key) return state.key;
  const key = newKey();
  window.history.replaceState({ key } satisfies HistoryState, "");
  return key;
}

let snapshot: LocationSnapshot | null = null;
const listeners = new Set<() => void>();
const scrollMemory = new Map<string, number>();

function current(): LocationSnapshot {
  if (snapshot === null) {
    if ("scrollRestoration" in window.history)
      window.history.scrollRestoration = "manual";
    snapshot = { pathname: window.location.pathname, key: readKey() };
  }
  return snapshot;
}

function commit(next: LocationSnapshot): void {
  snapshot = next;
  listeners.forEach((listener) => listener());
}

function onPopState(): void {
  const previous = current();
  scrollMemory.set(previous.key, window.scrollY);
  commit({ pathname: window.location.pathname, key: readKey() });
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) window.addEventListener("popstate", onPopState);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0)
      window.removeEventListener("popstate", onPopState);
  };
}

export function navigate(
  destination: string | Route,
  options: { replace?: boolean } = {},
): void {
  const to =
    typeof destination === "string" ? destination : pathFor(destination);
  const previous = current();
  if (to === previous.pathname && !options.replace) return;
  scrollMemory.set(previous.key, window.scrollY);
  const key = newKey();
  const state: HistoryState = { key };
  if (options.replace) window.history.replaceState(state, "", to);
  else window.history.pushState(state, "", to);
  commit({ pathname: to, key });
}

export function savedScroll(key: string): number {
  return scrollMemory.get(key) ?? 0;
}

export function useLocation(): LocationSnapshot {
  return useSyncExternalStore(subscribe, current, current);
}

export function useRoute(): Route {
  return parseRoute(useLocation().pathname);
}

export interface LinkProps extends Omit<
  AnchorHTMLAttributes<HTMLAnchorElement>,
  "href"
> {
  to: Route | string;
  replace?: boolean;
  children?: ReactNode;
}

export function Link({ to, replace, onClick, children, ...rest }: LinkProps) {
  const href = typeof to === "string" ? to : pathFor(to);
  const handleClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      onClick?.(event);
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      if (rest.target && rest.target !== "_self") return;
      event.preventDefault();
      navigate(href, { replace });
    },
    [href, onClick, replace, rest.target],
  );
  return (
    <a {...rest} href={href} onClick={handleClick}>
      {children}
    </a>
  );
}
