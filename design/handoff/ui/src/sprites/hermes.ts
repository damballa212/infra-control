// Hermes v3 (32 × 32): yelmo corintio alado, dibujado a mano píxel a píxel.
// Cada letra es un color de la paleta atardecer; "." es transparente. Las capas se animan por separado
// desde styles/sprites.css y siempre dependen de un estado real (ver lib/mood.ts).

const INK = {
  k: "#0E0D22",
  n: "#1B1A3A",
  d: "#2E2C5E",
  v: "#5B3F8C",
  l: "#8C7AB8",
  x: "#C24F43",
  r: "#FF7A6B",
  o: "#FF9F43",
  y: "#FFD166",
  c: "#FFF4E0",
  w: "#FFFFFF",
  p: "#F7A8B8",
  m: "#7FD8BE",
} as const;

type Ink = keyof typeof INK;

export interface ArtLayer {
  fill: string;
  d: string;
}

const SIZE = 32;

function isInk(ch: string): ch is Ink {
  return Object.hasOwn(INK, ch);
}

/** Rejilla de letras → un path por color (tramos horizontales fusionados). */
export function art(rows: readonly string[], ox = 0, oy = 0): ArtLayer[] {
  const paths = new Map<Ink, string>();
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const ch = row.charAt(x);
      let run = 1;
      while (row.charAt(x + run) === ch) run += 1;
      if (isInk(ch))
        paths.set(ch, `${paths.get(ch) ?? ""}M${x + ox} ${y + oy}h${run}v1h-${run}z`);
      x += run;
    }
  });
  return [...paths].map(([ink, d]) => ({ fill: INK[ink], d }));
}

/** Refleja una mitad izquierda (≤16 columnas) para obtener la fila completa. */
function mirrorRow(left: string): string {
  const half = left.padEnd(SIZE / 2, ".");
  return half + [...half].reverse().join("");
}

// ---------------------------------------------------------------- yelmo y cara

// Yelmo corintio con cresta transversal de crin: oro con brillo arriba a la izquierda, cuencas en ceño y abertura vertical.
const HELMET: readonly string[] = [
  "............kkkkkkkk",
  "..........kkkwprrxrkkk",
  ".........kkwprprrxrxrkk",
  "........kkrxrxrxrxrxrxkk",
  "........kxrxrxrxrxrxrxrk",
  "........kxrxrxrxrxrxrxrk",
  "........kkxkxkxkxkxkxkxk",
  ".........kxkxkxkxkxkxkk",
  "..........kcyyyyoooook",
  "..........kkkkkkkkkkkk",
  "........kkccccyyyyyyyykk",
  ".......kccyyyyyyyyyyyyyyk",
  "......kcoooooooooooooooook",
  "......kcyykkyyycoyyykkyyyk",
  "......kcyknnkkyyoykknnkyyk",
  "....kkkcyknnnnkyoknnnnkyykkk",
  "....klkcyknnnnnyonnnnnkyykvk",
  "....kvkcyyknnnnyonnnnkyyykvk",
  "....kvkcyyokkkkyokkkkoyyykvk",
  "....kvkcyyoyyoknnkoyyoyyykvk",
  "....kkkcyyoyyoknnkoyyoyyykkk",
  "......kcyyoyyoknnkoyyoyoyk",
  "......kyyyoyyoknnkoyyooyok",
  ".......kyyyyyoknnkooyoyok",
  ".......kyyyyyoknnkoyooook",
  "........kyyyyoknnkoooook",
  "........kyyyyyknnkooooxk",
  ".........kyoyok..kooxxk",
  "..........kkkkk..kkkkk",
];
const HELMET_TOP = 1;

const EYES_OPEN: readonly string[] = [
  "..........oyo......oyo",
  "...........ccyo..oycc",
  "............ccy..ycc",
];
const EYES_OPEN_TOP = 16;

const EYES_BLINK: readonly string[] = [
  "...........yy......yy",
  ".............yy..yy",
];
const EYES_BLINK_TOP = 17;

const EYES_SHUT: readonly string[] = [
  "...........vv......vv",
  ".............vv..vv",
];
const EYES_SHUT_TOP = 17;

const EYES_UNSURE: readonly string[] = [
  "............oo....oo",
];
const EYES_UNSURE_TOP = 17;

const EYES_FLARE: readonly string[] = [
  "..........ycy......ycy",
  "...........wwcy..ycww",
  "............wwc..cww",
];
const EYES_FLARE_TOP = 16;

// ---------------------------------------------------------------- alas (izquierda; la derecha se refleja)

// Hojas de pluma blanca y lavanda que barren hacia arriba, como las del casco de Hermes.
const WING_LEFT: readonly string[] = [
  "k",
  "kk",
  "kwk",
  "kcck",
  "kccck",
  ".kcccck",
  "kkwccck",
  "kcllclk",
  ".kklllk",
  "kcllvlk",
  "kllvvlk",
  ".kkvvdk",
  "..kkkk",
].map(mirrorRow);

const WING_FOLDED: readonly string[] = [
  "...kkk",
  "..kccck",
  ".kcclck",
  "kcllvlk",
  "kllvvdk",
  ".kkvddk",
  "...kkk",
].map(mirrorRow);

// ---------------------------------------------------------------- efectos

const ARC_INNER = [".......m", "......m", "......m", "......m", ".......m"].map(mirrorRow);
const ARC_OUTER = [".....m", "....m", "....m", "....m", "....m", "....m", ".....m"].map(mirrorRow);
const SPARK = [".c.", "cyc", ".c."];
const QUESTION = [".yyy.", "y...y", "....y", "...y.", "..y..", ".....", "..y.."];
const SLEEP_Z = ["cccc", "..c.", ".c..", "cccc"];

export interface HermesArt {
  shadow: string;
  wingsUp: ArtLayer[];
  wingsMid: ArtLayer[];
  wingsDown: ArtLayer[];
  wingsFolded: ArtLayer[];
  helmet: ArtLayer[];
  led: string;
  eyesOpen: ArtLayer[];
  eyesBlink: ArtLayer[];
  eyesShut: ArtLayer[];
  eyesUnsure: ArtLayer[];
  eyesFlare: ArtLayer[];
  arcInner: ArtLayer[];
  arcOuter: ArtLayer[];
  spark: ArtLayer[];
  question: ArtLayer[];
  sleepZ: ArtLayer[];
}

let cache: HermesArt | null = null;

export function hermesArt(): HermesArt {
  cache ??= {
    shadow: "M10 31h12v1h-12z",
    wingsUp: art(WING_LEFT, 0, 6),
    wingsMid: art(WING_LEFT, 0, 8),
    wingsDown: art(WING_LEFT, 0, 10),
    wingsFolded: art(WING_FOLDED, 0, 16),
    helmet: art(HELMET, 0, HELMET_TOP),
    led: "M15 13h2v1h-2z",
    eyesOpen: art(EYES_OPEN, 0, EYES_OPEN_TOP),
    eyesBlink: art(EYES_BLINK, 0, EYES_BLINK_TOP),
    eyesShut: art(EYES_SHUT, 0, EYES_SHUT_TOP),
    eyesUnsure: art(EYES_UNSURE, 0, EYES_UNSURE_TOP),
    eyesFlare: art(EYES_FLARE, 0, EYES_FLARE_TOP),
    arcInner: art(ARC_INNER, 0, 1),
    arcOuter: art(ARC_OUTER, 0, 0),
    spark: art(SPARK),
    question: art(QUESTION, 25, 0),
    sleepZ: art(SLEEP_Z, 25, 2),
  };
  return cache;
}
