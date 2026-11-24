import { useState } from "react";
import type { MeTab } from "../lib/router.tsx";
import { useSession } from "../app/Session.tsx";
import { useAppState } from "../app/AppState.tsx";
import { provider } from "../app/providers.ts";
import { ProviderError } from "../../../integration/provider.ts";
import { useNow } from "../hooks/usePlatform.ts";
import { formatCountdown } from "../lib/format.ts";
import { Card, Rows, ScreenHead, Segmented } from "../components/v2.tsx";
import { PushSettings } from "../components/PushSettings.tsx";
import { SystemTab } from "../components/me-system.tsx";
import { SettingsTab } from "../components/me-settings.tsx";

const TABS = [
  { key: "system", label: "Estado del sistema", to: { name: "me", tab: "system" } },
  { key: "devices", label: "Dispositivos y avisos", to: { name: "me", tab: "devices" } },
  { key: "settings", label: "Ajustes", to: { name: "me", tab: "settings" } },
] as const;

/** «Tú» no es pestaña en el móvil (se abre desde el avatar): lleva back a Hoy; en escritorio lo oculta el CSS. */
export function Me({ tab }: { tab: MeTab }) {
  const session = useSession();
  return <div className="page me">
    <ScreenHead back={{ to: { name: "control" }, label: "Hoy" }} title="Tú" detail={`${session.user?.name ?? "Sesión personal"} · sesión de este navegador`} />
    <div className="me-tabs"><Segmented label="Secciones de Tú" value={tab} items={TABS} /></div>
    {tab === "system" ? <SystemTab /> : tab === "devices" ? <div className="v2-grid v2-grid--2"><PushSettings /></div> : <SettingsTab />}
  </div>;
}

export function Password() {
  const session = useSession(); const app = useAppState(); const now = useNow(1000);
  const [current, setCurrent] = useState(""); const [next, setNext] = useState(""); const [repeat, setRepeat] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null); const [deadline, setDeadline] = useState(0);
  const wait = Math.max(0, Math.ceil((deadline - now) / 1000)); const valid = next.length >= 16 && next.length <= 256 && next === repeat && current.length > 0;
  const submit = async () => {
    if (!valid || busy || wait > 0 || !app.online) return;
    setBusy(true); setError(null);
    try { await provider.changePassword(current, next); setCurrent(""); setNext(""); setRepeat(""); session.expire(); }
    catch (failure) {
      setError(failure instanceof Error ? failure.message : "No se pudo cambiar");
      if (failure instanceof ProviderError && failure.status === 429) setDeadline(Date.now() + (failure.retryAfterSeconds ?? 900) * 1000);
      if (failure instanceof ProviderError && failure.status === 401) { try { await provider.getSession(); setError("La contraseña actual no es correcta."); } catch (check) { if (check instanceof ProviderError && check.status === 401) session.expire(); } }
    } finally { setBusy(false); }
  };
  const mismatch = repeat.length > 0 && repeat !== next;
  const shortNew = next.length > 0 && next.length < 16;
  const why = !app.online ? "Sin conexión." : busy ? "Cambio en curso." : wait ? "Respeta el tiempo de espera." : !valid ? "Completa los tres campos." : null;
  return <div className="page me-sub">
    <ScreenHead back={{ to: { name: "me", tab: "settings" }, label: "Ajustes" }} title="Contraseña" detail="Al cambiarla se cierran todas las sesiones." />
    <div className="v2-grid v2-grid--2">
      <Card flush label="Cambiar contraseña"><form className="ag-form ag-pad" onSubmit={event => { event.preventDefault(); void submit(); }}>
        <Field label="Contraseña actual" value={current} onChange={setCurrent} autoComplete="current-password" />
        <Field label="Contraseña nueva" value={next} onChange={setNext} autoComplete="new-password" hint={shortNew ? "Mínimo 16 caracteres." : "Entre 16 y 256 caracteres."} bad={shortNew} />
        <Field label="Repite la nueva" value={repeat} onChange={setRepeat} autoComplete="new-password" hint={mismatch ? "No coincide con la nueva." : undefined} bad={mismatch} />
        {error && <p role="alert" className="ag-line ag-line--bad">{error}</p>}
        <button type="submit" className="btn btn--primary ag-btn ag-btn--block" disabled={why !== null}>{wait > 0 ? `Espera ${formatCountdown(wait)}` : "Cambiar contraseña"}</button>
        {why && <p className="ag-line">{why}</p>}
      </form></Card>
    </div>
  </div>;
}

function Field({ label, value, onChange, autoComplete, hint, bad = false }: { label: string; value: string; onChange: (v: string) => void; autoComplete: string; hint?: string; bad?: boolean }) {
  return <label className="ag-field"><span className="ag-field__label">{label}</span><input className="ag-input" type="password" value={value} onChange={event => onChange(event.target.value)} autoComplete={autoComplete} aria-invalid={bad || undefined} />{hint && <span className={bad ? "ag-field__hint ag-field__hint--bad" : "ag-field__hint"}>{hint}</span>}</label>;
}

const STEPS = {
  ios: ["Abre este panel en Safari.", "Toca Compartir y elige «Añadir a pantalla de inicio».", "Confirma el nombre y toca Añadir."],
  android: ["Abre este panel en Chrome.", "Abre el menú y elige «Instalar app».", "Confirma la instalación."],
} as const;

export function Install() {
  const [platform, setPlatform] = useState<"ios" | "android">("ios");
  return <div className="page me-sub">
    <ScreenHead back={{ to: { name: "me", tab: "settings" }, label: "Ajustes" }} title="Instalar la app" detail="Así recibes avisos y la abres como una app." />
    <div className="v2-grid v2-grid--2">
      <div className="v2-stack">
        <Segmented label="Teléfono" value={platform} items={[{ key: "ios", label: "iPhone" }, { key: "android", label: "Android" }]} onChange={setPlatform} />
        <Card flush label="Pasos"><Rows label="Pasos">{STEPS[platform].map((step, index) => <li key={step} className="me-step"><span className="me-step__n" aria-hidden="true">{index + 1}</span><span>{step}</span></li>)}</Rows></Card>
      </div>
    </div>
  </div>;
}
