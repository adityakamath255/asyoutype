export const PALETTE = [
  "rgb(245, 224, 220)",
  "rgb(242, 205, 205)",
  "rgb(245, 194, 231)",
  "rgb(203, 166, 247)",
  "rgb(243, 139, 168)",
  "rgb(235, 160, 172)",
  "rgb(250, 179, 135)",
  "rgb(249, 226, 175)",
  "rgb(166, 227, 161)",
  "rgb(148, 226, 213)",
  "rgb(137, 220, 235)",
  "rgb(116, 199, 236)",
  "rgb(137, 180, 250)",
  "rgb(180, 190, 254)",
] as const;

declare const paletteIndex: unique symbol;
type PaletteIndex = number & { readonly [paletteIndex]: true };

export const isPaletteIndex = (value: unknown): value is PaletteIndex =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= 0 &&
  value < PALETTE.length;
