import { useId, useState } from "react";
import { useSession } from "../app/Session.tsx";
import { useNow, useOnline } from "../hooks/usePlatform.ts";
import { ProviderError } from "../../../integration/provider.ts";
import { formatCountdown } from "../lib/format.ts";
import { navigate } from "../lib/router.tsx";
import { Icon } from "../components/ui.tsx";
import { DECORATIVE_ZONES, FleetScene } from "../components/FleetScene.tsx";

const DEFAULT_LOCK_SECONDS = 900;

export function Login() {
  const session = useSession();
  const online = useOnline();
  const now = useNow(1000);
  const ids = useId();
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lock, setLock] = useState<{ until: number; seconds: number } | null>(null);
  const wait = lock ? Math.max(0, Math.ceil((lock.until - now) / 1000)) : 0;
  const locked = wait > 0;
  const submit = async () => {
    if (busy || locked || !online) return;
    setBusy(true);
    setError(null);
    try {
      await session.login(username, password);
      setPassword("");
      navigate("/", { replace: true });
    } catch (e) {
      setPassword("");
      if (e instanceof ProviderError && e.status === 429) {
        const seconds = e.retryAfterSeconds ?? DEFAULT_LOCK_SECONDS;
        setLock({ until: Date.now() + seconds * 1000, seconds });
      } else setError(e instanceof Error ? e.message : "No se pudo entrar");
    } finally {
      setBusy(false);
    }
  };
  const errorId = `${ids}-error`;
  const elapsed = lock && locked ? 1 - wait / lock.seconds : 0;
  return (
    <div className="login2">
      <div className="login2__glow" aria-hidden="true" />
      <div className="login2__art" aria-hidden="true">
        <span className="login2__art--sm"><FleetScene zones={DECORATIVE_ZONES} width={320} decorative /></span>
        <span className="login2__art--lg"><FleetScene zones={DECORATIVE_ZONES} width={600} decorative /></span>
        <p className="login2__tagline"><span className="login2__mark" />Tus servidores, tu casa y tus agentes. En un solo lugar.</p>
      </div>
      <main className="login2__panel">
        <div className="login2__form">
          <p className="login2__brand"><span className="login2__mark" />INFRA CONTROL</p>
          <h1 className="login2__title">Hola, Admin</h1>
          <p className="login2__sub">Entra para ver y mover tus equipos.</p>
          {session.expired && <p className="login2__notice" role="status"><Icon name="lock" />Tu sesión terminó y se borró lo que había en pantalla. Tus órdenes siguen en el servidor.</p>}
          {!online && <p className="login2__notice" role="status"><Icon name="info" /><span><strong>Sin conexión</strong> · conéctate para entrar.</span></p>}
          {session.error && <div className="login2__notice login2__notice--bad" role="alert"><Icon name="info" /><span className="grow">El panel no responde. {session.error}</span><button type="button" className="btn btn--sm" onClick={session.retry}>Reintentar</button></div>}
          <form onSubmit={e => { e.preventDefault(); void submit(); }} noValidate>
            <div className="login2__field">
              <label className="login2__label" htmlFor={`${ids}-user`}>Usuario</label>
              <input id={`${ids}-user`} className="login2__input" value={username} onChange={e => setUsername(e.target.value)} autoComplete="username" autoCapitalize="none" spellCheck={false} />
            </div>
            <div className="login2__field">
              <label className="login2__label" htmlFor={`${ids}-password`}>Contraseña</label>
              <span className={`login2__control${error ? " is-error" : ""}`}>
                <input id={`${ids}-password`} className="login2__input" value={password} onChange={e => { setPassword(e.target.value); if (error) setError(null); }} type={show ? "text" : "password"} autoComplete="current-password" aria-invalid={error ? true : undefined} aria-describedby={error ? errorId : undefined} />
                <button type="button" className="login2__eye" aria-label={show ? "Ocultar contraseña" : "Mostrar contraseña"} aria-pressed={show} onClick={() => setShow(!show)}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" />{show && <path d="M4 4l16 16" />}</svg>
                </button>
              </span>
            </div>
            {error && <p className="login2__error" id={errorId} role="alert"><Icon name="info" />{error}</p>}
            <button type="submit" className={`login2__submit${locked ? " is-locked" : ""}`} disabled={busy || locked || !online || !password || !username} aria-busy={busy || undefined}>
              {locked && <span className="login2__progress" style={{ width: `${Math.round(elapsed * 100)}%` }} aria-hidden="true" />}
              <span className="login2__submit-label">{locked ? <><Icon name="lock" />Espera {formatCountdown(wait)}</> : busy ? "Entrando…" : "Entrar"}</span>
            </button>
            {locked && <p className="login2__hint" role="status">Demasiados intentos. Vuelve a probar cuando termine la cuenta.</p>}
          </form>
          <details className="login2__forgot">
            <summary>¿Olvidaste la contraseña?</summary>
            <p>Esta app no recupera contraseñas por correo. Se restablece en la configuración privada del servidor; al hacerlo se cierran todas las sesiones.</p>
          </details>
          <p className="login2__foot"><Icon name="lock" />Sesión de 7 días en este dispositivo</p>
        </div>
      </main>
    </div>
  );
}
