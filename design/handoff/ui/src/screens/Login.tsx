import { useState } from "react";
import { useSession } from "../app/Session.tsx";
import { useNow, useOnline } from "../hooks/usePlatform.ts";
import { ProviderError } from "../../../integration/provider.ts";
import { formatCountdown } from "../lib/format.ts";
import { navigate } from "../lib/router.tsx";
import { Panel } from "../components/Panel.tsx";
import { Key } from "../components/Key.tsx";
import { TextField, Disclosure } from "../components/Fields.tsx";
import { Banner } from "../components/Banner.tsx";
import { Hermes } from "../components/Hermes.tsx";
import { SunsetScene } from "../components/SunsetScene.tsx";
export function Login() {
  const session = useSession();
  const online = useOnline();
  const now = useNow(1000);
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryAt, setRetryAt] = useState(0);
  const wait = Math.max(0, Math.ceil((retryAt - now) / 1000));
  const submit = async () => {
    if (busy || wait > 0 || !online) return;
    setBusy(true);
    setError(null);
    try {
      await session.login(username, password);
      setPassword("");
      navigate("/", { replace: true });
    } catch (e) {
      setPassword("");
      setError(e instanceof Error ? e.message : "No se pudo entrar");
      if (e instanceof ProviderError && e.status === 429)
        setRetryAt(Date.now() + (e.retryAfterSeconds ?? 900) * 1000);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login">
      <header className="hero">
        <SunsetScene />
        <div className="hero__content">
          <p className="hero-eyebrow">INFRA · ADMIN</p>
          <h1 className="t-title mt-8">Infra Control</h1>
          <p className="t-small mt-12">
            Panel privado. Funciona aunque Hermes esté apagado.
          </p>
        </div>
      </header>
      <main className="login__body stack gap-26">
        <div className="row-flex gap-14">
          <Hermes mood={error ? "unsure" : "awake"} size={80} />
          <h2 className="t-h2">Entrar</h2>
        </div>
        {session.expired && (
          <Banner tone="info" glyph="info" title="Tu sesión terminó">
            Por seguridad se borró lo que había en pantalla. Entra de nuevo.
            Ninguna orden se perdió: viven en el servidor.
          </Banner>
        )}
        {!online && (
          <Banner tone="night" glyph="bang" title="Sin conexión">
            Conéctate para iniciar sesión.
          </Banner>
        )}
        {session.error && (
          <Banner
            tone="bad"
            glyph="cross"
            title="El panel no responde"
            action={
              <Key variant="cream" onClick={session.retry}>
                Reintentar conexión
              </Key>
            }
          >
            {session.error}
          </Banner>
        )}
        <form
          className="stack gap-26"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <TextField
            label="Usuario"
            value={username}
            onChange={setUsername}
            autoComplete="username"
          />
          <TextField
            label="Contraseña"
            value={password}
            onChange={setPassword}
            type={show ? "text" : "password"}
            autoComplete="current-password"
            accessory={
              <Key
                variant="paper"
                size="sm"
                aria-label={show ? "Ocultar contraseña" : "Mostrar contraseña"}
                onClick={() => setShow(!show)}
              >
                {show ? "Ocultar" : "Ver"}
              </Key>
            }
          />
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
          {wait > 0 && (
            <Banner tone="warn" glyph="bang" title="Demasiados intentos">
              Puedes volver a intentarlo en {formatCountdown(wait)}.
            </Banner>
          )}
          <Key
            variant="sun"
            type="submit"
            block
            size="lg"
            loading={busy}
            disabled={busy || wait > 0 || !online || !password || !username}
          >
            {wait > 0 ? `Espera ${formatCountdown(wait)}` : "Entrar"}
          </Key>
        </form>
        <Panel tone="paper" flush>
          <Disclosure summary="¿Olvidaste la contraseña?">
            <p className="t-small disclosure-body">
              Esta app no recupera contraseñas por correo ni con passkeys. Se
              restablece en la configuración privada del servidor; al hacerlo se
              cierran todas las sesiones.
            </p>
          </Disclosure>
        </Panel>
        <p className="t-caption">Sesión segura de 7 días · solo este origen</p>
      </main>
    </div>
  );
}
