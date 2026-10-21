// Generador de sprites pixel art (variante D). Todo es determinista: la misma entrada produce los mismos píxeles.
// Cada sprite se devuelve en CAPAS por color (`SpriteLayers`) para poder animar partes por separado y recolorear
// con tokens. Las claves de color son letras: ver tokens.json → color.sprite.

export type SpriteKey =
  "K" | "N" | "V" | "R" | "O" | "Y" | "W" | "P" | "B" | "M" | "C" | "S";
export type SpriteLayers = Readonly<Record<SpriteKey, string>>;
export type WingFrame = "up" | "mid" | "down";

type Cell = "." | SpriteKey;
type Grid = Cell[][];
type Point = readonly [number, number];

const KEYS: readonly SpriteKey[] = [
  "K",
  "N",
  "V",
  "R",
  "O",
  "Y",
  "W",
  "P",
  "B",
  "M",
  "C",
  "S",
];

function grid(width: number, height: number): Grid {
  return Array.from({ length: height }, () =>
    Array.from({ length: width }, (): Cell => "."),
  );
}

function inEllipse(
  x: number,
  y: number,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
): boolean {
  const dx = (x + 0.5 - cx) / rx;
  const dy = (y + 0.5 - cy) / ry;
  return dx * dx + dy * dy <= 1;
}

function put(g: Grid, x: number, y: number, key: SpriteKey): void {
  const row = g[y];
  if (row !== undefined && x >= 0 && x < row.length) row[x] = key;
}

function at(g: Grid, x: number, y: number): Cell {
  return g[y]?.[x] ?? ".";
}

/** Contorno de 1 px alrededor de las celdas pintadas. */
function outline(g: Grid, key: SpriteKey): Grid {
  const out = g.map((row) => row.slice());
  const neighbors: readonly Point[] = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  g.forEach((row, y) => {
    row.forEach((cell, x) => {
      if (cell !== ".") return;
      const touches = neighbors.some(([dx, dy]) => {
        const near = at(g, x + dx, y + dy);
        return near !== "." && near !== key;
      });
      const target = out[y];
      if (touches && target !== undefined) target[x] = key;
    });
  });
  return out;
}

function emptyLayers(): Record<SpriteKey, string> {
  return {
    K: "",
    N: "",
    V: "",
    R: "",
    O: "",
    Y: "",
    W: "",
    P: "",
    B: "",
    M: "",
    C: "",
    S: "",
  };
}

/** Convierte una rejilla a path SVG por color (rectángulos horizontales fusionados). */
export function layersOf(g: Grid, ox = 0, oy = 0): SpriteLayers {
  const out = emptyLayers();
  g.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const cell = row[x] ?? ".";
      let run = 1;
      while (x + run < row.length && row[x + run] === cell) run += 1;
      if (cell !== ".") out[cell] += `M${x + ox} ${y + oy}h${run}v1h-${run}z`;
      x += run;
    }
  });
  return out;
}

export function pointsPath(points: readonly Point[], ox = 0, oy = 0): string {
  return points.map(([x, y]) => `M${x + ox} ${y + oy}h1v1h-1z`).join("");
}

/** '#' = píxel encendido. */
export function bitmapPath(rows: readonly string[], ox = 0, oy = 0): string {
  const points: Point[] = [];
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x += 1)
      if (row.charAt(x) === "#") points.push([x, y]);
  });
  return pointsPath(points, ox, oy);
}

export function mergeLayers(...sources: readonly SpriteLayers[]): SpriteLayers {
  const out = emptyLayers();
  for (const source of sources) for (const key of KEYS) out[key] += source[key];
  return out;
}

export function hasKey(layers: SpriteLayers, key: SpriteKey): boolean {
  return layers[key] !== "";
}

export function spriteKeys(): readonly SpriteKey[] {
  return KEYS;
}

// ---------------------------------------------------------------- Hermes (32 × 32)

const WING_SHAPES: Readonly<
  Record<WingFrame, ReadonlyArray<readonly [number, number, number, number]>>
> = {
  up: [
    [6.5, 12, 4.5, 3.2],
    [6, 16.5, 4.5, 2.8],
    [7, 20.5, 3, 2],
  ],
  mid: [
    [6.5, 15, 4.5, 3.2],
    [6, 19, 4.5, 2.8],
    [7, 22.5, 3, 2],
  ],
  down: [
    [7, 17.5, 4, 3],
    [6.5, 21, 4, 2.6],
    [7.5, 24, 2.6, 1.8],
  ],
};

