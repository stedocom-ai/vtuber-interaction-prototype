import path from 'node:path';
import { readdir, lstat, realpath } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { sha256 } from '../../vtuber-controlled-recolor/src/pixels.ts';
import { within } from '../../vtuber-controlled-recolor/src/files.ts';
import type { Fingerprint } from '../../vtuber-controlled-recolor/src/files.ts';

const git = 'C:/Users/34154/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/git/cmd/git.exe';
export async function auditSdkIsolation(workspace: string, moduleRoot: string, sdkRoot: string, sdkFiles: Fingerprint[]) {
  if (within(workspace, sdkRoot) || within(sdkRoot, workspace)) throw new Error('SDK_MUST_BE_EXTERNAL');
  const repositories: string[] = [], copiedSdkFiles: string[] = [], sdkLinks: string[] = [];
  const bySize = new Map<number, Set<string>>();
  for (const f of sdkFiles) if (f.bytes > 0) { const set = bySize.get(f.bytes) ?? new Set<string>(); set.add(f.sha256); bySize.set(f.bytes, set); }
  async function scan(dir: string) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, e.name), info = await lstat(file);
      if (e.name === '.git') { repositories.push(dir); continue; }
      if (info.isSymbolicLink()) {
        const target = await realpath(file);
        if (within(sdkRoot, target)) sdkLinks.push(file);
        continue;
      }
      if (e.isDirectory()) { if (!['node_modules', '.pnpm-store'].includes(e.name)) await scan(file); continue; }
      if (!e.isFile()) continue;
      if (/^live2dcubismcore\.(?:js|js\.map|d\.ts|wasm|dll|lib)$/i.test(e.name) || bySize.get(info.size)?.has(sha256(await readFile(file)))) copiedSdkFiles.push(file);
    }
  }
  await scan(workspace);
  const gitChecks = [];
  for (const root of repositories) {
    const result = spawnSync(git, ['-c', `safe.directory=${root.replaceAll('\\', '/')}`, '-C', root, 'ls-files', '--stage'], { encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
    if (result.status !== 0) throw new Error('GIT_AUDIT_FAILED: ' + result.stderr);
    const sdkTracked = result.stdout.split('\n').filter(line => /\t.*(?:CubismSdkForWeb|live2dcubismcore)/i.test(line));
    if (within(root, sdkRoot) || sdkTracked.length) throw new Error('SDK_TRACKED_BY_GIT');
    gitChecks.push({ root, sdkOutsideWorkTree: true, trackedSdkFiles: sdkTracked, trackedEntryCount: result.stdout.trim().split('\n').filter(Boolean).length });
  }
  if (copiedSdkFiles.length || sdkLinks.length) throw new Error('SDK_COPY_OR_LINK_DETECTED: ' + [...copiedSdkFiles, ...sdkLinks].join(', '));
  const ignoreText = await readFile(path.join(moduleRoot, '.gitignore'), 'utf8');
  if (!ignoreText.includes('**/live2dcubismcore*') || !ignoreText.includes('CubismSdkForWeb*/')) throw new Error('SDK_IGNORE_RULES_MISSING');
  return { sdkOutsideWorkspace: true, copiedSdkFiles, sdkLinks, repositories: gitChecks,
    moduleIsGitRepository: repositories.some(r => path.resolve(r) === path.resolve(moduleRoot)), preventiveIgnoreRulesPresent: true,
    scanExclusions: ['node_modules', '.pnpm-store'], sdkBinaryWasCopied: false, sdkBinaryWasWritten: false };
}
