import {
  useCallback,
  useSyncExternalStore,
  type AnchorHTMLAttributes,
  type MouseEvent,
  type ReactNode,
} from "react";

export type Route =
  | { name: "login" }
  | { name: "control" }
  | { name: "search" }
  | { name: "resource"; id: string }
  | { name: "activity" }
  | { name: "operation"; id: string }
  | { name: "costs" }
  | { name: "settings" }
  | { name: "password" }
  | { name: "install" }
  | { name: "agents" }
  | { name: "catalog" }
  | { name: "notFound" };

export function parseRoute(pathname: string): Route {
  const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const [first, second, third] = parts;
  if (first === undefined) return { name: "control" };
  if (first === "acceso") return { name: "login" };
  if (first === "buscar") return { name: "search" };
  if (first === "equipo" && second !== undefined)
    return { name: "resource", id: second };
  if (first === "actividad")
    return second === undefined
      ? { name: "activity" }
      : { name: "operation", id: second };
  if (first === "costes") return { name: "costs" };
  if (first === "ajustes") {
    if (second === undefined) return { name: "settings" };
    if (second === "contrasena" && third === undefined)
      return { name: "password" };
    if (second === "instalar" && third === undefined)
      return { name: "install" };
    if (second === "agentes" && third === undefined) return { name: "agents" };
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
    case "search":
      return "/buscar";
    case "resource":
      return `/equipo/${encodeURIComponent(route.id)}`;
    case "activity":
      return "/actividad";
    case "operation":
      return `/actividad/${encodeURIComponent(route.id)}`;
    case "costs":
      return "/costes";
    case "settings":
      return "/ajustes";
    case "password":
      return "/ajustes/contrasena";
    case "install":
      return "/ajustes/instalar";
    case "agents":
      return "/ajustes/agentes";
    case "catalog":
      return "/__catalogo";
    case "notFound":
      return "/";
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
