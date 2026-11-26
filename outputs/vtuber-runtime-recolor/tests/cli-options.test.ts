import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { normalizeRgbHex, parseRuntimeArgs, validateModelName } from '../src/cli-options.ts';

const root = path.resolve('runtime-module-fixture');
test('strict #RRGGBB input is normalized to uppercase', () => {
  assert.equal(normalizeRgbHex('#e64b4b'), '#E64B4B');
  assert.equal(normalizeRgbHex('#39B96E'), '#39B96E');
});
test('alpha, short, missing-hash, whitespace and non-hex colors fail explicitly', () => {
  for (const value of ['#E64B4BFF', '#F00', 'E64B4B', ' #E64B4B', '#E64B4G', '']) assert.throws(() => normalizeRgbHex(value), /INVALID_COLOR/);
});
test('CLI requires SDK and color', () => {
  assert.throws(() => parseRuntimeArgs([], root), /SDK_REQUIRED/);
  assert.throws(() => parseRuntimeArgs(['--sdk', 'D:/sdk'], root), /COLOR_REQUIRED/);
});
test('explicit output name controls both run folder and model identity', () => {
  const result = parseRuntimeArgs(['--sdk', 'D:/sdk', '--color', '#e64b4b', '--output-name', 'minimal_character_v1_red_test'], root);
  assert.equal(result.color, '#E64B4B'); assert.equal(result.outputName, 'minimal_character_v1_red_test');
  assert.equal(result.outputDirectory, path.join(root, 'runs'));
  assert.equal(result.output, path.join(root, 'runs', 'minimal_character_v1_red_test'));
});
test('GUI-facing source model and output directory are passed through without changing model scope', () => {
  const result = parseRuntimeArgs(['--sdk', 'D:/sdk', '--source-model', 'D:/model/minimal.model3.json', '--color', '#112233',
    '--output-name', 'minimal_character_v1_gui_test', '--output-dir', 'D:/chosen'], root);
  assert.equal(result.sourceModel, 'D:/model/minimal.model3.json'); assert.equal(result.outputDirectory, path.resolve('D:/chosen'));
  assert.equal(result.output, path.join(path.resolve('D:/chosen'), 'minimal_character_v1_gui_test'));
});
test('output name is deterministic when omitted', () => {
  const result = parseRuntimeArgs(['--sdk', 'D:/sdk', '--color', '#39B96E'], root);
  assert.equal(result.outputName, 'minimal_character_v1_39b96e_test');
});
test('unsafe output names are rejected', () => {
  for (const value of ['../outside', 'C:drive', 'has space', '_leading', 'a'.repeat(65), '']) assert.throws(() => validateModelName(value), /INVALID_OUTPUT_NAME/);
});
test('unknown, duplicate and missing-value arguments are rejected', () => {
  assert.throws(() => parseRuntimeArgs(['--wat'], root), /UNKNOWN_ARGUMENT/);
  assert.throws(() => parseRuntimeArgs(['--sdk', 'a', '--sdk', 'b', '--color', '#000000'], root), /DUPLICATE_ARGUMENT/);
  assert.throws(() => parseRuntimeArgs(['--sdk', '--color', '#000000'], root), /MISSING_ARGUMENT_VALUE/);
});
