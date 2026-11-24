import { useEffect, useRef, type ReactNode } from "react";
import { useLocation, savedScroll, branchOf, type Route } from "../lib/router.tsx";
import { useAppState } from "../app/AppState.tsx";
import { NavBar } from "./NavBar.tsx";
import { Tray } from "./Tray.tsx";
import { Banner } from "./Banner.tsx";
import { Key } from "./Key.tsx";
import { useAppUpdate } from "../hooks/useAppUpdate.ts";
import { isFixture } from "../app/providers.ts";

const BRANCH_TITLE: Readonly<Record<NonNullable<ReturnType<typeof branchOf>>, string>> = {
  control: "Hoy",
  inventory: "Inventario",
  activity: "Actividad",
  costs: "Costes",
  agents: "Agentes",
  me: "Tú",
};

export function AppShell({ route, children }: { route: Route; children: ReactNode }) {
  const update = useAppUpdate();
  const app = useAppState();
  const location = useLocation();
  const main = useRef<HTMLElement>(null);
  useEffect(() => {
    window.scrollTo(0, savedScroll(location.key));
    main.current?.focus({ preventScroll: true });
    const branch = branchOf(route);
    document.title = `${branch ? BRANCH_TITLE[branch] : "Infra"} · Infra Control`;
  }, [location.key]);
  return (
    <div className={`shell ${!app.visible ? "app--paused" : ""}`}>
      <div className="hairline" aria-hidden="true" />
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
        <div className="shell__notices">
          {isFixture && <div className="prototype-label">PROTOTIPO · datos simulados · sin acciones reales</div>}
          {!app.online && (
            <div className="system-notice">
              <Banner tone="night" glyph="bang" title="Sin conexión">
                Ves la última lectura de esta sesión. No se envían órdenes ni se dejan en cola.
              </Banner>
            </div>
          )}
          {app.writeError || app.ambiguous ? (
            <div className="system-notice">
              <Banner
                tone="warn"
                glyph="bang"
                title={app.ambiguous ? "No sabemos si el envío llegó" : "No se pudo completar la solicitud"}
                action={
                  app.ambiguous ? (
                    <Key
                      variant="sun"
                      size="sm"
                      disabled={!app.online || app.sending || app.now < app.retryAt}
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
                title={app.sending || app.ambiguous ? "Recupera el envío antes de actualizar" : "Hay una versión nueva"}
                action={
                  <Key variant="sun" size="sm" disabled={app.sending || app.ambiguous} onClick={update.activate}>
                    Actualizar y recargar
                  </Key>
                }
              >
                Las órdenes viven en el servidor. La actualización se aplica cuando tú decidas.
              </Banner>
            </div>
          )}
        </div>
        {children}
      </main>
      <Tray />
    </div>
  );
}
