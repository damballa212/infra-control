// Sprites detallados de la PC de casa, el FiberHome y la MacBook (propuesta UX 2026-10-21).
// Cuadrícula entera y animaciones por pasos en styles/home-sprites.css; cada animación depende del estado real.
import type { CSSProperties } from "react";

const svgProps = {
  shapeRendering: "crispEdges" as const,
  "aria-hidden": true,
  focusable: "false" as const,
};
const delay = (s: number): CSSProperties => ({ animationDelay: `${s}s` });

export type PcMode =
  | "cachyos"
  | "windows"
  | "booting"
  | "stopping"
  | "off"
  | "nosignal";

export function PcSprite({ mode, width }: { mode: PcMode; width: number }) {
  const live = mode === "cachyos" || mode === "windows";
  const moving = live || mode === "booting" || mode === "stopping";
  const rgbClass = live
    ? "hs-pc-rgb"
    : mode === "booting"
      ? "hs-pc-rgb fast"
      : undefined;
  const rgbFill = moving ? "#7FD8BE" : "#2E2C5E";
  const glow = moving ? 1 : 0;
  const ledFill = moving ? "#7FD8BE" : mode === "off" ? "#FF9F43" : "#2E2C5E";
  const ledClass = mode === "off" ? "hs-pc-standby" : undefined;
  const fanClass =
    mode === "booting"
      ? "hs-pc-fan-b fast"
      : mode === "stopping"
        ? "hs-pc-fan-b slow"
        : "hs-pc-fan-b";
  const booting = mode === "booting" || mode === "stopping";
  return (
    <svg
      {...svgProps}
      width={width}
      height={Math.round((width * 32) / 48)}
      viewBox="0 0 48 32"
      style={{ display: "block" }}
    >
      <path fill="#E8CFA8" d="M0 26h48v4h-48z" />
      <path fill="#FFF4E0" d="M0 30h48v1h-48z" />
      <path fill="#0E0D22" d="M0 31h48v1h-48z" />
      <path
        fill="#5B3F8C"
        opacity=".35"
        d="M9 26h14v1h-14zM33 26h15v1h-15zM28 30h4v1h-4z"
      />
      <path
        fill="#0E0D22"
        d="M1 1h30v1h-30zM1 2h1v17h-1zM30 2h1v17h-1zM1 19h30v1h-30z"
      />
      <path
        fill="#2E2C5E"
        d="M2 2h28v1h-28zM2 3h1v14h-1zM29 3h1v14h-1zM2 17h28v2h-28z"
      />
      <path fill="#5B3F8C" d="M3 2h7v1h-7zM2 3h1v3h-1z" />
      <path fill="#1B1A3A" d="M12 18h8v1h-8z" />
      <path className={ledClass} fill={ledFill} d="M27 18h1v1h-1z" />
      <path
        fill="#0E0D22"
        d="M14 20h1v4h-1zM17 20h1v4h-1zM10 24h12v1h-12zM9 25h1v1h-1zM22 25h1v1h-1z"
      />
      <path fill="#E8CFA8" d="M15 20h2v4h-2zM10 25h12v1h-12z" />
      <path fill="#FFF4E0" d="M15 20h1v4h-1zM11 25h4v1h-4z" />

      {mode === "cachyos" && (
        <>
          <path fill="#1B1A3A" d="M3 3h26v14h-26z" />
          <path fill="#FFF4E0" d="M4 4h1v1h-1zM27 5h1v1h-1zM21 3h1v1h-1z" />
          <path
            fill="#2E2C5E"
            d="M3 12h26v3h-26zM5 11h4v1h-4zM13 10h6v2h-6zM23 11h5v1h-5z"
          />
          <path fill="#7FD8BE" d="M6 11h1v1h-1zM14 10h2v1h-2zM24 11h1v1h-1z" />
          <path fill="#0E0D22" d="M3 15h26v2h-26z" />
          <path fill="#7FD8BE" d="M4 15h2v2h-2zM8 15h1v1h-1z" />
          <path fill="#FFF4E0" d="M8 16h1v1h-1zM24 16h4v1h-4z" />
          <path fill="#FFD166" d="M10 16h1v1h-1zM21 16h1v1h-1z" />
          <path fill="#FF7A6B" d="M12 16h1v1h-1z" />
          <path fill="#0E0D22" d="M4 4h12v9h-12z" />
          <path fill="#2E2C5E" d="M4 4h12v1h-12z" />
          <path fill="#FF7A6B" d="M5 4h1v1h-1z" />
          <path fill="#FFD166" d="M7 4h1v1h-1z" />
          <path fill="#7FD8BE" d="M9 4h1v1h-1z" />
          <g className="hs-pc-term-a">
            <path fill="#7FD8BE" d="M5 6h1v1h-1zM5 9h1v1h-1z" />
            <path fill="#FFF4E0" d="M7 6h5v1h-5zM7 9h4v1h-4z" />
            <path
              fill="#8C7AB8"
              d="M5 7h7v1h-7zM5 8h5v1h-5zM5 10h8v1h-8z"
            />
          </g>
          <g className="hs-pc-term-b">
            <path fill="#7FD8BE" d="M5 7h1v1h-1zM5 9h1v1h-1z" />
            <path fill="#FFF4E0" d="M7 7h4v1h-4zM7 9h7v1h-7z" />
            <path
              fill="#8C7AB8"
              d="M5 6h5v1h-5zM5 8h8v1h-8zM5 10h4v1h-4z"
            />
          </g>
          <path fill="#7FD8BE" d="M5 11h1v1h-1z" />
          <path className="hs-pc-caret" fill="#FFF4E0" d="M7 11h1v1h-1z" />
          <path fill="#0E0D22" d="M17 5h11v7h-11z" />
          <path fill="#2E2C5E" d="M17 5h11v1h-11z" />
          <path fill="#7FD8BE" d="M18 5h1v1h-1z" />
          <path
            className="hs-pc-g1"
            fill="#7FD8BE"
            d="M18 10h1v1h-1zM19 9h1v2h-1zM20 8h1v3h-1zM21 9h1v2h-1zM22 7h1v4h-1zM23 8h1v3h-1zM24 9h1v2h-1zM25 8h1v3h-1zM26 10h1v1h-1z"
          />
          <path
            className="hs-pc-g2"
            fill="#7FD8BE"
            d="M18 9h1v2h-1zM19 8h1v3h-1zM20 9h1v2h-1zM21 7h1v4h-1zM22 8h1v3h-1zM23 9h1v2h-1zM24 8h1v3h-1zM25 10h1v1h-1zM26 9h1v2h-1z"
          />
          <path
            className="hs-pc-g3"
            fill="#7FD8BE"
            d="M18 8h1v3h-1zM19 9h1v2h-1zM20 7h1v4h-1zM21 8h1v3h-1zM22 9h1v2h-1zM23 8h1v3h-1zM24 10h1v1h-1zM25 9h1v2h-1zM26 7h1v4h-1z"
          />
        </>
      )}

      {mode === "windows" && (
        <>
          <path fill="#2E2C5E" d="M3 3h26v14h-26z" />
          <path fill="#5B3F8C" d="M9 5h14v9h-14z" />
          <path fill="#FF7A6B" d="M11 6h10v7h-10z" />
          <path fill="#FF9F43" d="M13 7h6v5h-6z" />
          <path fill="#FFD166" d="M15 8h2v3h-2z" />
          <path fill="#0E0D22" d="M5 4h16v10h-16z" />
          <path fill="#1B1A3A" d="M5 4h16v1h-16z" />
          <path fill="#FF7A6B" d="M19 4h1v1h-1z" />
          <path fill="#5B3F8C" d="M6 5h14v3h-14z" />
          <path fill="#FF7A6B" d="M6 8h14v1h-14z" />
          <path fill="#FF9F43" d="M6 9h14v1h-14z" />
          <path fill="#FFD166" d="M15 8h3v1h-3zM14 9h5v1h-5z" />
          <path fill="#2E2C5E" d="M6 10h14v3h-14z" />
          <path fill="#7FD8BE" d="M6 10h4v1h-4zM13 10h5v1h-5z" />
          <g className="hs-pc-cloud">
            <path fill="#FFF4E0" d="M17 6h2v1h-2z" />
          </g>
          <g className="hs-pc-hop">
            <path fill="#FF7A6B" d="M9 10h1v1h-1z" />
            <path fill="#FFF4E0" d="M9 11h1v1h-1z" />
          </g>
          <path fill="#FFD166" d="M12 12h1v1h-1zM15 12h1v1h-1z" />
          <path fill="#0E0D22" d="M3 15h26v2h-26z" />
          <path fill="#7FD8BE" d="M11 16h1v1h-1z" />
          <path fill="#FFD166" d="M13 16h1v1h-1zM13 15h1v1h-1z" />
          <path fill="#FF7A6B" d="M15 16h1v1h-1z" />
          <path fill="#F7A8B8" d="M17 16h1v1h-1z" />
          <path fill="#FFF4E0" d="M19 16h1v1h-1zM24 16h4v1h-4z" />
        </>
      )}

      {booting && (
        <>
          <path fill="#0E0D22" d="M3 3h26v14h-26z" />
          {[
            "M15 5h2v1h-2z",
            "M18 6h1v1h-1z",
            "M19 8h1v2h-1z",
            "M18 11h1v1h-1z",
            "M15 12h2v1h-2z",
            "M13 11h1v1h-1z",
            "M12 8h1v2h-1z",
            "M13 6h1v1h-1z",
          ].map((d, i) => (
            <path
              key={d}
              className="hs-pc-dot"
              style={delay(i * 0.125)}
              fill="#FFF4E0"
              d={d}
            />
          ))}
          <path fill="#2E2C5E" d="M10 15h12v1h-12z" />
          <path
            fill={mode === "stopping" ? "#FF9F43" : "#7FD8BE"}
            d="M10 15h5v1h-5z"
          />
        </>
      )}

      {mode === "off" && (
        <>
          <path fill="#0E0D22" d="M3 3h26v14h-26z" />
          <path
            fill="#1B1A3A"
            d="M20 3h4v1h-4zM19 4h4v1h-4zM18 5h4v1h-4zM17 6h4v1h-4zM16 7h4v1h-4zM15 8h4v1h-4zM14 9h4v1h-4zM13 10h4v1h-4z"
          />
          <path
            fill="#2E2C5E"
            d="M26 3h1v1h-1zM25 4h1v1h-1zM24 5h1v1h-1zM23 6h1v1h-1z"
          />
          <g className="hs-pc-z">
            <path
              fill="#FFD166"
              d="M5 9h3v1h-3zM6 10h1v1h-1zM5 11h3v1h-3zM8 5h2v1h-2zM9 6h1v1h-1zM8 7h2v1h-2z"
            />
          </g>
        </>
      )}

      {mode === "nosignal" && (
        <>
          <path fill="#1B1A3A" d="M3 3h26v14h-26z" />
          <path
            fill="#2E2C5E"
            d="M4 4h1v1h-1zM6 4h1v1h-1zM8 4h1v1h-1zM10 4h1v1h-1zM12 4h1v1h-1zM14 4h1v1h-1zM16 4h1v1h-1zM18 4h1v1h-1zM20 4h1v1h-1zM22 4h1v1h-1zM24 4h1v1h-1zM26 4h1v1h-1z"
          />
          <path
            className="hs-pc-q"
            fill="#FFD166"
            d="M14 6h4v1h-4zM13 7h1v1h-1zM18 7h1v2h-1zM16 9h2v1h-2zM16 10h1v1h-1zM16 12h1v1h-1z"
          />
        </>
      )}

      <path
        fill="#0E0D22"
        d="M33 3h15v1h-15zM33 4h1v21h-1zM47 4h1v21h-1zM33 25h15v1h-15z"
      />
      <path
        fill="#2E2C5E"
        d="M34 4h13v1h-13zM34 5h1v20h-1zM46 5h1v20h-1zM35 24h11v1h-11z"
      />
      <path fill="#0E0D22" d="M39 4h2v1h-2zM42 4h1v1h-1z" />
      <path className={ledClass} fill={ledFill} d="M36 4h1v1h-1z" />
      <path fill="#0E0D22" d="M35 5h11v19h-11z" />
      <path fill="#5B3F8C" d="M37 5h9v13h-9z" />
      <path fill="#2E2C5E" d="M38 5h6v1h-6zM45 5h1v2h-1z" />
      <path fill="#8C7AB8" d="M38 16h3v1h-3zM44 14h1v1h-1zM43 17h2v1h-2z" />
      <path fill="#1B1A3A" d="M44 7h1v5h-1z" />
      <path className={rgbClass} fill={rgbFill} d="M44 7h1v1h-1z" />
      <path fill="#FF7A6B" d="M45 9h1v3h-1zM44 17h1v3h-1zM38 6h1v1h-1z" />
      <path className={rgbClass} fill={rgbFill} d="M35 6h1v13h-1z" />
      <path
        className={rgbClass}
        fill={rgbFill}
        d="M39 7h3v1h-3zM38 8h1v3h-1zM42 8h1v3h-1zM39 11h3v1h-3z"
      />
      <path fill="#1B1A3A" d="M39 8h3v3h-3z" />
      <path fill="#FFF4E0" d="M39 8h1v1h-1zM41 10h1v1h-1z" />
      <path fill="#E8CFA8" d="M41 8h1v1h-1zM39 10h1v1h-1z" />
      {moving && (
        <g className={fanClass}>
          <path fill="#1B1A3A" d="M39 8h3v3h-3z" />
          <path fill="#FFF4E0" d="M40 8h1v1h-1zM40 10h1v1h-1z" />
          <path fill="#E8CFA8" d="M39 9h1v1h-1zM41 9h1v1h-1z" />
        </g>
      )}
      <path fill="#FFD166" d="M40 9h1v1h-1z" />
      <path fill="#0E0D22" d="M36 13h1v4h-1zM45 13h1v4h-1zM36 16h10v1h-10z" />
      <path className={rgbClass} fill={rgbFill} d="M37 13h8v1h-8z" />
      <path fill="#2E2C5E" d="M37 14h8v2h-8z" />
      <path
        fill="#E8CFA8"
        d="M38 14h1v1h-1zM39 15h1v1h-1zM42 14h1v1h-1zM43 15h1v1h-1z"
      />
      {moving && (
        <g className={fanClass}>
          <path fill="#2E2C5E" d="M38 14h2v2h-2zM42 14h2v2h-2z" />
          <path
            fill="#E8CFA8"
            d="M39 14h1v1h-1zM38 15h1v1h-1zM43 14h1v1h-1zM42 15h1v1h-1z"
          />
        </g>
      )}
      <path fill="#2E2C5E" d="M35 20h11v4h-11z" />
      <path fill="#5B3F8C" d="M35 20h11v1h-11z" />
      <path
        fill="#0E0D22"
        d="M38 22h1v1h-1zM40 22h1v1h-1zM42 22h1v1h-1zM44 22h1v1h-1z"
      />
      <path fill="#FFF4E0" d="M36 22h1v1h-1z" />
      <path
        fill="#FFFFFF"
        opacity=".35"
        d="M45 6h1v1h-1zM44 7h1v1h-1zM36 21h1v1h-1zM35 22h1v1h-1z"
      />
      <path fill="#0E0D22" d="M34 25h2v1h-2zM45 25h2v1h-2z" />

      <path
        fill="#0E0D22"
        d="M6 27h20v1h-20zM6 28h1v1h-1zM25 28h1v1h-1zM6 29h20v1h-20z"
      />
      <path fill="#FFF4E0" d="M7 28h18v1h-18z" />
      <path
        fill="#E8CFA8"
        d="M9 28h1v1h-1zM12 28h1v1h-1zM15 28h1v1h-1zM18 28h1v1h-1zM21 28h1v1h-1zM24 28h1v1h-1z"
      />
      <path
        className={rgbClass}
        fill={rgbFill}
        opacity={glow}
        d="M8 29h16v1h-16z"
      />
      <path fill="#0E0D22" d="M29 27h2v1h-2zM28 28h1v1h-1zM31 28h1v1h-1zM29 29h2v1h-2z" />
      <path fill="#FFF4E0" d="M29 28h2v1h-2z" />
      <path
        className={rgbClass}
        fill={rgbFill}
        opacity={glow}
        d="M29 28h1v1h-1z"
      />
    </svg>
  );
}

