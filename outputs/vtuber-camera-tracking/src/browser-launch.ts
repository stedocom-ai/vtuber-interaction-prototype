import path from 'node:path';
import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

type BrowserChild = Pick<ChildProcess, 'once' | 'unref'>;
type SpawnBrowser = (exe: string, args: string[], options: {
  detached: true; stdio: 'ignore'; windowsHide: false; shell: false;
}) => BrowserChild;
export interface BrowserDependencies {
  env?: NodeJS.ProcessEnv;
  access?: (file: string) => Promise<unknown>;
  spawn?: SpawnBrowser;
  log?: (message: string) => void;
}

export function edgeCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const roots = [env.ProgramW6432, env.ProgramFiles, env['ProgramFiles(x86)'],
    'C:/Program Files', 'C:/Program Files (x86)', env.LOCALAPPDATA];
  const seen = new Set<string>();
  return roots.filter((root): root is string => !!root).map(root =>
    path.win32.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
  ).filter(file => {
    const key = file.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

function localPage(url: string): string {
  // Validate the original spelling, not URL normalization of other IPv4 forms.
  const match = typeof url === 'string' && /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/?$/.exec(url);
  if (!match || match[0] !== url || Number(match[1]) > 65535) throw new Error('BROWSER_URL_INVALID: 只允许本机 127.0.0.1 和有效端口的根页面。');
  return url;
}

export async function openTrackingBrowser(url: string, dependencies: BrowserDependencies = {}): Promise<string> {
  const target = localPage(url), canAccess = dependencies.access ?? access;
  let executable: string | undefined;
  for (const candidate of edgeCandidates(dependencies.env)) {
    try { await canAccess(candidate); executable = candidate; break; } catch { /* Try only other Edge locations. */ }
  }
  if (!executable) throw new Error('EDGE_UNAVAILABLE: 未能找到或访问 Microsoft Edge。不会改用 Chrome。');
  const create: SpawnBrowser = dependencies.spawn ?? spawn;
  const selected = executable;
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      reject(new Error('EDGE_LAUNCH_FAILED: 无法请求 Edge 打开页面：' + (error instanceof Error ? error.message : String(error))));
    };
    const timer = setTimeout(() => fail(new Error('等待浏览器启动超过 5 秒，请手动打开本地地址。')), 5000);
    try {
      const child = create(selected, ['--new-window', target], {
        detached: true, stdio: 'ignore', windowsHide: false, shell: false,
      });
      // Keep an error handler even after spawn; never terminate a shared browser.
      child.once('error', fail);
      child.once('spawn', () => {
        if (settled) return;
        try { child.unref(); } catch (error) { fail(error); return; }
        settled = true; clearTimeout(timer); resolve(selected);
      });
    } catch (error) { fail(error); }
  });
}

export async function requestTrackingPage(url: string, dependencies: BrowserDependencies = {}): Promise<boolean> {
  const log = dependencies.log ?? console.log;
  try {
    await openTrackingBrowser(url, dependencies);
    log('已请求 Microsoft Edge 普通窗口打开角色页面（不是 Chrome 应用窗口）。\n若未显示，请手动打开：' + url);
    return true;
  } catch (error) {
    log('自动打开浏览器未成功：' + (error instanceof Error ? error.message : String(error)) +
      '\n本地服务继续运行。请用 Edge 普通标签页手动打开：' + url + '\n不会自动重试、启动 Chrome 或结束任何浏览器进程。');
    return false;
  }
}
