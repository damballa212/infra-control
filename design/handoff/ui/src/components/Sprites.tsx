import { bitmapPath, QUESTION_MARK } from "../sprites/generator.ts";
import { getSprites } from "../sprites/index.ts";
import { Layers, ON_NIGHT_PALETTE, PixelPath } from "./Layers.tsx";

export type RouterMood = "reporting" | "reading" | "quiet";

export interface RouterSpriteProps {
  mood: RouterMood;
  width: number;
  /** Sobre un panel oscuro. */
  onNight?: boolean;
  /** Ondas de color sol (sobre oscuro) o violeta (sobre sol/papel). */
  waveColor?: string;
  className?: string;
}

export function RouterSprite({
  mood,
  width,
  onNight = false,
  waveColor,
  className,
}: RouterSpriteProps) {
  const { router } = getSprites();
  const palette = onNight ? ON_NIGHT_PALETTE : undefined;
  const wave =
    waveColor ??
    (onNight ? "var(--color-brand-sun)" : "var(--color-brand-violet)");
  return (
    <svg
      className={["sprite", `router--${mood}`, className ?? ""]
        .filter(Boolean)
        .join(" ")}
      width={width}
      height={(width * 24) / 32}
      viewBox="0 0 32 24"
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
    >
      <g className="r-bob">
        <Layers layers={router.base} palette={palette} />
        <PixelPath
          className="r-led l1"
          d={router.led1}
          fill="var(--color-brand-mint)"
        />
        <PixelPath
          className="r-led l2"
          d={router.led2}
          fill="var(--color-brand-sun)"
        />
        <PixelPath
          className="r-led l3"
          d={router.led3}
          fill="var(--color-brand-coral)"
        />
        <PixelPath
          className="r-eyes"
          d={router.eyes}
          fill="var(--color-sprite-k)"
        />
        <PixelPath
          className="r-eyes-blink"
          d={router.blink}
          fill="var(--color-sprite-k)"
        />
      </g>
      <PixelPath className="r-wave a1" d={router.wave1} fill={wave} />
      <PixelPath className="r-wave a2" d={router.wave2} fill={wave} />
      <PixelPath className="r-wave a3" d={router.wave3} fill={wave} />
      <PixelPath
        className="r-q"
        d={router.question}
        fill="var(--color-brand-sun)"
      />
    </svg>
  );
}

const CLOUD_QUESTION = bitmapPath(QUESTION_MARK, 20, -6);

export type CloudMood = "idle" | "busy" | "unsure" | "rain";

export interface CloudSpriteProps {
  width: number;
  mood?: CloudMood;
}

export function CloudSprite({ width, mood = "idle" }: CloudSpriteProps) {
  const { cloud } = getSprites();
  return (
    <svg
      className={["sprite", `cloud--${mood}`].join(" ")}
      width={width}
      height={(width * 10) / 24}
      viewBox="0 0 24 10"
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
    >
      <g className="cloud-bob">
        <Layers layers={cloud} />
      </g>
      <PixelPath
        className="cloud-rain d1"
        d="M6 11h1v2h-1z"
        fill="var(--color-brand-mint)"
      />
      <PixelPath
        className="cloud-rain d2"
        d="M12 12h1v2h-1z"
        fill="var(--color-brand-mint)"
      />
      <PixelPath
        className="cloud-rain d3"
        d="M17 11h1v2h-1z"
        fill="var(--color-brand-mint)"
      />
      <PixelPath
        className="cloud-q"
        d={CLOUD_QUESTION}
        fill="var(--color-brand-sun)"
      />
    </svg>
  );
}

export interface ComputerSpriteProps {
  width: number;
  onNight?: boolean;
}

export function ComputerSprite({
  width,
  onNight = false,
}: ComputerSpriteProps) {
  const { computer } = getSprites();
  return (
    <svg
      className="sprite"
      width={width}
      height={(width * 20) / 24}
      viewBox="0 0 24 20"
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
    >
      <Layers
        layers={computer.base}
        palette={onNight ? ON_NIGHT_PALETTE : undefined}
      />
      <PixelPath
        className="computer-z"
        d={computer.zzz}
        fill="var(--color-brand-sun)"
      />
    </svg>
  );
}

export function PersonSprite({ size }: { size: number }) {
  const { person } = getSprites();
  return (
    <svg
      className="sprite"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
    >
      <Layers
        layers={person}
        palette={{ O: "var(--color-brand-coral-deep)" }}
      />
    </svg>
  );
}

export function CoinSprite({
  size,
  fast = false,
}: {
  size: number;
  fast?: boolean;
}) {
  const { coin } = getSprites();
  return (
    <svg
      className="sprite"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
    >
      <g className={fast ? "coin-spin coin-spin--fast" : "coin-spin"}>
        <Layers layers={coin} />
      </g>
    </svg>
  );
}

export function HouseSprite({ width }: { width: number }) {
  const { house } = getSprites();
  return (
    <svg
      className="sprite"
      width={width}
      height={(width * 22) / 24}
      viewBox="0 0 24 22"
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
    >
      <Layers layers={house} palette={{ W: "var(--color-brand-paper)" }} />
    </svg>
  );
}