export type FiberhomeMode = "reporting" | "reading" | "stale" | "unknown";

export function FiberhomeSprite({
  mode,
  width,
}: {
  mode: FiberhomeMode;
  width: number;
}) {
  const live = mode === "reporting" || mode === "reading";
  const reading = mode === "reading";
  const waveClass = reading ? "hs-r-wave fast" : "hs-r-wave";
  const ledOn = mode === "unknown" ? "#2E2C5E" : "#7FD8BE";
  const ledLan = mode === "unknown" ? "#2E2C5E" : "#FFD166";
  return (
    <svg
      {...svgProps}
      width={width}
      height={Math.round((width * 32) / 48)}
      viewBox="0 0 48 32"
      style={{ display: "block" }}
    >
      <path fill="#E8CFA8" d="M0 26h48v4h-48z" />
      <path fill="#FFF4E0" d="M0 30h48v1h-48z" />
      <path fill="#0E0D22" d="M0 31h48v1h-48z" />
      <path fill="#5B3F8C" opacity=".35" d="M5 26h38v1h-38z" />
      {live && (
        <>
          <path
            className={waveClass}
            style={delay(0)}
            fill="#FFD166"
            d="M6 5h1v1h-1zM5 6h1v2h-1zM6 8h1v1h-1zM41 5h1v1h-1zM42 6h1v2h-1zM41 8h1v1h-1z"
          />
          <path
            className={waveClass}
            style={delay(0.25)}
            fill="#FFD166"
            d="M4 4h1v1h-1zM3 5h1v4h-1zM4 9h1v1h-1zM43 4h1v1h-1zM44 5h1v4h-1zM43 9h1v1h-1z"
          />
          <path
            className={waveClass}
            style={delay(0.5)}
            fill="#FFD166"
            d="M2 3h1v1h-1zM1 4h1v6h-1zM2 10h1v1h-1zM45 3h1v1h-1zM46 4h1v6h-1zM45 10h1v1h-1z"
          />
        </>
      )}
      {[
        { x: 8, top: "M9 3h2v1h-2z", h: 8, inner: 6 },
        { x: 17, top: "M18 1h2v1h-2z", h: 10, inner: 8 },
        { x: 27, top: "M28 1h2v1h-2z", h: 10, inner: 8 },
        { x: 36, top: "M37 3h2v1h-2z", h: 8, inner: 6 },
      ].map((a) => {
        const y0 = a.top === "M9 3h2v1h-2z" || a.top === "M37 3h2v1h-2z" ? 4 : 2;
        return (
          <g key={a.x}>
            <path
              fill="#0E0D22"
              d={`${a.top}M${a.x} ${y0}h1v${a.h}h-1zM${a.x + 3} ${y0}h1v${a.h}h-1zM${a.x} 12h4v2h-4z`}
            />
            <path fill="#FFFBF3" d={`M${a.x + 1} ${y0}h2v${a.h}h-2z`} />
            <path
              fill="#E8CFA8"
              d={`M${a.x + 2} ${y0 + 1}h1v${a.inner}h-1zM${a.x + 1} 12h2v1h-2z`}
            />
          </g>
        );
      })}
      <path
        fill="#0E0D22"
        d="M7 14h34v1h-34zM6 15h1v1h-1zM41 15h1v1h-1zM5 16h1v1h-1zM42 16h1v1h-1zM4 17h40v1h-40z"
      />
      <path fill="#FFFBF3" d="M7 15h34v1h-34zM6 16h36v1h-36z" />
      <path
        fill="#E8CFA8"
        d="M12 15h1v1h-1zM11 16h1v1h-1zM15 15h1v1h-1zM14 16h1v1h-1zM18 15h1v1h-1zM17 16h1v1h-1zM21 15h1v1h-1zM20 16h1v1h-1zM24 15h1v1h-1zM23 16h1v1h-1zM27 15h1v1h-1zM26 16h1v1h-1zM30 15h1v1h-1zM29 16h1v1h-1zM33 15h1v1h-1zM32 16h1v1h-1zM36 15h1v1h-1zM35 16h1v1h-1z"
      />
      <path
        fill="#0E0D22"
        d="M4 18h1v6h-1zM43 18h1v6h-1zM4 24h40v1h-40zM7 25h3v1h-3zM38 25h3v1h-3z"
      />
      <path fill="#FFF4E0" d="M5 18h38v5h-38z" />
      <path fill="#E8CFA8" d="M5 23h38v1h-38z" />
      <path fill="#FFFFFF" d="M5 18h38v1h-38z" />
      <path fill="#0E0D22" d="M9 19h22v3h-22z" />
      <path fill="#2E2C5E" d="M9 19h22v1h-22z" />
      <path fill={ledOn} d="M11 20h1v1h-1zM14 20h1v1h-1z" />
      <path fill="#2E2C5E" d="M17 20h1v1h-1z" />
      <path
        className={live ? (reading ? "hs-r-blink fast" : "hs-r-blink") : undefined}
        fill={ledOn}
        d="M20 20h1v1h-1z"
      />
      <path
        className={live ? "hs-r-blink2" : undefined}
        fill={ledLan}
        d="M23 20h1v1h-1z"
      />
      <path
        className={live ? "hs-r-blink3" : undefined}
        fill={ledOn}
        d="M26 20h1v1h-1zM29 20h1v1h-1z"
      />
      <path
        fill="#5B3F8C"
        opacity=".7"
        d="M11 21h1v1h-1zM14 21h1v1h-1zM17 21h1v1h-1zM20 21h1v1h-1zM23 21h1v1h-1zM26 21h1v1h-1zM29 21h1v1h-1z"
      />
      <path
        fill="#E8CFA8"
        d="M36 19h3v1h-3zM35 20h1v2h-1zM39 20h1v2h-1zM36 22h3v1h-3z"
      />
      <path fill={ledOn} d="M37 20h1v2h-1z" />
      <path fill="#8C7AB8" d="M9 23h6v1h-6z" />
      <path fill="#0E0D22" d="M1 19h3v1h-3zM1 20h1v1h-1z" />
      <path fill="#7FD8BE" d="M2 20h2v1h-2z" />
      <path fill="#FFD166" d="M1 21h1v4h-1zM0 25h1v1h-1z" />
      {live && (
        <path
          className={reading ? "hs-r-packet fast" : "hs-r-packet"}
          fill="#FFFFFF"
          d="M1 24h1v1h-1z"
        />
      )}
      <path fill="#0E0D22" d="M44 20h1v2h-1z" />
      <path fill="#8C7AB8" d="M45 21h1v1h-1zM46 22h1v3h-1zM47 25h1v1h-1z" />
      {mode === "stale" && (
        <>
          <path
            fill="#0E0D22"
            d="M22 3h4v1h-4zM21 4h1v4h-1zM26 4h1v4h-1zM22 8h4v1h-4z"
          />
          <path fill="#FFF4E0" d="M22 4h4v4h-4z" />
          <path fill="#0E0D22" d="M23 5h1v2h-1zM24 6h1v1h-1z" />
        </>
      )}
      {mode === "unknown" && (
        <path
          className="hs-r-q"
          fill="#FFD166"
          d="M22 2h3v1h-3zM25 3h1v2h-1zM23 5h2v1h-2zM23 6h1v1h-1zM23 8h1v1h-1z"
        />
      )}
    </svg>
  );
}

