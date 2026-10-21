// Ícono de la app (variante D): solo el sprite de Hermes sobre el azul noche, sin decoración.
// Cuadrícula de 40 px; el yelmo con alas ocupa ~78 % del ancho y queda dentro de la zona segura.
import { hermesArt, type ArtLayer } from "../ui/src/sprites/hermes.ts";

const GRID = 40;
const NIGHT = "#1B1A3A";
const OFFSET_X = 4;
const OFFSET_Y = 5;

function layers(list: readonly ArtLayer[]): string {
  return list
    .map((l) => `<path transform="translate(${OFFSET_X} ${OFFSET_Y})" fill="${l.fill}" d="${l.d}"/>`)
    .join("");
}

export function appIconSvg(): string {
  const art = hermesArt();
  const body = [
    `<rect width="${GRID}" height="${GRID}" fill="${NIGHT}"/>`,
    layers(art.wingsMid),
    layers(art.helmet),
    `<path transform="translate(${OFFSET_X} ${OFFSET_Y})" fill="#7FD8BE" d="${art.led}"/>`,
    layers(art.eyesOpen),
  ].join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${GRID} ${GRID}" shape-rendering="crispEdges">${body}</svg>`;
}