export function hermesWings(frame: WingFrame): SpriteLayers {
  const shapes = WING_SHAPES[frame];
  const split = Math.round(shapes[1]?.[1] ?? 0);
  const g = grid(32, 32);
  for (let y = 0; y < 32; y += 1) {
    for (let x = 0; x < 32; x += 1) {
      const mirrored = x < 16 ? x : 31 - x;
      if (
        shapes.some(([cx, cy, rx, ry]) =>
          inEllipse(mirrored, y, cx, cy, rx, ry),
        )
      ) {
        put(
          g,
          x,
          y,
          y > split || (y === split && (x + y) % 2 === 1) ? "R" : "P",
        );
      }
    }
  }
  return layersOf(outline(g, "K"));
}

export function hermesBody(): SpriteLayers {
  const g = grid(32, 32);
  for (let y = 0; y < 32; y += 1) {
    for (let x = 0; x < 32; x += 1) {
      const dx = (x + 0.5 - 16) / 10.5;
      const dy = (y + 0.5 - 18.5) / 10;
      if (dx ** 4 + dy ** 4 <= 1) {
        const light = dx * 0.55 + dy * 0.85;
        put(
          g,
          x,
          y,
          light > 0.62 ? "O" : light > 0.36 && (x + y) % 2 === 1 ? "O" : "Y",
        );
      }
    }
  }
  const shine: readonly Point[] = [
    [9, 11],
    [10, 11],
    [11, 11],
    [9, 12],
    [10, 12],
    [9, 13],
    [12, 10],
  ];
  shine.forEach(([x, y]) => put(g, x, y, "W"));
  for (let y = 15; y <= 19; y += 1) {
    for (let x = 9; x <= 22; x += 1) {
      const corner = (y === 15 || y === 19) && (x === 9 || x === 22);
      if (!corner) put(g, x, y, "N");
    }
  }
  for (let y = 4; y <= 7; y += 1) put(g, 16, y, "K");
  for (let y = 29; y <= 30; y += 1)
    [11, 12, 13, 18, 19, 20].forEach((x) => put(g, x, y, "N"));
  const cheeks: readonly Point[] = [
    [10, 21],
    [11, 21],
    [20, 21],
    [21, 21],
  ];
  cheeks.forEach(([x, y]) => put(g, x, y, "B"));
  return layersOf(outline(g, "K"));
}

/** Bola de la antena (la capa R se anima de coral a sol). */
export function hermesAntennaBall(): SpriteLayers {
  const g = grid(32, 8);
  for (let y = 0; y < 6; y += 1)
    for (let x = 12; x < 21; x += 1)
      if (inEllipse(x, y, 16.5, 2.5, 2.2, 2.2)) put(g, x, y, "R");
  put(g, 15, 1, "W");
  return layersOf(outline(g, "K"));
}

export interface HermesFace {
  eyesOpen: string;
  eyesSpark: string;
  eyesBlink: string;
  eyesShut: string;
  eyesUnsure: string;
  eyesHappy: string;
  mouthSmile: string;
  mouthFlat: string;
  mouthSleep: string;
  sleepZ: string;
  question: string;
}

const EYE_OPEN: readonly Point[] = [
  [12, 17],
  [13, 17],
  [12, 18],
  [13, 18],
  [18, 17],
  [19, 17],
  [18, 18],
  [19, 18],
  [13, 16],
  [19, 16],
];

export const QUESTION_MARK: readonly string[] = [
  ".###.",
  "#...#",
  "....#",
  "...#.",
  "..#..",
  ".....",
  "..#..",
];
export const SLEEP_Z: readonly string[] = ["####", "..#.", ".#..", "####"];

export function hermesFace(): HermesFace {
  return {
    eyesOpen: pointsPath(EYE_OPEN),
    eyesSpark: pointsPath([
      [12, 16],
      [18, 16],
    ]),
    eyesBlink: pointsPath([
      [12, 18],
      [13, 18],
      [18, 18],
      [19, 18],
    ]),
    eyesShut: pointsPath([
      [11, 17],
      [12, 17],
      [13, 17],
      [14, 17],
      [17, 17],
      [18, 17],
      [19, 17],
      [20, 17],
    ]),
    eyesUnsure: pointsPath([
      [13, 17],
      [18, 17],
    ]),
    eyesHappy: pointsPath([
      [11, 18],
      [12, 17],
      [13, 17],
      [14, 18],
      [17, 18],
      [18, 17],
      [19, 17],
      [20, 18],
    ]),
    mouthSmile: pointsPath([
      [13, 21],
      [14, 22],
      [15, 22],
      [16, 22],
      [17, 22],
      [18, 21],
    ]),
    mouthFlat: pointsPath([
      [14, 22],
      [15, 22],
      [16, 22],
      [17, 22],
    ]),
    mouthSleep: pointsPath([
      [15, 22],
      [16, 22],
    ]),
    sleepZ: bitmapPath(SLEEP_Z, 23, 4),
    question: bitmapPath(QUESTION_MARK, 24, -5),
  };
}

