import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** Diálogo compartido: foco contenido, Escape y restauración al elemento que lo abrió. */
export function DecisionDialog({ title, children, actions, onCancel }: { title: string; children: ReactNode; actions: ReactNode; onCancel: () => void }) {
  const id = useId();
  const body = useId();
  const ref = useRef<HTMLElement>(null);
  const cancel = useRef(onCancel);
  cancel.current = onCancel;
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = document.getElementById("root");
    const wasInert = root?.inert ?? false;
    if (root) root.inert = true;
    ref.current?.querySelector<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex='0']")?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); cancel.current(); }
      if (event.key !== "Tab") return;
      const items = Array.from(ref.current?.querySelectorAll<HTMLElement>("button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex='0']") ?? []);
      const first = items[0]; const last = items.at(-1);
      if (!first || !last) { event.preventDefault(); ref.current?.focus(); return; }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", keydown);
    return () => { document.removeEventListener("keydown", keydown); if (root) root.inert = wasInert; if (opener?.isConnected) opener.focus(); };
  }, []);
  return createPortal(<><div className="scrim" aria-hidden="true" /><section ref={ref} tabIndex={-1} className="dialog" role="alertdialog" aria-modal="true" aria-labelledby={id} aria-describedby={body}><h2 id={id} className="t-h2">{title}</h2><div id={body} className="stack gap-12 mt-14">{children}</div><div className="dialog__actions">{actions}</div></section></>, document.body);
}
