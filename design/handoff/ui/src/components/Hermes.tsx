import { hermesArt, type ArtLayer } from "../sprites/hermes.ts";

/** Estado emocional de Hermes, siempre derivado de un estado REAL (inventario u orden), nunca de relleno decorativo. */
export type HermesMood = "awake" | "busy" | "asleep" | "unsure" | "calm";

export interface HermesProps {
  mood: HermesMood;
  /** Salta de alegría: solo cuando una orden quedó confirmada de verdad. */
  happy?: boolean;
  size: number;
  /** Sin respiración ni parpadeo de bucle (p. ej. miniaturas de lista). */
  className?: string;
  /** Detalle reducido (miniaturas): solo ojos abiertos, sin efectos. */
  mini?: boolean;
}

function Art({ layers, className }: { layers: readonly ArtLayer[]; className?: string }) {
  return (
    <g className={className}>
      {layers.map((layer) => (
        <path key={layer.fill} fill={layer.fill} d={layer.d} />
      ))}
    </g>
  );
}

export function Hermes({
  mood,
  happy = false,
  size,
  className,
  mini = false,
}: HermesProps) {
  const art = hermesArt();
  const classes = [
    "sprite",
    `mood-${mood}`,
    happy ? "is-happy" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <svg
      className={classes}
      width={size}
      height={size}
      viewBox="0 0 32 32"
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
    >
      <path className="h-shadow" d={art.shadow} fill="#0E0D22" />
      <g className="h-jump">
        <g className="h-bob">
          <Art className="h-wing-up" layers={art.wingsUp} />
          <Art className="h-wing-mid" layers={art.wingsMid} />
          <Art className="h-wing-down" layers={art.wingsDown} />
          <Art className="h-wing-folded" layers={art.wingsFolded} />
          <Art layers={art.helmet} />
          <path className="h-led" d={art.led} />
          <g className="h-f h-eyes-open">
            <Art className="h-blink-open" layers={art.eyesOpen} />
          </g>
          {mini ? null : (
            <>
              <Art className="h-f h-eyes-blink" layers={art.eyesBlink} />
              <Art className="h-f h-eyes-shut" layers={art.eyesShut} />
              <Art className="h-f h-eyes-unsure" layers={art.eyesUnsure} />
              <Art className="h-f h-eyes-flare" layers={art.eyesFlare} />
            </>
          )}
        </g>
      </g>
      {mini ? null : (
        <>
          <Art className="h-arc a1" layers={art.arcInner} />
          <Art className="h-arc a2" layers={art.arcOuter} />
          <g transform="translate(2 2)">
            <Art className="h-spark s1" layers={art.spark} />
          </g>
          <g transform="translate(27 4)">
            <Art className="h-spark s2" layers={art.spark} />
          </g>
          <g transform="translate(2 25)">
            <Art className="h-spark s3" layers={art.spark} />
          </g>
          <Art className="h-z z1" layers={art.sleepZ} />
          <Art className="h-z z2" layers={art.sleepZ} />
          <Art className="h-z z3" layers={art.sleepZ} />
          <Art className="h-q" layers={art.question} />
        </>
      )}
    </svg>
  );
}
