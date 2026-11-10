import { sampleBilinear, type RgbaImage } from './pixels.js';

export type Point = [number, number];
export type Quad = [Point, Point, Point, Point];

/** 3x3 inverse; returns null if singular. */
function invert3(m: number[]): number[] | null {
  const [a, b, c, d, e, f, g, h, i] = m as [number, number, number, number, number, number, number, number, number];
  const A = e * i - f * h;
  const B = f * g - d * i;
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  const inv = 1 / det;
  return [
    A * inv, (c * h - b * i) * inv, (b * f - c * e) * inv,
    B * inv, (a * i - c * g) * inv, (c * d - a * f) * inv,
    C * inv, (b * g - a * h) * inv, (a * e - b * d) * inv,
  ];
}

function mul3(a: number[], b: number[]): number[] {
  const r = new Array<number>(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      r[i * 3 + j] = a[i * 3]! * b[j]! + a[i * 3 + 1]! * b[3 + j]! + a[i * 3 + 2]! * b[6 + j]!;
    }
  }
  return r;
}

/** Homography mapping unit square corners (or src quad) to dest quad. */
function quadToSquare(q: Quad): number[] | null {
  // Map q → (0,0),(1,0),(1,1),(0,1) using the standard 4-point homography.
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
  const dx1 = x1 - x2;
  const dx2 = x3 - x2;
  const dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2;
  const dy2 = y3 - y2;
  const dy3 = y0 - y1 + y2 - y3;
  let g: number, h: number;
  const den = dx1 * dy2 - dy1 * dx2;
  if (Math.abs(den) < 1e-12) {
    g = 0;
    h = 0;
  } else {
    g = (dx3 * dy2 - dy3 * dx2) / den;
    h = (dx1 * dy3 - dy1 * dx3) / den;
  }
  const a = x1 - x0 + g * x1;
  const b = x3 - x0 + h * x3;
  const c = x0;
  const d = y1 - y0 + g * y1;
  const e = y3 - y0 + h * y3;
  const f = y0;
  // This maps (u,v) in unit square to q. We want the inverse: dest → unit.
  return invert3([a, b, c, d, e, f, g, h, 1]);
}

function applyH(H: number[], x: number, y: number): Point {
  const w = H[6]! * x + H[7]! * y + H[8]!;
  if (Math.abs(w) < 1e-12) return [NaN, NaN];
  return [(H[0]! * x + H[1]! * y + H[2]!) / w, (H[3]! * x + H[4]! * y + H[5]!) / w];
}

/**
 * Warp `src` so its four corners land on `quad` (local source-space dest, TL→TR→BR→BL).
 * Returns the bounding-box image and the (minX, minY) of the quad, matching pil-utils.perspective
 * size = (max-min) then paste at a point (typically the bbox origin, or an explicit paste).
 */
export function perspectiveWarp(src: RgbaImage, quad: Quad): { image: RgbaImage; minX: number; minY: number } {
  const xs = quad.map((p) => p[0]);
  const ys = quad.map((p) => p[1]);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const newW = Math.max(1, Math.trunc(Math.max(...xs) - minX));
  const newH = Math.max(1, Math.trunc(Math.max(...ys) - minY));
  const translated: Quad = [
    [quad[0][0] - minX, quad[0][1] - minY],
    [quad[1][0] - minX, quad[1][1] - minY],
    [quad[2][0] - minX, quad[2][1] - minY],
    [quad[3][0] - minX, quad[3][1] - minY],
  ];
  const H = quadToSquare(translated);
  const data = new Uint8Array(newW * newH * 4);
  if (H) {
    // H maps dest (translated) → unit square; scale unit square to source pixels.
    const sw = src.width;
    const sh = src.height;
    for (let y = 0; y < newH; y++) {
      for (let x = 0; x < newW; x++) {
        const [u, v] = applyH(H, x, y);
        if (!Number.isFinite(u) || !Number.isFinite(v)) continue;
        sampleBilinear(src, u * (sw - 1), v * (sh - 1), data, (y * newW + x) * 4);
      }
    }
  }
  return { image: { width: newW, height: newH, data }, minX, minY };
}

/** Convenience: warp then report paste origin if the caller wants local-quad alignment at `paste`. */
export function warpToLocalQuad(src: RgbaImage, quad: Quad, pasteX: number, pasteY: number): { image: RgbaImage; x: number; y: number } {
  const { image, minX, minY } = perspectiveWarp(src, quad);
  // pil-utils does not translate the dest before transform, then pastes at `paste`.
  // We translated by -min, so the bbox origin should be placed at paste. That matches
  // the intended geometry (bbox of the quad sits with its min at paste).
  return { image, x: Math.round(pasteX), y: Math.round(pasteY) };
  void minX;
  void minY;
}