export type MacMode = "on" | "asleep" | "nosignal" | "unlinked";

export function MacSprite({ mode, width }: { mode: MacMode; width: number }) {
  const open = mode !== "asleep";
  return (
    <svg
      {...svgProps}
      width={width}
      height={Math.round((width * 23) / 32)}
      viewBox="0 0 32 23"
      style={{ display: "block", overflow: "visible" }}
    >
      {open && (
        <g>
          <path
            fill="#0E0D22"
            d="M4 1h24v1h-24zM4 2h1v14h-1zM27 2h1v14h-1zM4 16h24v1h-24z"
          />
          <path fill="#E8CFA8" d="M5 2h22v1h-22zM5 3h1v13h-1zM26 3h1v13h-1z" />
          <path fill="#FFF4E0" d="M5 2h6v1h-6z" />
          <path
            fill="#0E0D22"
            d="M6 3h20v1h-20zM6 4h1v11h-1zM25 4h1v11h-1zM6 15h20v1h-20z"
          />
          {mode === "on" && (
            <>
              <g className="hs-mac-glow">
                <path fill="#5B3F8C" d="M7 4h18v4h-18z" />
                <path fill="#C24F43" d="M7 8h18v1h-18z" />
                <path fill="#FF7A6B" d="M7 9h18v2h-18z" />
                <path fill="#FF9F43" d="M7 11h18v1h-18z" />
                <path fill="#FFD166" d="M18 9h4v1h-4zM17 10h6v1h-6zM7 12h18v1h-18z" />
                <path fill="#2E2C5E" d="M7 13h18v2h-18zM9 12h4v1h-4zM20 12h3v1h-3z" />
                <path fill="#FFF4E0" d="M7 4h7v1h-7zM18 4h7v1h-7z" />
                <path fill="#0E0D22" d="M8 4h1v1h-1zM22 4h2v1h-2z" />
                <path fill="#0E0D22" d="M8 6h8v5h-8z" />
                <path fill="#FFFBF3" d="M9 7h6v3h-6z" />
                <path fill="#1B1A3A" d="M9 6h6v1h-6z" />
                <path fill="#FF7A6B" d="M9 6h1v1h-1z" />
                <path fill="#7FD8BE" d="M10 8h1v1h-1z" />
                <path fill="#8C7AB8" d="M12 8h2v1h-2zM10 9h4v1h-4z" />
                <path fill="#1B1A3A" d="M10 14h12v1h-12z" />
                <path fill="#FFD166" d="M13 14h1v1h-1z" />
                <path fill="#FF7A6B" d="M15 14h1v1h-1z" />
                <path fill="#F7A8B8" d="M17 14h1v1h-1z" />
                <path fill="#FFF4E0" d="M19 14h1v1h-1z" />
              </g>
              <path className="hs-mac-dock" fill="#7FD8BE" d="M11 14h1v1h-1z" />
              <g className="hs-mac-cursor">
                <path fill="#0E0D22" d="M19 6h1v4h-1zM20 7h1v2h-1zM21 8h1v1h-1z" />
                <path fill="#FFFBF3" d="M20 8h1v1h-1z" />
              </g>
            </>
          )}
          {mode === "nosignal" && (
            <>
              <path fill="#1B1A3A" d="M7 4h18v11h-18z" />
              <path
                className="hs-mac-q"
                fill="#FFD166"
                d="M14 6h4v1h-4zM18 7h1v2h-1zM16 9h2v1h-2zM16 10h1v1h-1zM16 12h1v1h-1z"
              />
            </>
          )}
          {mode === "unlinked" && (
            <>
              <path fill="#2E2C5E" d="M7 4h18v11h-18z" />
              <path
                fill="#8C7AB8"
                d="M9 6h1v1h-1zM11 6h1v1h-1zM13 6h1v1h-1zM15 6h1v1h-1zM17 6h1v1h-1zM19 6h1v1h-1zM21 6h1v1h-1zM9 12h1v1h-1zM11 12h1v1h-1zM13 12h1v1h-1zM15 12h1v1h-1zM17 12h1v1h-1zM19 12h1v1h-1zM21 12h1v1h-1zM9 8h1v1h-1zM9 10h1v1h-1zM22 8h1v1h-1zM22 10h1v1h-1z"
              />
              <path
                className="hs-mac-plug"
                fill="#7FD8BE"
                d="M14 8h1v1h-1zM17 8h1v1h-1zM13 9h6v2h-6zM15 11h2v1h-2z"
              />
            </>
          )}
          <path fill="#0E0D22" d="M14 4h4v1h-4z" />
        </g>
      )}
      {mode === "asleep" && (
        <>
          <path fill="#0E0D22" d="M3 15h26v1h-26zM3 16h1v1h-1zM28 16h1v1h-1z" />
          <path fill="#E8CFA8" d="M4 16h24v1h-24z" />
          <path fill="#FFF4E0" d="M4 16h7v1h-7z" />
          <g className="hs-mac-z">
            <path
              fill="#FFD166"
              d="M20 8h3v1h-3zM21 9h1v1h-1zM20 10h3v1h-3zM24 4h4v1h-4zM26 5h1v1h-1zM25 6h1v1h-1zM24 7h4v1h-4z"
            />
          </g>
        </>
      )}
      <path
        fill="#0E0D22"
        d="M3 17h26v1h-26zM2 18h1v1h-1zM29 18h1v1h-1zM1 19h1v1h-1zM30 19h1v1h-1zM0 20h1v1h-1zM31 20h1v1h-1zM1 21h30v1h-30z"
      />
      <path fill="#E8CFA8" d="M3 18h26v1h-26zM2 19h28v1h-28z" />
      <path fill="#5B3F8C" d="M5 18h22v1h-22z" />
      <path fill="#FFF4E0" d="M1 20h30v1h-30z" />
      <path fill="#E8CFA8" d="M13 20h6v1h-6z" />
    </svg>
  );
}
