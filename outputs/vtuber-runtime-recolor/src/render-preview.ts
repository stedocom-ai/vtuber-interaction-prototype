import { blank } from '../../vtuber-controlled-recolor/src/pixels.ts';
import type { Raster } from '../../vtuber-controlled-recolor/src/pixels.ts';
import type { Inventory } from './core-reader.ts';
import { cross } from './uv.ts';
import type { Point } from './uv.ts';

/** Diagnostic base-level bilinear sampling after premultiplication; no mipmaps, GUI or runtime certification. */
export function sampleTexture(texture: Raster, u: number, v: number): number[] {
  const px = u * texture.width - 0.5, py = (1 - v) * texture.height - 0.5, x = Math.floor(px), y = Math.floor(py), fx = px - x, fy = py - y;
  const out = [0, 0, 0, 0];
  for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
    const xx = Math.max(0, Math.min(texture.width - 1, x + dx)), yy = Math.max(0, Math.min(texture.height - 1, y + dy));
    const i = (yy * texture.width + xx) * 4, a = texture.data[i + 3]! / 255, weight = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy);
    for (let c = 0; c < 3; c++) out[c] = out[c]! + texture.data[i + c]! / 255 * a * weight;
    out[3] = out[3]! + a * weight;
  }
  return out;
}
export function renderPreview(inventory: Inventory, textures: Raster[]): Raster {
  const canvas = inventory.canvas, out = blank(canvas.width, canvas.height), buffer = new Float64Array(out.data.length);
  if (inventory.parts.length || inventory.offscreenCount) throw new Error('PREVIEW_UNSUPPORTED_PARTS_OR_OFFSCREENS');
  const ordered = [...inventory.drawables].sort((a, b) => a.renderOrder - b.renderOrder);
  for (const d of ordered) {
    // The official premultiplied shader uses only RGB of multiply/screen colors.
    if (d.masks.length || d.blendMode !== 0 || d.multiplyColor.slice(0, 3).some(v => v !== 1) || d.screenColor.slice(0, 3).some(v => v !== 0)) throw new Error('PREVIEW_UNSUPPORTED_EFFECT: ' + d.id);
    if (d.opacity <= 0 || !(d.dynamicFlags & 1)) continue;
    const visited = new Uint8Array(canvas.width * canvas.height), texture = textures[d.textureIndex]!;
    const vertices: Point[] = Array.from({ length: d.vertexPositions.length / 2 }, (_, i) => [
      canvas.originX + d.vertexPositions[i * 2]! * canvas.pixelsPerUnit,
      canvas.originY - d.vertexPositions[i * 2 + 1]! * canvas.pixelsPerUnit,
    ]);
    for (let j = 0; j < d.triangleIndices.length; j += 3) {
      const indices = d.triangleIndices.slice(j, j + 3), tri = indices.map(i => vertices[i]!), denominator = cross(tri[0]!, tri[1]!, tri[2]!);
      if (Math.abs(denominator) < 1e-10) continue;
      const x0 = Math.max(0, Math.floor(Math.min(...tri.map(p => p[0])))), x1 = Math.min(canvas.width - 1, Math.ceil(Math.max(...tri.map(p => p[0]))));
      const y0 = Math.max(0, Math.floor(Math.min(...tri.map(p => p[1])))), y1 = Math.min(canvas.height - 1, Math.ceil(Math.max(...tri.map(p => p[1]))));
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const pixel = y * canvas.width + x; if (visited[pixel]) continue;
        const p: Point = [x + 0.5, y + 0.5], weights = [cross(tri[1]!, tri[2]!, p) / denominator, cross(tri[2]!, tri[0]!, p) / denominator, cross(tri[0]!, tri[1]!, p) / denominator];
        if (weights.some(w => w < -1e-8)) continue;
        visited[pixel] = 1;
        let u = 0, v = 0;
        for (let k = 0; k < 3; k++) { u += weights[k]! * d.vertexUvs[indices[k]! * 2]!; v += weights[k]! * d.vertexUvs[indices[k]! * 2 + 1]!; }
        const color = sampleTexture(texture, u, v).map(value => value * d.opacity), a = color[3]!, offset = pixel * 4;
        for (let c = 0; c < 4; c++) buffer[offset + c] = color[c]! + buffer[offset + c]! * (1 - a);
      }
    }
  }
  for (let i = 0; i < buffer.length; i += 4) {
    const a = buffer[i + 3]!;
    if (a) for (let c = 0; c < 3; c++) out.data[i + c] = Math.round(Math.max(0, Math.min(1, buffer[i + c]! / a)) * 255);
    out.data[i + 3] = Math.round(Math.max(0, Math.min(1, a)) * 255);
  }
  return out;
}