// ---------------------------------------------------------------- Router FiberHome (32 × 24)

export interface RouterSprite {
  base: SpriteLayers;
  led1: string;
  led2: string;
  led3: string;
  eyes: string;
  blink: string;
  wave1: string;
  wave2: string;
  wave3: string;
  question: string;
}

export function routerSprite(): RouterSprite {
  const g = grid(32, 24);
  for (let y = 10; y <= 21; y += 1) {
    for (let x = 3; x <= 28; x += 1) {
      const cut =
        ((y === 10 || y === 21) && (x <= 4 || x >= 27)) ||
        ((y === 11 || y === 20) && (x === 3 || x === 28));
      if (!cut)
        put(g, x, y, y >= 20 ? "C" : y === 19 && (x + y) % 2 === 1 ? "C" : "W");
    }
  }
  for (let y = 16; y <= 18; y += 1)
    for (let x = 6; x <= 25; x += 1) put(g, x, y, "N");
  const cheeks: readonly Point[] = [
    [9, 14],
    [10, 14],
    [21, 14],
    [22, 14],
  ];
  cheeks.forEach(([x, y]) => put(g, x, y, "P"));
  put(g, 15, 14, "K");
  put(g, 16, 14, "K");
  for (let y = 4; y <= 9; y += 1) {
    put(g, 8, y, "K");
    put(g, 23, y, "K");
  }
  for (let y = 0; y < 5; y += 1) {
    for (let x = 5; x < 27; x += 1) {
      if (inEllipse(x, y, 8.5, 2.5, 1.8, 1.8)) put(g, x, y, "R");
      if (inEllipse(x, y, 23.5, 2.5, 1.8, 1.8)) put(g, x, y, "M");
    }
  }
  return {
    base: layersOf(outline(g, "K")),
    led1: pointsPath([
      [8, 17],
      [9, 17],
    ]),
    led2: pointsPath([
      [12, 17],
      [13, 17],
    ]),
    led3: pointsPath([
      [16, 17],
      [17, 17],
    ]),
    eyes: pointsPath([
      [11, 12],
      [12, 12],
      [11, 13],
      [12, 13],
      [19, 12],
      [20, 12],
      [19, 13],
      [20, 13],
    ]),
    blink: pointsPath([
      [11, 13],
      [12, 13],
      [19, 13],
      [20, 13],
    ]),
    wave1: pointsPath([
      [26, 1],
      [26, 2],
      [5, 1],
      [5, 2],
    ]),
    wave2: pointsPath([
      [27, 0],
      [28, 1],
      [28, 2],
      [27, 3],
      [4, 0],
      [3, 1],
      [3, 2],
      [4, 3],
    ]),
    wave3: pointsPath([
      [29, -1],
      [30, 0],
      [31, 1],
      [31, 2],
      [30, 3],
      [29, 4],
      [2, -1],
      [1, 0],
      [0, 1],
      [0, 2],
      [1, 3],
      [2, 4],
    ]),
    question: bitmapPath(QUESTION_MARK, 13, 4),
  };
}

// ---------------------------------------------------------------- Casa (24 × 22)

export function houseSprite(): SpriteLayers {
  const g = grid(24, 22);
  for (let y = 2; y <= 5; y += 1) {
    put(g, 16, y, "V");
    put(g, 17, y, "V");
  }
  for (let y = 1; y <= 9; y += 1) {
    const half = Math.round((y - 1) * 1.3) + 1;
    for (let x = 12 - half; x < 12 + half; x += 1) {
      put(
        g,
        x,
        y,
        x > 14 ? ((x + y) % 2 === 1 ? "V" : "R") : x < 9 ? "O" : "R",
      );
    }
  }
  for (let y = 10; y <= 20; y += 1)
    for (let x = 3; x <= 20; x += 1) put(g, x, y, x >= 17 ? "C" : "W");
  for (let y = 14; y <= 20; y += 1)
    for (let x = 10; x <= 13; x += 1) put(g, x, y, "N");
  put(g, 12, 17, "Y");
  for (let y = 12; y <= 16; y += 1)
    for (let x = 4; x <= 8; x += 1)
      put(g, x, y, x === 6 || y === 14 ? "K" : "Y");
  for (let y = 12; y <= 15; y += 1)
    for (let x = 15; x <= 18; x += 1) put(g, x, y, "Y");
  return layersOf(outline(g, "K"));
}

