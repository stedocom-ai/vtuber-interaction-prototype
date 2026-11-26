import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { moduleRoot } from '../src/integrate.ts';
import { save, saveJson } from '../../vtuber-controlled-recolor/src/files.ts';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--sdk' || !args[1]) throw new Error('USAGE: verify-runtime.ts --sdk "external SDK root"');
await mkdir(path.join(moduleRoot, 'verification'), { recursive: true });
const output = await mkdtemp(path.join(moduleRoot, 'verification', new Date().toISOString().replace(/[:.]/g, '-') + '_'));
const env = { ...process.env, RUNTIME_SDK_ROOT: args[1], RUNTIME_VERIFY_DIR: output };
async function run(commandArgs: string[]) {
  return new Promise<{ exitCode: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, commandArgs, { cwd: moduleRoot, env, windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
    child.on('error', reject); child.on('close', exitCode => resolve({ exitCode, stdout, stderr }));
  });
}
console.log('Verification output: ' + output);
const typecheck = await run(['../vtuber-controlled-recolor/node_modules/typescript/bin/tsc', '--noEmit', '--strict', '--skipLibCheck',
  '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2023', '--allowImportingTsExtensions',
  '--typeRoots', '../vtuber-controlled-recolor/node_modules/@types',
  'src/runtime-cli.ts', 'tests/preflight.test.ts', 'tests/uv.test.ts', 'tests/runtime.integration.test.ts', 'scripts/verify-runtime.ts']);
await saveJson(path.join(output, 'typecheck.json'), typecheck);
if (typecheck.exitCode !== 0) { console.error(typecheck.stdout + typecheck.stderr); throw new Error('TYPECHECK_FAILED'); }
console.log('TypeScript strict typecheck passed; running unit and real-model tests.');
const tests = await run(['--test', '--test-concurrency=1', '--test-reporter=tap', 'tests/preflight.test.ts', 'tests/uv.test.ts', 'tests/runtime.integration.test.ts']);
await save(path.join(output, 'tests.tap'), tests.stdout); await save(path.join(output, 'tests.stderr.txt'), tests.stderr);
const count = (name: string) => Number(new RegExp('^# ' + name + ' (\\d+)$', 'm').exec(tests.stdout)?.[1] ?? -1);
type RunStatus = { status: string; manualAcceptance: { cubismViewer: string; vTubeStudio: string; overallComplete: boolean } };
const primaryReport = JSON.parse(await readFile(path.join(moduleRoot, 'runs/reference-v1-purple/acceptance.json'), 'utf8')) as RunStatus;
const repeatReport = await readFile(path.join(output, 'repeat-run/acceptance.json'), 'utf8').then(s => JSON.parse(s) as RunStatus).catch(() => null);
const summary = { status: tests.exitCode === 0 ? 'AUTOMATED_REGRESSION_PASS' : 'ERROR', output,
  typecheck: 'PASS', exitCode: tests.exitCode, tests: count('tests'), pass: count('pass'), fail: count('fail'), skipped: count('skipped'),
  cancelled: count('cancelled'), runtimeChecksPerRun: 18,
  primaryRunStatus: primaryReport.status, primaryManualAcceptance: primaryReport.manualAcceptance,
  independentRepeatRunStatus: repeatReport?.status ?? 'NOT_AVAILABLE', independentRepeatManualAcceptance: repeatReport?.manualAcceptance ?? null,
  primaryRun: path.join(moduleRoot, 'runs/reference-v1-purple'), independentRepeatRun: path.join(output, 'repeat-run') };
await saveJson(path.join(output, 'verification.json'), summary);
await save(path.join(output, 'verification.md'), `# 运行时换色回归测试\n\n状态：${summary.status}。\n\n` +
  `- TypeScript 严格类型检查：通过。\n- 自动测试：${summary.pass}/${summary.tests} 通过；失败 ${summary.fail}；跳过 ${summary.skipped}；取消 ${summary.cancelled}。\n` +
  `- 覆盖引用安全、三角形光栅化、歧义/重叠拒绝、Alpha 与 mask 边界、官方 Core 实际模型、完整模型复制、独立运行确定性、SDK 与原文件只读保护。\n` +
  `- 主模型：${summary.primaryRun}\n- 第二次独立完整运行：${summary.independentRepeatRun}\n- 每次完整运行另含 18 项自动验收检查。\n` +
  `- 没有复制 SDK/Core。测试通过外部 SDK 路径读取 Core，测试夹具不包含官方库。既有主模型与验收结果没有覆盖。\n\n` +
  `完整 TAP 日志：tests.tap；类型检查：typecheck.json；真实运行记录：real-model-run-receipt.json。\n\n` +
  `主模型当前状态：${summary.primaryRunStatus}；Viewer：${primaryReport.manualAcceptance.cubismViewer}；VTS：${primaryReport.manualAcceptance.vTubeStudio}。该状态来自主模型已有验收记录。\n\n` +
  `本次新生成复现模型状态：${summary.independentRepeatRunStatus}。**自动回归不会为新模型添加人工通过，也不会撤销主模型已有的人工验收。**\n`);
console.log(JSON.stringify(summary, null, 2));
if (tests.exitCode !== 0) { console.error(tests.stdout + tests.stderr); process.exitCode = 2; }
