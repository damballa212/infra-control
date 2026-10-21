import { useState } from "react";
import { useSession } from "../app/Session.tsx";
import { useAppState } from "../app/AppState.tsx";
import { provider } from "../app/providers.ts";
import { ProviderError } from "../../../integration/provider.ts";
import { useNow } from "../hooks/usePlatform.ts";
import { Panel } from "../components/Panel.tsx";
import { BackKey, Key, LinkKey } from "../components/Key.tsx";
import { TextField, Segmented } from "../components/Fields.tsx";
import { Banner } from "../components/Banner.tsx";
import { Pill } from "../components/Pill.tsx";
import { formatCountdown } from "../lib/format.ts";
export function Settings() {
  const session = useSession();
  const app = useAppState();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const logout = async () => {
    setBusy(true);
    try {
      await session.logout();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="page stack gap-26">
      <BackKey to="/">Control</BackKey>
      <header>
        <p className="t-label">SECUNDARIO</p>
        <h1 className="t-h1 mt-8">Ajustes</h1>
      </header>
      <Panel tone="paper" accent="violet">
        <h2 className="t-h3">{session.user?.name}</h2>
        <p className="t-small mt-12">
          Sesión en este dispositivo · duración máxima 7 días
        </p>
        <LinkKey className="mt-22" variant="paper" to={{ name: "password" }}>
          Cambiar contraseña ▸
        </LinkKey>
        <Key
          className="mt-22"
          variant="danger"
          block
          disabled={busy || !app.online}
          loading={busy}
          onClick={() => void logout()}
        >
          Cerrar sesión en este dispositivo
        </Key>
        {error && (
          <p className="field-error mt-18" role="alert">
            No se pudo confirmar el cierre de sesión. Intenta cuando vuelva la
            conexión.
          </p>
        )}
      </Panel>
      <Panel tone="paper" accent="violet">
        <p className="t-label">APP</p>
        <LinkKey className="mt-18" variant="sun" to={{ name: "install" }}>
          Instalar en el teléfono ▸
        </LinkKey>
        <p className="t-small mt-22">App 0.1.0</p>
      </Panel>
      <Panel tone="night">
        <p className="t-label">INTEGRACIÓN</p>
        <h2 className="t-h3 mt-8">Agentes y API</h2>
        <p className="t-small mt-12">
          Los agentes usan su propio token; nunca se muestra aquí.
        </p>
        <LinkKey className="mt-22" variant="cream" to={{ name: "agents" }}>
          Ver integración ▸
        </LinkKey>
      </Panel>
      <Panel tone="paper">
        <p className="t-label">CUÁNTO CONSULTA</p>
        <div className="line mt-12">
          <span>Equipos</span>
          <span>cada 60 s</span>
        </div>
        <div className="line">
          <span>Actividad</span>
          <span>5 s si hay órdenes</span>
        </div>
        <div className="line">
          <span>Costes</span>
          <span>caché 24 h</span>
        </div>
        <p className="t-small mt-14">
          En segundo plano o sin conexión no consulta nada.
        </p>
      </Panel>
    </div>
  );
}
export function Password() {
  const session = useSession();
  const app = useAppState();
  const now = useNow(1000);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deadline, setDeadline] = useState(0);
  const wait = Math.max(0, Math.ceil((deadline - now) / 1000));
  const valid =
    next.length >= 16 &&
    next.length <= 256 &&
    next === repeat &&
    current.length > 0;
  const submit = async () => {
    if (!valid || busy || wait > 0 || !app.online) return;
    setBusy(true);
    setError(null);
    try {
      await provider.changePassword(current, next);
      setCurrent("");
      setNext("");
      setRepeat("");
      session.expire();
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo cambiar");
      if (e instanceof ProviderError && e.status === 429)
        setDeadline(Date.now() + (e.retryAfterSeconds ?? 900) * 1000);
      if (e instanceof ProviderError && e.status === 401) {
        try {
          await provider.getSession();
          setError("La contraseña actual no es correcta.");
        } catch (check) {
          if (check instanceof ProviderError && check.status === 401)
            session.expire();
        }
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="page stack gap-26">
      <BackKey to={{ name: "settings" }}>Ajustes</BackKey>
      <h1 className="t-h1">Contraseña</h1>
      <p>
        Al cambiarla se cierran todas las sesiones abiertas. Después entra con
        la contraseña nueva.
      </p>
      <form
        className="stack gap-26"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <TextField
          label="Contraseña actual"
          type="password"
          value={current}
          onChange={setCurrent}
          autoComplete="current-password"
        />
        <TextField
          label="Contraseña nueva"
          type="password"
          value={next}
          onChange={setNext}
          autoComplete="new-password"
          hint="Entre 16 y 256 caracteres."
        />
        <TextField
          label="Repite la nueva"
          type="password"
          value={repeat}
          onChange={setRepeat}
          autoComplete="new-password"
          error={repeat && repeat !== next ? "No coincide con la nueva." : null}
        />
        {error && (
          <p role="alert" className="field-error">
            {error}
          </p>
        )}
        <Key
          type="submit"
          variant="sun"
          block
          loading={busy}
          disabled={!valid || busy || wait > 0 || !app.online}
        >
          {wait > 0 ? `Espera ${formatCountdown(wait)}` : "Cambiar contraseña"}
        </Key>
      </form>
    </div>
  );
}
export function Install() {
  const [platform, setPlatform] = useState<"ios" | "android">("ios");
  const steps =
    platform === "ios"
      ? [
          "Abre este panel en Safari.",
          "Pulsa Compartir y elige «Añadir a pantalla de inicio».",
          "Confirma el nombre y pulsa Añadir.",
        ]
      : [
          "Abre este panel en Chrome.",
          "Abre el menú y elige «Añadir a pantalla de inicio» o «Instalar app».",
          "Confirma la instalación.",
        ];
  return (
    <div className="page stack gap-26">
      <BackKey to={{ name: "settings" }}>Ajustes</BackKey>
      <h1 className="t-h1">Instalar la app</h1>
      <Segmented
        label="Teléfono"
        options={[
          { value: "ios", label: "iPhone" },
          { value: "android", label: "Android" },
        ]}
        value={platform}
        onChange={setPlatform}
      />
      <Panel tone="paper">
        {steps.map((s, i) => (
          <div className="step" key={s}>
            <span className="step__n">{i + 1}</span>
            <p>{s}</p>
          </div>
        ))}
      </Panel>
      <Banner tone="info" glyph="info" title="Tu mando en el teléfono">
        Sin notificaciones push ni tareas en segundo plano. Sin conexión no se
        envían órdenes. Después de cerrar la app se requiere conexión para
        volver a acceder a datos privados.
      </Banner>
    </div>
  );
}
export function Agents() {
  return (
    <div className="page stack gap-26">
      <BackKey to={{ name: "settings" }}>Ajustes</BackKey>
      <h1 className="t-h1">Agentes</h1>
      <p>
        Los agentes usan un token propio con permisos read u operate. Se
        gestiona en el servidor y nunca llega a esta app.
      </p>
      <Panel tone="night">
        <h2 className="t-h3">Hermes</h2>
        <p className="t-mono mt-12">agente: hermes</p>
        <div className="row-flex wrap gap-12 mt-18">
          <Pill tone="off" glyph="info">
            read
          </Pill>
          <Pill tone="off" glyph="bolt">
            operate
          </Pill>
        </div>
        <p className="t-small mt-18">Token instalado en Hermes</p>
        <div className="mt-12">
          <Pill tone="warn" glyph="question">
            Sin confirmar
          </Pill>
        </div>
        <p className="t-small mt-18">
          Este panel no muestra el token ni permite crearlo o revocarlo.
        </p>
      </Panel>
      <Panel tone="paper">
        <h2 className="t-h3">API</h2>
        <p className="t-small mt-12">Especificación para integraciones:</p>
        <p className="t-mono t-small mt-12">GET /api/openapi.json</p>
        <p className="mt-14">
          Requiere sesión o token de agente. Las órdenes de agentes aparecen en
          Actividad con su nombre.
        </p>
      </Panel>
    </div>
  );
}
