import {
  cloudSprite,
  coinSprite,
  computerSprite,
  hermesAntennaBall,
  hermesBody,
  hermesFace,
  hermesWings,
  houseSprite,
  personSprite,
  routerSprite,
  sceneSprite,
  type ComputerSprite,
  type HermesFace,
  type RouterSprite,
  type SceneSprite,
  type SpriteLayers,
} from "./generator.ts";

export interface SpriteLibrary {
  hermes: {
    wingsUp: SpriteLayers;
    wingsMid: SpriteLayers;
    wingsDown: SpriteLayers;
    body: SpriteLayers;
    ball: SpriteLayers;
    face: HermesFace;
  };
  router: RouterSprite;
  house: SpriteLayers;
  cloud: SpriteLayers;
  computer: ComputerSprite;
  person: SpriteLayers;
  coin: SpriteLayers;
  scene: SceneSprite;
}

let library: SpriteLibrary | null = null;

/** Se generan una sola vez por sesión (determinista, ~20 ms). */
export function getSprites(): SpriteLibrary {
  if (library === null) {
    library = {
      hermes: {
        wingsUp: hermesWings("up"),
        wingsMid: hermesWings("mid"),
        wingsDown: hermesWings("down"),
        body: hermesBody(),
        ball: hermesAntennaBall(),
        face: hermesFace(),
      },
      router: routerSprite(),
      house: houseSprite(),
      cloud: cloudSprite(),
      computer: computerSprite(),
      person: personSprite(),
      coin: coinSprite(),
      scene: sceneSprite(),
    };
  }
  return library;
}
