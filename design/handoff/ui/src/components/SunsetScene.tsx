import { getSprites } from "../sprites/index.ts";
import { Layers, PixelPath } from "./Layers.tsx";

export interface SunsetSceneProps {
  /** Atenúa el cielo (sin conexión). */
  dim?: boolean;
  /** Con la escena completa: ventana de la casita, luciérnagas y estrella fugaz. */
  full?: boolean;
  className?: string;
}

/** Escena de atardecer de la cabecera: decoración. Sus bucles se pausan con la app oculta y se anulan con movimiento reducido. */
export function SunsetScene({
  dim = false,
  full = true,
  className,
}: SunsetSceneProps) {
  const scene = getSprites().scene;
  return (
    <svg
      className={[
        "hero__scene",
        "sprite",
        dim ? "scene--dim" : "",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
      viewBox="0 0 130 64"
      preserveAspectRatio="xMidYMax slice"
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
    >
      <g className="scene-sky">
        <Layers layers={scene.sky} />
        <PixelPath
          className="scene-star t1"
          d={scene.stars1}
          fill="var(--color-sprite-s)"
        />
        <PixelPath
          className="scene-star t2"
          d={scene.stars2}
          fill="var(--color-brand-sun)"
        />
        <PixelPath
          className="scene-star t3"
          d={scene.stars3}
          fill="var(--color-sprite-s)"
        />
        {full ? (
          <PixelPath
            className="scene-shooting"
            d={scene.shootingStar}
            fill="var(--color-sprite-s)"
          />
        ) : null}
        <PixelPath
          className="scene-halo"
          d={scene.halo}
          fill="var(--color-brand-sun)"
        />
        <Layers layers={scene.sun} />
        <g className="scene-cloud-1">
          <PixelPath d={scene.cloud1.fill} fill="var(--color-brand-rose)" />
          <PixelPath d={scene.cloud1.shade} fill="var(--color-brand-coral)" />
        </g>
        <g className="scene-cloud-2">
          <PixelPath d={scene.cloud2.fill} fill="var(--color-brand-rose)" />
          <PixelPath d={scene.cloud2.shade} fill="var(--color-brand-coral)" />
        </g>
        <g className="scene-cloud-3">
          <PixelPath d={scene.cloud3.fill} fill="var(--color-brand-rose)" />
          <PixelPath d={scene.cloud3.shade} fill="var(--color-brand-coral)" />
        </g>
      </g>
      <Layers layers={scene.hills} />
      {full ? (
        <>
          <PixelPath
            className="scene-window"
            d={scene.window}
            fill="var(--color-brand-sun)"
          />
          <PixelPath
            className="scene-firefly f1"
            d={scene.firefly1}
            fill="var(--color-brand-sun)"
          />
          <PixelPath
            className="scene-firefly f2"
            d={scene.firefly2}
            fill="var(--color-brand-sun)"
          />
          <PixelPath
            className="scene-firefly f3"
            d={scene.firefly3}
            fill="var(--color-brand-sun)"
          />
          <PixelPath
            className="scene-firefly f4"
            d={scene.firefly4}
            fill="var(--color-brand-sun)"
          />
        </>
      ) : null}
    </svg>
  );
}
