import { useRoute } from "../lib/router.tsx";
import { SessionProvider, useSession } from "./Session.tsx";
import { AppStateProvider } from "./AppState.tsx";
import { AppShell } from "../components/AppShell.tsx";
import { Login } from "../screens/Login.tsx";
import { Hoy } from "../screens/Hoy.tsx";
import { Inventory } from "../screens/Inventory.tsx";
import { ResourceScreen } from "../screens/Resource.tsx";
import { Activity, OperationScreen } from "../screens/Activity.tsx";
import { Costs } from "../screens/Costs.tsx";
import { Agents } from "../screens/Agents.tsx";
import { SecretRequestDetail } from "../screens/SecretRequestDetail.tsx";
import { Me, Password, Install } from "../screens/Me.tsx";
import { Catalog } from "../screens/Catalog.tsx";
import { Link } from "../lib/router.tsx";
import { isFixture } from "./providers.ts";

function PrivateApp() {
  const route = useRoute();
  const screen = (() => {
    switch (route.name) {
      case "control":
      case "login":
        return <Hoy />;
      case "inventory":
        return <Inventory view={route.view} problems={route.problems ?? false} />;
      case "resource":
        return <ResourceScreen key={route.id} id={route.id} />;
      case "activity":
        return <Activity />;
      case "operation":
        return <OperationScreen key={route.id} id={route.id} />;
      case "costs":
        return <Costs />;
      case "agents":
        return <Agents />;
      case "secretRequest":
        return <SecretRequestDetail key={route.id} id={route.id} />;
      case "me":
        return <Me tab={route.tab} />;
      case "password":
        return <Password />;
      case "install":
        return <Install />;
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
    <div className="page stack gap-14">
      <h1 className="page__title">No encontramos esa página</h1>
      <Link to="/" className="btn btn--secondary" style={{ justifySelf: "start", alignSelf: "flex-start" }}>
        Volver a Hoy
      </Link>
    </div>
  );
}
function Gate() {
  const session = useSession();
  if (session.checking)
    return (
      <div className="page">
        <p role="status" className="t-small">Comprobando sesión…</p>
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
