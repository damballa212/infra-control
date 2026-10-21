import { useEffect, useRef, type ReactNode } from "react";
import { useLocation, savedScroll, type Route } from "../lib/router.tsx";
import { useAppState } from "../app/AppState.tsx";
import { inventoryNotice } from "../lib/inventoryNotice.ts";
import { NavBar } from "./NavBar.tsx";
import { Tray } from "./Tray.tsx";
import { Banner } from "./Banner.tsx";
import { Key } from "./Key.tsx";
import { useAppUpdate } from "../hooks/useAppUpdate.ts";
import { isFixture } from "../app/providers.ts";
export function AppShell({
  route,
  children,
}: {
  route: Route;
  children: ReactNode;
}) {
  const update = useAppUpdate();
  const app = useAppState();
  const location = useLocation();
  const main = useRef<HTMLElement>(null);
  useEffect(() => {
    window.scrollTo(0, savedScroll(location.key));
    main.current?.focus({ preventScroll: true });
    document.title = `${route.name === "control" ? "Control" : route.name === "costs" ? "Costes" : route.name === "activity" ? "Actividad" : "Infra"} · Infra Control`;
  }, [location.key]);
  const notice = inventoryNotice({
    online: app.online,
    error: app.inventory.error,
    resources: app.inventory.data?.resources ?? [],
    now: app.now,
    loading: app.inventory.loading,
  });
  return (
    <div className={`shell ${!app.visible ? "app--paused" : ""}`}>
      <a href="#main-content" className="skip-link">
        Saltar al contenido
      </a>
      <NavBar route={route} />
      <main
        ref={main}
        id="main-content"
        data-inventory-ready={app.inventory.data !== null}
        tabIndex={-1}
        className="shell__main"
      >
        {isFixture && (
          <div className="prototype-label">
            PROTOTIPO · datos simulados · sin acciones reales
          </div>
        )}
        {notice && (
          <div className="system-notice">
            <Banner
              tone={notice.tone}
              glyph={notice.glyph}
              title={notice.title}
            >
              {notice.text}
            </Banner>
          </div>
        )}
        {app.writeError ? (
          <div className="system-notice">
            <Banner
              tone="warn"
              glyph="bang"
              title={
                app.ambiguous
                  ? "No sabemos si el envío llegó"
                  : "No se pudo completar la solicitud"
              }
              action={
                app.ambiguous ? (
                  <Key
                    variant="night"
                    disabled={
                      !app.online || app.sending || app.now < app.retryAt
                    }
                    loading={app.sending}
                    onClick={() => {
                      void app.submit().catch(() => undefined);
                    }}
                  >
                    Recuperar el mismo envío
                  </Key>
                ) : undefined
              }
            >
              {app.ambiguous
                ? "No vuelvas a ordenar. Recupera la respuesta usando la misma intención; no se crea otra orden."
                : app.writeError instanceof Error
                  ? app.writeError.message
                  : "Comprueba el estado antes de volver a intentar."}
            </Banner>
          </div>
        ) : null}
        {update.waiting && (
          <div className="system-notice">
            <Banner
              tone="info"
              glyph="info"
              title={
                app.sending || app.ambiguous
                  ? "Recupera el envío antes de actualizar"
                  : "Hay una versión nueva"
              }
              action={
                <Key
                  variant="night"
                  disabled={app.sending || app.ambiguous}
                  onClick={update.activate}
                >
                  Actualizar y recargar
                </Key>
              }
            >
              Las órdenes viven en el servidor. La actualización se aplica
              cuando tú decidas.
            </Banner>
          </div>
        )}
        {children}
      </main>
      <Tray />
    </div>
  );
}
