import test from 'node:test';
import assert from 'node:assert/strict';
import { recolor, parseColor, validateRule } from '../src/recolor.ts';
import { alphaHash, encodePng, decodePng, pixelDiff, sha256, blank } from '../src/pixels.ts';
import { sample, rule } from './helpers.ts';

test('hex color normalizes to uppercase with exact RGB', () => assert.deepEqual(parseColor('#7a5af8'), { hex: '#7A5AF8', rgb: [122, 90, 248] }));
for (const color of ['#000000', '#FFFFFF']) test('boundary color accepted: ' + color, () => assert.equal(parseColor(color).hex, color));
for (const color of ['', '7A5AF8', '#ABC', '#7A5AF8FF', '#GG5AF8', ' #7A5AF8', '#7A5AF8 ', 'rgb(122,90,248)', null]) {
  test('invalid color returns explicit error: ' + JSON.stringify(color), () => assert.throws(() => parseColor(color), /INVALID_COLOR.*#RRGGBB/));
}
test('all 256 alpha byte values are preserved, including faint edges', () => {
  const input = blank(256, 1);
  for (let a = 0; a < 256; a++) input.data.set([19, 23, 45, a], a * 4);
  const output = recolor(input, '#7A5AF8').image;
  assert.equal(alphaHash(input), alphaHash(output));
  for (let a = 0; a < 256; a++) assert.equal(output.data[a * 4 + 3], a);
});
test('only alpha>0 pixels change; alpha=0 invisible RGB is byte-identical', () => {
  const input = sample(), output = recolor(input, '#7A5AF8').image;
  assert.deepEqual(output.data.slice(8, 12), input.data.slice(8, 12));
  assert.deepEqual(pixelDiff(input, output, (x, y) => !!input.data[(y * input.width + x) * 4 + 3]), { changedPixels: 4, alphaChangedPixels: 0, outsideAllowedChangedPixels: 0 });
});
test('original raster is never mutated and dimensions remain fixed', () => {
  const input = sample(), copy = structuredClone(input), output = recolor(input, '#7A5AF8').image;
  assert.deepEqual(input, copy); assert.notEqual(output.data, input.data);
  assert.equal(output.width, input.width); assert.equal(output.height, input.height);
});
test('report counts actual changes and every original visible RGB color', () => {
  const result = recolor(sample(), '#7A5AF8');
  assert.equal(result.allowedPixels, 5); assert.equal(result.changedPixels, 4);
  assert.deepEqual(result.originalColors, [{ hex: '#010203', pixels: 1 }, { hex: '#3F5F9B', pixels: 3 }, { hex: '#7A5AF8', pixels: 1 }]);
});
test('same input produces deterministic encoded PNG bytes', () => {
  assert.deepEqual(encodePng(recolor(sample(), '#7A5AF8').image), encodePng(recolor(sample(), '#7a5af8').image));
});
test('PNG encode/decode retains alpha and invisible RGB exactly', () => {
  const input = recolor(sample(), '#7A5AF8').image;
  assert.equal(sha256(input.data), sha256(decodePng(encodePng(input)).data));
});
test('transparent-only raster remains entirely unchanged', () => {
  const input = blank(2, 1); input.data.set([12, 34, 56, 0, 255, 255, 255, 0]);
  const result = recolor(input, '#7A5AF8'); assert.deepEqual(result.image, input); assert.equal(result.changedPixels, 0);
});
test('explicit null mask is accepted', () => assert.deepEqual(validateRule(rule), rule));
for (const maskPath of ['mask.png', undefined, '']) test('unsupported mask fails closed: ' + String(maskPath), () => assert.throws(() => validateRule({ ...rule, maskPath }), /MASK_NOT_SUPPORTED/));
test('unknown rule field is rejected', () => assert.throws(() => validateRule({ ...rule, tolerance: 0.2 }), /RULE_INVALID/));
test('non-Outfit rule is rejected', () => assert.throws(() => validateRule({ ...rule, expectedLayerName: 'Face' }), /RULE_INVALID/));
test('unsupported operation and region are rejected', () => {
  assert.throws(() => validateRule({ ...rule, operation: 'hue-shift' }), /RULE_INVALID/);
  assert.throws(() => validateRule({ ...rule, allowedRegion: 'all-pixels' }), /RULE_INVALID/);
});
