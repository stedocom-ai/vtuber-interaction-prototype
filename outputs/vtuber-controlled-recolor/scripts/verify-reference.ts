import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { moduleRoot } from '../src/run.ts';
import { save, saveJson } from '../src/files.ts';

async function capture(args: string[], extraEnv: Record<string, string> = {}) {
  return new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: moduleRoot, windowsHide: true, env: { ...process.env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', b => { stdout += b.toString(); }); child.stderr.on('data', b => { stderr += b.toString(); });
    child.on('error', reject); child.on('close', code => resolve({ exitCode: code ?? 1, stdout, stderr }));
  });
}
try {
  const root = path.join(moduleRoot, 'verification'); await mkdir(root, { recursive: true });
  const output = await mkdtemp(path.join(root, new Date().toISOString().replace(/[:.]/g, '-') + '_'));
  console.log('正在运行类型检查和自动测试（包含实际 Outfit 的两次独立换色）……');
  const typecheck = await capture(['node_modules/typescript/bin/tsc', '--noEmit']);
  await saveJson(path.join(output, 'typecheck.json'), typecheck);
  if (typecheck.exitCode !== 0) throw new Error('TYPECHECK_FAILED: ' + typecheck.stdout + typecheck.stderr);
  const tests = await capture(['--test', '--test-concurrency=1', '--test-reporter=tap', 'tests/recolor.test.ts', 'tests/run.test.ts', 'tests/reference.test.ts'], { RECOLOR_VERIFY_DIR: output });
  await save(path.join(output, 'tests.tap'), tests.stdout); await save(path.join(output, 'tests.stderr.txt'), tests.stderr);
  const number = (name: string) => { const match = tests.stdout.match(new RegExp('^# ' + name + ' (\\d+)$', 'm')); if (!match) throw new Error('TEST_SUMMARY_MISSING: ' + name); return Number(match[1]); };
  const counts = { tests: number('tests'), pass: number('pass'), fail: number('fail'), cancelled: number('cancelled'), skipped: number('skipped'), todo: number('todo') };
  const passed = tests.exitCode === 0 && counts.tests === counts.pass && counts.fail === 0 && counts.skipped === 0 && counts.cancelled === 0 && counts.todo === 0;
  const runs = JSON.parse(await readFile(path.join(output, 'reference-runs.json'), 'utf8')) as { first: string; second: string };
  const report = { status: passed ? 'PASS' : 'FAIL', counts, typecheckPassed: true, verificationDirectory: output, referenceRuns: runs,
    determinismScope: 'two real runs: all PNG bytes/hashes and layer-manifest.json identical; report paths/timestamps intentionally differ' };
  await saveJson(path.join(output, 'verification.json'), report);
  await save(path.join(output, 'verification.md'), `# Outfit 受控换色自动测试验收\n\n结论：${report.status}\n\n- 自动测试 ${counts.tests} 项：通过 ${counts.pass}，失败 ${counts.fail}，跳过 ${counts.skipped}，取消 ${counts.cancelled}。\n- TypeScript 类型检查通过。\n- 已使用实际 Outfit 与 #7A5AF8，完成两次独立运行；所有生成 PNG 和输出 manifest 完全一致。运行目录、时间和报告中的绝对路径按设计不同。\n- 完整日志：tests.tap。原始文件保护与逐像素结果：下列运行目录中的 acceptance.json / acceptance.md。\n\n首轮（建议人工验收）：${runs.first}\n\n重复验证：${runs.second}\n\n优先打开首轮 previews/character-side-by-side.png，左侧原角色、右侧换色角色。\n\n本次自动测试不替代用户人工验收，不涉及 UI、组件替换、Live2D 导出或 MOC3 生成。\n`);
  console.log(JSON.stringify(report, null, 2)); if (!passed) process.exitCode = 1;
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