// ---------------------------------------------------------------- Nube (24 × 10)

function cloudGrid(): Grid {
  const g = grid(24, 10);
  for (let y = 0; y < 9; y += 1) {
    for (let x = 0; x < 24; x += 1) {
      const inside =
        inEllipse(x, y, 6, 6, 4.5, 3) ||
        inEllipse(x, y, 11, 4.5, 4.5, 4) ||
        inEllipse(x, y, 16.5, 5, 4, 3.5) ||
        inEllipse(x, y, 19.5, 6.5, 3.5, 2.5);
      if (inside)
        put(g, x, y, y >= 7 ? "P" : y === 6 && (x + y) % 2 === 1 ? "P" : "W");
    }
  }
  return g;
}

export function cloudSprite(): SpriteLayers {
  return layersOf(outline(cloudGrid(), "K"));
}

// ---------------------------------------------------------------- Equipo sin integración (24 × 20)

export interface ComputerSprite {
  base: SpriteLayers;
  zzz: string;
}

export function computerSprite(): ComputerSprite {
  const g = grid(24, 20);
  for (let y = 1; y <= 14; y += 1)
    for (let x = 1; x <= 22; x += 1) put(g, x, y, "C");
  for (let y = 3; y <= 12; y += 1)
    for (let x = 3; x <= 20; x += 1) put(g, x, y, "N");
  const face: readonly Point[] = [
    [7, 8],
    [8, 8],
    [9, 8],
    [14, 8],
    [15, 8],
    [16, 8],
    [11, 10],
    [12, 10],
  ];
  face.forEach(([x, y]) => put(g, x, y, "V"));
  for (let y = 15; y <= 16; y += 1)
    for (let x = 10; x <= 13; x += 1) put(g, x, y, "C");
  for (let y = 17; y <= 18; y += 1)
    for (let x = 7; x <= 16; x += 1) put(g, x, y, "W");
  return {
    base: layersOf(outline(g, "K")),
    zzz: bitmapPath(["###", ".#.", "###"], 16, 4),
  };
}

// ---------------------------------------------------------------- Persona (16 × 16) y moneda (16 × 16)

export function personSprite(): SpriteLayers {
  const g = grid(16, 16);
  for (let y = 0; y < 16; y += 1) {
    for (let x = 0; x < 16; x += 1) {
      if (y >= 12 && inEllipse(x, y, 8, 16.5, 6.5, 4.8)) put(g, x, y, "R");
      if (inEllipse(x, y, 8, 7.5, 4.2, 4.4)) put(g, x, y, "C");
      if (y <= 5 && inEllipse(x, y, 8, 5.5, 4.8, 3.4)) put(g, x, y, "N");
    }
  }
  put(g, 6, 7, "K");
  put(g, 10, 7, "K");
  [7, 8, 9].forEach((x) => put(g, x, 9, "O"));
  return layersOf(outline(g, "K"));
}

export function coinSprite(): SpriteLayers {
  const g = grid(16, 16);
  for (let y = 0; y < 16; y += 1) {
    for (let x = 0; x < 16; x += 1) {
      if (!inEllipse(x, y, 8, 8, 6.5, 6.5)) continue;
      const light = (x - 8) * 0.6 + (y - 8) * 0.8;
      put(
        g,
        x,
        y,
        light > 2.6 ? "O" : light > 1.4 && (x + y) % 2 === 1 ? "O" : "Y",
      );
      if (inEllipse(x, y, 8, 8, 5, 5) && !inEllipse(x, y, 8, 8, 4, 4))
        put(g, x, y, "O");
    }
  }
  const shine: readonly Point[] = [
    [4, 4],
    [5, 3],
    [3, 5],
    [4, 5],
  ];
  shine.forEach(([x, y]) => put(g, x, y, "W"));
  for (let y = 6; y <= 9; y += 1) put(g, 8, y, "O");
  return layersOf(outline(g, "K"));
}

// ---------------------------------------------------------------- Escena de atardecer (130 × 64)

export interface CloudPaths {
  fill: string;
  shade: string;
}

