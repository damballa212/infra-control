import { useRoute } from "../lib/router.tsx";
import { SessionProvider, useSession } from "./Session.tsx";
import { AppStateProvider, useAppState } from "./AppState.tsx";
import { AppShell } from "../components/AppShell.tsx";
import { Login } from "../screens/Login.tsx";
import { Control } from "../screens/Control.tsx";
import { Search } from "../screens/Search.tsx";
import { Activity, OperationScreen } from "../screens/Activity.tsx";
import { Costs } from "../screens/Costs.tsx";
import { Settings, Password, Install, Agents } from "../screens/Settings.tsx";
import { Catalog } from "../screens/Catalog.tsx";
import { ResourceDetail } from "../components/ResourceDetail.tsx";
import { BackKey } from "../components/Key.tsx";
import { isFixture } from "./providers.ts";
function ResourceScreen({ id }: { id: string }) {
  const app = useAppState();
  const resource = app.inventory.data?.resources.find((r) => r.id === id);
  return (
    <div className="page stack gap-26">
      <BackKey to="/">Control</BackKey>
      <h1 className="visually-hidden">Detalle del equipo</h1>
      {resource ? (
        <ResourceDetail key={resource.id} resource={resource} />
      ) : (
        <p>
          {app.inventory.loading
            ? "Consultando equipo…"
            : "Equipo no encontrado o inventario inaccesible."}
        </p>
      )}
    </div>
  );
}
function PrivateApp() {
  const route = useRoute();
  const screen = (() => {
    switch (route.name) {
      case "control":
      case "login":
        return <Control />;
      case "search":
        return <Search />;
      case "resource":
        return <ResourceScreen id={route.id} />;
      case "activity":
        return <Activity />;
      case "operation":
        return <OperationScreen key={route.id} id={route.id} />;
      case "costs":
        return <Costs />;
      case "settings":
        return <Settings />;
      case "password":
        return <Password />;
      case "install":
        return <Install />;
      case "agents":
        return <Agents />;
      case "catalog":
        return isFixture ? <Catalog /> : <NotFound />;
      default:
        return <NotFound />;
    }
  })();
  return <AppShell route={route}>{screen}</AppShell>;
}
function NotFound() {
  return (
    <div className="page stack gap-26">
      <h1 className="t-h1">No encontramos esa página</h1>
      <BackKey to="/">Control</BackKey>
    </div>
  );
}
function Gate() {
  const session = useSession();
  if (session.checking)
    return (
      <div className="page">
        <p role="status">Comprobando sesión…</p>
      </div>
    );
  if (!session.user) return <Login />;
  return (
    <AppStateProvider>
      <PrivateApp />
    </AppStateProvider>
  );
}
export function App() {
  return (
    <SessionProvider>
      <Gate />
    </SessionProvider>
  );
}
