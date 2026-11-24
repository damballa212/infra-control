import { useEffect } from "react";

/** Atardecer a pantalla completa, fijo detrás del contenido y también bajo el notch. Decorativo. */
export function SkyBackground() {
  useEffect(() => {
    document.documentElement.classList.add("has-sky");
    return () => document.documentElement.classList.remove("has-sky");
  }, []);
  return (
    <svg
      className="sky-bg"
      viewBox="0 0 78 169"
      preserveAspectRatio="xMidYMin slice"
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
    >
      <rect y="0" width="78" height="10" fill="#1B1A3A" />
      <rect y="10" width="78" height="8" fill="#2E2C5E" />
      <rect y="18" width="78" height="8" fill="#5B3F8C" />
      <rect y="26" width="78" height="5" fill="#C24F43" />
      <rect y="31" width="78" height="5" fill="#FF7A6B" />
      <rect y="36" width="78" height="4" fill="#FF9F43" />
      <rect y="40" width="78" height="3" fill="#FFD166" />
      <rect y="43" width="78" height="126" fill="#1B1A3A" />
      <rect y="120" width="78" height="49" fill="#15142E" />
      <g fill="#FFFFFF" className="sky-stars">
        <rect x="6" y="3" width="1" height="1" />
        <rect x="20" y="6" width="1" height="1" />
        <rect x="34" y="2" width="1" height="1" />
        <rect x="48" y="7" width="1" height="1" />
        <rect x="66" y="4" width="1" height="1" />
        <rect x="73" y="12" width="1" height="1" />
        <rect x="12" y="13" width="1" height="1" />
        <rect x="40" y="14" width="1" height="1" />
        <rect x="28" y="9" width="1" height="1" />
        <rect x="60" y="16" width="1" height="1" />
      </g>
      <g fill="#FFD166">
        <rect x="15" y="4" width="1" height="1" />
        <rect x="54" y="2" width="1" height="1" />
        <rect x="70" y="8" width="1" height="1" />
        <rect x="49" y="42" width="16" height="1" />
        <rect x="49" y="41" width="16" height="1" />
        <rect x="49" y="40" width="16" height="1" />
        <rect x="50" y="39" width="14" height="1" />
        <rect x="50" y="38" width="14" height="1" />
        <rect x="51" y="37" width="12" height="1" />
        <rect x="52" y="36" width="10" height="1" />
        <rect x="53" y="35" width="8" height="1" />
        <rect x="55" y="34" width="4" height="1" />
      </g>
      <g fill="#FFF4E0">
        <rect x="55" y="37" width="3" height="1" />
        <rect x="54" y="38" width="2" height="1" />
      </g>
      <g className="sky-cloud-1" fill="#F7A8B8">
        <rect x="8" y="24" width="10" height="1" />
        <rect x="10" y="23" width="6" height="1" />
        <rect x="9" y="25" width="9" height="1" fill="#FF7A6B" />
      </g>
      <g className="sky-cloud-2" fill="#F7A8B8">
        <rect x="44" y="29" width="9" height="1" />
        <rect x="46" y="28" width="5" height="1" />
        <rect x="45" y="30" width="8" height="1" fill="#FF7A6B" />
      </g>
      <g fill="#5B3F8C">
        <rect x="0" y="42" width="14" height="9" />
        <rect x="14" y="40" width="16" height="11" />
        <rect x="30" y="43" width="14" height="8" />
        <rect x="44" y="41" width="16" height="10" />
        <rect x="60" y="42" width="18" height="9" />
      </g>
      <g fill="#2E2C5E">
        <rect x="0" y="45" width="10" height="9" />
        <rect x="10" y="43" width="14" height="11" />
        <rect x="24" y="46" width="14" height="8" />
        <rect x="38" y="44" width="14" height="10" />
        <rect x="52" y="46" width="14" height="8" />
        <rect x="66" y="44" width="12" height="10" />
      </g>
      <g fill="#0E0D22">
        <rect x="14" y="40" width="5" height="3" />
        <rect x="15" y="39" width="3" height="1" />
      </g>
      <rect className="sky-window" x="16" y="41" width="1" height="1" fill="#FFD166" />
    </svg>
  );
}
