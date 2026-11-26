import path from 'node:path';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { startServer, moduleRoot, workspace, originalRoot, defaultSdk } from '../src/server.ts';
import { snapshot } from '../../vtuber-controlled-recolor/src/files.ts';
import { resolveSdk } from '../../vtuber-runtime-recolor/src/core-reader.ts';
import { auditSdkIsolation } from '../../vtuber-runtime-recolor/src/sdk-audit.ts';

const base = path.join(moduleRoot, 'verification'); await mkdir(base, { recursive: true });
const run = await mkdtemp(path.join(base, new Date().toISOString().replace(/[:.]/g, '-') + '_'));
const save = (name: string, value: unknown) => writeFile(path.join(run, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const protectedRoots = [originalRoot, path.resolve(moduleRoot, '../vtuber-runtime-recolor/runs'),
  path.resolve(moduleRoot, '../vtuber-runtime-recolor/releases'), path.resolve(moduleRoot, '../vtuber-recolor-gui/releases')];
console.log('VERIFICATION_DIRECTORY=' + run);
const sdk = await resolveSdk(defaultSdk, workspace);
const before = await snapshot(protectedRoots), sdkBefore = await snapshot([sdk.root]);
await save('protected-before.json', before); await save('sdk-before.json', sdkBefore);
const child = spawn(process.execPath, ['--test', '--test-reporter=tap', 'tests/contracts.test.ts'], { cwd: moduleRoot, windowsHide: true });
let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
const code = await new Promise<number | null>(resolve => child.on('close', resolve));
await writeFile(path.join(run, 'unit-tests.tap'), output, { flag: 'wx' });
console.log(output.slice(-800));
if (code !== 0) throw new Error('UNIT_TEST_FAILURE: ' + run);
const app = await startServer({ verification: true });
console.log('OPEN_BROWSER_URL=' + app.url);
await save('session.json', { url: app.url, run, sdkVersion: sdk.sdkVersion, mode: 'real-visible-browser-no-fake-time' });
let done: any, functionalSaved = false, evidenceCount = 0;
const deadline = Date.now() + 20 * 60 * 1000;
try {
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    for (const item of app.evidence.slice(evidenceCount)) {
      if (item.phase === 'functional' && !functionalSaved) {
        functionalSaved = true; await save('browser-functional.json', item);
        console.log('FUNCTIONAL=' + item.results.filter((r: any) => r.pass).length + '/' + item.results.length);
        if (item.results.some((r: any) => !r.pass)) { done = item; break; }
      }
      if (item.phase === 'heartbeat') console.log(`STABILITY=${Math.floor(item.elapsedMs/1000)}s frames=${item.frames}`);
      if (item.phase === 'complete') { done = item; break; }
    }
    evidenceCount = app.evidence.length; if (done) break;
  }
  if (!done) throw new Error('BROWSER_TEST_TIMEOUT: 浏览器未在 20 分钟内完成验证。');
  await save('browser-tests.json', done);
  const after = await snapshot(protectedRoots), sdkAfter = await snapshot([sdk.root]);
  await save('protected-after.json', after); await save('sdk-after.json', sdkAfter);
  const isolation = await auditSdkIsolation(workspace, moduleRoot, sdk.root, sdkBefore);
  await save('sdk-isolation.json', isolation);
  const comparisons = [
    { name: '原始资产、原模型、所有已生成模型及旧验收结果 SHA-256 不变', pass: JSON.stringify(before) === JSON.stringify(after), files: before.length },
    { name: 'SDK 全部文件 SHA-256 不变', pass: JSON.stringify(sdkBefore) === JSON.stringify(sdkAfter), files: sdkBefore.length },
    { name: 'SDK/Core 没有副本、链接或 Git 跟踪', pass: isolation.copiedSdkFiles.length === 0 && isolation.sdkLinks.length === 0 },
    { name: 'SDK 模块与 shader 请求成功（内存转换，无 SDK 构建产物）', pass: app.requests.filter(r => r.path.startsWith('/sdk/')).every(r => r.status === 200), memoryResponseCount: app.sdkMemory.cache.size },
  ];
  const unitPass = Number(/# pass (\d+)/.exec(output)?.[1] ?? 0);
  const allPass = done.phase === 'complete' && done.results.every((r: any) => r.pass) && comparisons.every(r => r.pass);
  const summary = { status: allPass ? 'AUTO_PASS_MANUAL_PENDING' : 'ERROR', run, url: app.url,
    unitPass, browserPass: done.results.filter((r: any) => r.pass).length, browserTotal: done.results.length,
    safetyPass: comparisons.filter(r => r.pass).length, safetyTotal: comparisons.length,
    totalPass: unitPass + done.results.filter((r: any) => r.pass).length + comparisons.filter(r => r.pass).length,
    comparisons, runtime: done.runtime, sdkVersion: sdk.sdkVersion, coreVersion: '6.0.1' };
  await save('summary.json', summary); await save('requests.json', app.requests);
  const lines = ['# 本地 Live2D 轻量预览器 v0.1 自动测试报告', '', `结论：${summary.status}。仅自动检查，不能替代用户人工验收。`, '',
    `单元/服务测试 ${unitPass} 项；浏览器 ${summary.browserPass}/${summary.browserTotal}；保护审计 ${summary.safetyPass}/${summary.safetyTotal}。合计通过 ${summary.totalPass} 项。`, '',
    '| 检查 | 结果 |', '|---|---|', ...done.results.map((r: any) => `| ${r.name} | ${r.pass ? 'PASS' : 'ERROR: ' + r.error} |`),
    ...comparisons.map(r => `| ${r.name} | ${r.pass ? 'PASS' : 'ERROR'} |`), '',
    done.runtime ? `真实连续渲染 ${(done.runtime.elapsedMs/1000).toFixed(2)} 秒，${done.runtime.frames} 帧；最长 RAF 间隔 ${done.runtime.maxGapMs.toFixed(2)} ms；隐藏时间 ${done.runtime.hiddenMs} ms；错误 ${done.runtime.errors.length}；上下文丢失 ${done.runtime.contextLosses}。` : '功能检查失败，没有完成连续测试。', '',
    '证据：unit-tests.tap、browser-tests.json、protected-before/after.json、sdk-before/after.json、sdk-isolation.json、requests.json。', '',
    'SDK 5-r.5 / Core 6.0.1 外部只读；官方 Framework TS 仅内存转换，Core 和 shaders 只读 no-store 响应。不包含性能承诺，也不证明摄像头或虚拟摄像头能力。'];
  await writeFile(path.join(run,'verification.md'), lines.join('\n')+'\n', { flag:'wx' });
  console.log('RESULT=' + JSON.stringify({ status: summary.status, totalPass: summary.totalPass, run }));
  if (!allPass) process.exitCode = 1;
} finally { await app.close(); }
