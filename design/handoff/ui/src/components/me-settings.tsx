import { useState } from "react";
import { useAppState } from "../app/AppState.tsx";
import { useSession } from "../app/Session.tsx";
import { Icon } from "./ui.tsx";
import { Card, IconTile, Row, Rows } from "./v2.tsx";

/** Tú › Ajustes: sesión, contraseña, instalar la app y apariencia. */
export function SettingsTab() {
  const app = useAppState(); const session = useSession();
  const [busy, setBusy] = useState(false); const [error, setError] = useState(false);
  const name = session.user?.name ?? "Sesión personal";
  const logout = async () => { if (busy || !app.online) return; setBusy(true); setError(false); try { await session.logout(); } catch { setError(true); } finally { setBusy(false); } };
  return <div className="v2-grid v2-grid--2">
    <div className="v2-stack">
      <Card title="Sesión" flush id="me-session">
        <Rows><li><Row lead={<span className="me-avatar" aria-hidden="true">{name.slice(0, 1).toLocaleUpperCase("es")}</span>} title={name} sub="Este navegador · dura hasta 7 días" /></li></Rows>
        <div className="ag-pad">
          <button className="btn ag-btn ag-btn--block ag-btn--danger" type="button" disabled={busy || !app.online} onClick={() => void logout()}>{busy ? "Cerrando sesión…" : "Cerrar sesión en este dispositivo"}</button>
          {!app.online && <p className="ag-line">Sin conexión: no se puede confirmar el cierre.</p>}
          {error && <p className="ag-line ag-line--bad" role="alert">No se pudo confirmar el cierre de sesión. Inténtalo cuando vuelva la conexión.</p>}
        </div>
      </Card>
    </div>
    <div className="v2-stack">
      <Card title="Cuenta y app" flush id="me-account">
        <Rows>
          <li><Row to={{ name: "password" }} lead={<IconTile><Icon name="lock" /></IconTile>} title="Contraseña" sub="Cambiarla cierra todas las sesiones" /></li>
          <li><Row to={{ name: "install" }} lead={<IconTile><Icon name="home" /></IconTile>} title="Instalar la app" sub="En la pantalla de inicio del teléfono" /></li>
          <li><Row lead={<IconTile><Icon name="settings" /></IconTile>} title="Apariencia" trailing={<span className="me-value">Según el sistema</span>} /></li>
        </Rows>
      </Card>
    </div>
  </div>;
}