export interface SceneSprite {
  sky: SpriteLayers;
  stars1: string;
  stars2: string;
  stars3: string;
  sun: SpriteLayers;
  halo: string;
  cloud1: CloudPaths;
  cloud2: CloudPaths;
  cloud3: CloudPaths;
  hills: SpriteLayers;
  window: string;
  firefly1: string;
  firefly2: string;
  firefly3: string;
  firefly4: string;
  shootingStar: string;
}

export const SCENE_WIDTH = 130;
export const SCENE_HEIGHT = 64;

export function sceneSprite(): SceneSprite {
  const sky = grid(SCENE_WIDTH, SCENE_HEIGHT);
  const bands: ReadonlyArray<readonly [number, SpriteKey]> = [
    [0, "K"],
    [28, "N"],
    [36, "V"],
    [44, "R"],
    [51, "O"],
  ];
  for (let y = 0; y < SCENE_HEIGHT; y += 1) {
    for (let x = 0; x < SCENE_WIDTH; x += 1) {
      let band = 0;
      while (band + 1 < bands.length && y >= (bands[band + 1]?.[0] ?? Infinity))
        band += 1;
      let key: SpriteKey = bands[band]?.[1] ?? "K";
      const next = bands[band + 1];
      if (next !== undefined) {
        const edge = next[0];
        if (y === edge - 1 && (x + y) % 2 === 0) key = next[1];
        if (y === edge - 2 && x % 2 === 0 && y % 2 === 0) key = next[1];
      }
      put(sky, x, y, key);
    }
  }
  const stars: Point[][] = [[], [], []];
  for (let i = 0; i < 30; i += 1)
    stars[i % 3]?.push([(i * 47 + 13) % SCENE_WIDTH, (i * 23 + 5) % 30]);

  const sun = grid(SCENE_WIDTH, SCENE_HEIGHT);
  const halo: Point[] = [];
  for (let y = 0; y < SCENE_HEIGHT; y += 1) {
    for (let x = 0; x < SCENE_WIDTH; x += 1) {
      if (inEllipse(x, y, 98, 62, 17, 17)) {
        if (!(y >= 50 && y % 3 === 0)) put(sun, x, y, y >= 56 ? "O" : "Y");
      } else if (inEllipse(x, y, 98, 62, 20, 20) && (x + y) % 2 === 0) {
        halo.push([x, y]);
      }
    }
  }

  const cloud = cloudGrid();
  const cloudAt = (ox: number, oy: number): CloudPaths => {
    const layers = layersOf(cloud, ox, oy);
    return { fill: layers.W, shade: layers.P };
  };

  const hills = grid(SCENE_WIDTH, SCENE_HEIGHT);
  for (let x = 0; x < SCENE_WIDTH; x += 1) {
    const far = Math.round(
      54 + 2.5 * Math.sin(x / 9) + 1.5 * Math.sin(x / 4.3),
    );
    const near = Math.round(
      58 + 2.5 * Math.sin(x / 13 + 1) + 1.2 * Math.sin(x / 5),
    );
    for (let y = far; y < SCENE_HEIGHT; y += 1) put(hills, x, y, "N");
    for (let y = near; y < SCENE_HEIGHT; y += 1) put(hills, x, y, "K");
  }
  for (let y = 53; y < 59; y += 1) {
    for (let x = 20; x < 30; x += 1) {
      const half = y - 53;
      if (y < 56) {
        if (x >= 25 - half - 1 && x <= 24 + half + 1) put(hills, x, y, "K");
      } else if (x >= 21 && x <= 28) put(hills, x, y, "K");
    }
  }

  return {
    sky: layersOf(sky),
    stars1: pointsPath(stars[0] ?? []),
    stars2: pointsPath(stars[1] ?? []),
    stars3: pointsPath(stars[2] ?? []),
    sun: layersOf(sun),
    halo: pointsPath(halo),
    cloud1: cloudAt(54, 33),
    cloud2: cloudAt(8, 40),
    cloud3: cloudAt(104, 30),
    hills: layersOf(hills),
    window: pointsPath([
      [23, 57],
      [24, 57],
      [23, 58],
      [24, 58],
    ]),
    firefly1: pointsPath([[40, 59]]),
    firefly2: pointsPath([[70, 58]]),
    firefly3: pointsPath([[86, 60]]),
    firefly4: pointsPath([[52, 60]]),
    shootingStar: pointsPath([
      [60, 6],
      [61, 6],
      [62, 5],
      [63, 5],
      [64, 4],
    ]),
  };
}
