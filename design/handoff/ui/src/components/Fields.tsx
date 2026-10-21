import { useId, type ChangeEvent, type ReactNode } from "react";
import { Glyph } from "./Glyph.tsx";

export interface FilterOption<T extends string> {
  value: T;
  label: string;
}

export interface FilterChipsProps<T extends string> {
  label: string;
  options: ReadonlyArray<FilterOption<T>>;
  value: T;
  onChange: (value: T) => void;
}

/** Grupo de botones de filtro con `aria-pressed` (misma semántica que un conmutador por opción). */
export function FilterChips<T extends string>({
  label,
  options,
  value,
  onChange,
}: FilterChipsProps<T>) {
  return (
    <div
      role="group"
      aria-label={label}
      className="row-flex wrap gap-14"
      style={{ padding: "4px 3px 0" }}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className="filter-chip"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: FilterChipsProps<T>) {
  return (
    <div role="group" aria-label={label} className="segmented">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className="filter-chip"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export interface SearchBoxProps {
  label: string;
  value: string;
  placeholder?: string;
  /** La etiqueta sigue ahí para lectores de pantalla; el placeholder ocupa su lugar a la vista. */
  hideLabel?: boolean;
  onChange: (value: string) => void;
}

export function SearchBox({
  label,
  value,
  placeholder,
  hideLabel = false,
  onChange,
}: SearchBoxProps) {
  const id = useId();
  return (
    <div className="field">
      <label className={hideLabel ? "visually-hidden" : "t-label"} htmlFor={id}>
        {label}
      </label>
      <div className="search-box">
        <svg
          width="20"
          height="20"
          viewBox="0 0 10 10"
          shapeRendering="crispEdges"
          aria-hidden="true"
          focusable="false"
        >
          <path
            d="M2 0h4v1h-4zM1 1h1v1h-1zM6 1h1v1h-1zM0 2h1v3h-1zM7 2h1v3h-1zM1 5h1v1h-1zM6 5h1v1h-1zM2 6h4v1h-4zM7 7h1v1h-1zM8 8h1v1h-1zM9 9h1v1h-1z"
            fill="var(--color-brand-night)"
          />
        </svg>
        <input
          id={id}
          type="search"
          enterKeyHint="search"
          autoComplete="off"
          spellCheck={false}
          value={value}
          placeholder={placeholder}
          onChange={(event: ChangeEvent<HTMLInputElement>) =>
            onChange(event.target.value)
          }
        />
        {value.length > 0 ? (
          <button
            type="button"
            className="clear-key"
            aria-label="Borrar búsqueda"
            onClick={() => onChange("")}
          >
            <Glyph name="cross" />
          </button>
        ) : null}
      </div>
    </div>
  );
}

export interface TextFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "password";
  autoComplete?: string;
  readOnly?: boolean;
  disabled?: boolean;
  error?: string | null;
  hint?: string | null;
  hintIsError?: boolean;
  /** Botón accesorio a la derecha (p. ej. mostrar contraseña). */
  accessory?: ReactNode;
}

export function TextField({
  label,
  value,
  onChange,
  type = "text",
  autoComplete,
  readOnly,
  disabled,
  error,
  hint,
  hintIsError = false,
  accessory,
}: TextFieldProps) {
  const id = useId();
  const messageId = `${id}-msg`;
  const message = error ?? hint ?? null;
  return (
    <div className="field">
      <label className="t-label" htmlFor={id}>
        {label}
      </label>
      <div className="input-group">
        <input
          id={id}
          className="input"
          type={type}
          value={value}
          autoComplete={autoComplete}
          readOnly={readOnly}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={message ? messageId : undefined}
          onChange={(event: ChangeEvent<HTMLInputElement>) =>
            onChange(event.target.value)
          }
        />
        {accessory ?? null}
      </div>
      {message ? (
        <p
          id={messageId}
          className={error || hintIsError ? "field-error" : "field-hint"}
          role={error ? "alert" : undefined}
        >
          {message}
        </p>
      ) : null}
    </div>
  );
}

export interface DisclosureProps {
  summary: string;
  children: ReactNode;
  className?: string;
}

export function Disclosure({ summary, children, className }: DisclosureProps) {
  return (
    <details
      className={["disclosure", className ?? ""].filter(Boolean).join(" ")}
    >
      <summary>
        <span>{summary}</span>
        <Glyph name="caretDown" />
      </summary>
      {children}
    </details>
  );
}
