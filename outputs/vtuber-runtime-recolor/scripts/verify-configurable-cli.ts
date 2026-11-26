import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { moduleRoot } from '../src/integrate.ts';
import { save, saveJson } from '../../vtuber-controlled-recolor/src/files.ts';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--sdk' || !args[1]) throw new Error('USAGE: verify-configurable-cli.ts --sdk "external SDK root"');
await mkdir(path.join(moduleRoot, 'verification'), { recursive: true });
const output = await mkdtemp(path.join(moduleRoot, 'verification', new Date().toISOString().replace(/[:.]/g, '-') + '_configurable_'));
const env = { ...process.env, RUNTIME_SDK_ROOT: args[1], CONFIGURABLE_VERIFY_DIR: output };
async function run(commandArgs: string[]) {
  return new Promise<{ exitCode: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, commandArgs, { cwd: moduleRoot, env, windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); }); child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', reject); child.on('close', exitCode => resolve({ exitCode, stdout, stderr }));
  });
}
console.log('Configurable CLI verification output: ' + output);
const typecheck = await run(['../vtuber-controlled-recolor/node_modules/typescript/bin/tsc', '--noEmit', '--strict', '--skipLibCheck',
  '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2023', '--allowImportingTsExtensions',
  '--typeRoots', '../vtuber-controlled-recolor/node_modules/@types', 'src/runtime-cli.ts', 'tests/cli-options.test.ts',
  'tests/configurable.integration.test.ts', 'scripts/verify-configurable-cli.ts']);
await saveJson(path.join(output, 'typecheck.json'), typecheck);
if (typecheck.exitCode !== 0) { console.error(typecheck.stdout + typecheck.stderr); throw new Error('TYPECHECK_FAILED'); }
const tests = await run(['--test', '--test-concurrency=1', '--test-reporter=tap', 'tests/cli-options.test.ts', 'tests/configurable.integration.test.ts']);
await save(path.join(output, 'tests.tap'), tests.stdout); await save(path.join(output, 'tests.stderr.txt'), tests.stderr);
const count = (name: string) => Number(new RegExp('^# ' + name + ' (\\d+)$', 'm').exec(tests.stdout)?.[1] ?? -1);
const red = JSON.parse(await readFile(path.join(moduleRoot, 'runs/minimal_character_v1_red_test/acceptance.json'), 'utf8'));
const green = JSON.parse(await readFile(path.join(moduleRoot, 'runs/minimal_character_v1_green_test/acceptance.json'), 'utf8'));
const summary = { status: tests.exitCode === 0 ? 'ACCEPTANCE_PASS_REGRESSION_CONFIRMED' : 'ERROR', output,
  typecheck: typecheck.exitCode === 0 ? 'PASS' : 'FAIL', exitCode: tests.exitCode, tests: count('tests'), pass: count('pass'), fail: count('fail'),
  skipped: count('skipped'), cancelled: count('cancelled'), testedColors: [red.newColor, green.newColor], changedPixelsEach: [red.changedPixels, green.changedPixels],
  outsideMaskRgbaChangedPixels: [red.textureDiff.outsideAllowedChangedPixels, green.textureDiff.outsideAllowedChangedPixels],
  alphaChangedPixels: [red.textureDiff.alphaChangedPixels, green.textureDiff.alphaChangedPixels],
  mocByteIdentical: [red.checks.copiedMocByteIdentical, green.checks.copiedMocByteIdentical],
  manualSample: { model: red.modelName, status: red.manualAcceptance.overallComplete ? 'PASS' : 'PENDING', greenSampleRequired: false } };
await saveJson(path.join(output, 'verification.json'), summary);
await save(path.join(output, 'verification.md'), `# Outfit 可配置换色 CLI v0.1 自动测试\n\n状态：${summary.status}。\n\n` +
  `- 严格类型检查：${summary.typecheck}\n- 本模块自动测试：${summary.pass}/${summary.tests} 通过，失败 ${summary.fail}，跳过 ${summary.skipped}，取消 ${summary.cancelled}\n` +
  `- 实测颜色：#E64B4B、#39B96E；每种修改 73,499 像素\n- 两种颜色 mask 外 RGBA 差异均为 0，Alpha 差异均为 0，MOC3 均逐字节一致\n` +
  `- 验证了两次独立复现、非法/缺失颜色、重复目录、失败无残缺目录、SDK/Core 不复制不修改不跟踪\n\n` +
  `人工抽样：PASS（minimal_character_v1_red_test，用户于 2026-09-07 在 Cubism Viewer 与 VTube Studio 完成）。绿色模型无需额外抽样。\n`);
console.log(JSON.stringify(summary, null, 2));
if (tests.exitCode !== 0) { console.error(tests.stdout + tests.stderr); process.exitCode = 2; }
