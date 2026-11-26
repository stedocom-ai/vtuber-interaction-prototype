import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFile, access } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolveSdk } from '../../vtuber-runtime-recolor/src/core-reader.ts';
import { inspectReferences } from '../../vtuber-runtime-recolor/src/references.ts';
import { safeFile } from '../../vtuber-controlled-recolor/src/files.ts';
import { modelReferences, validateMocHash } from '../web/contracts.js';
import { memorySdk } from './sdk-memory.ts';

export const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const workspace = path.resolve(moduleRoot, '../..');
export const defaultSdk = 'D:/live 2D/CubismSdkForWeb';
export const originalRoot = 'C:/Users/34154/Desktop/reference_model_handoff';
export const modelPresets = [
  ['gold', '金色 · GUI 人工样本', '../vtuber-runtime-recolor/runs/minimal_character_v1_gui_test/model/minimal_character_v1_gui_test.model3.json'],
  ['original', '原始 · 蓝色', originalRoot + '/runtime/minimal_character_v1.model3.json'],
  ['purple', '紫色 · 已验收', '../vtuber-runtime-recolor/runs/reference-v1-purple/model/minimal_character_v1_purple_test.model3.json'],
  ['red', '红色 · 已验收', '../vtuber-runtime-recolor/runs/minimal_character_v1_red_test/model/minimal_character_v1_red_test.model3.json'],
  ['green', '绿色 · 自动通过', '../vtuber-runtime-recolor/runs/minimal_character_v1_green_test/model/minimal_character_v1_green_test.model3.json'],
];
export const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export async function readModel(modelPath: string) {
  const bytes = await readFile(modelPath), json = JSON.parse(bytes.toString('utf8'));
  const refs = modelReferences(json);
  const checked = await inspectReferences(modelPath);
  const files: Record<string, Buffer> = { [path.basename(modelPath)]: bytes };
  for (const ref of checked.records) {
    const data = await readFile(ref.path);
    if (data.length > 16 * 1024 * 1024 || hash(data) !== ref.sha256) throw new Error('MODEL_CHANGED_OR_TOO_LARGE');
    files[ref.relativePath] = data;
  }
  validateMocHash(hash(files[refs[0]]!));
  return { name: path.basename(modelPath), path: path.resolve(modelPath), json, files,
    hashes: Object.fromEntries(Object.entries(files).map(([key, data]) => [key, hash(data)])) };
}
export function allowedHost(host: string | undefined, port: number) { return host === `127.0.0.1:${port}`; }
export async function startServer(options: { port?: number; sdk?: string; verification?: boolean } = {}) {
  const sdk = await resolveSdk(options.sdk ?? defaultSdk, workspace), sdkMemory = memorySdk(sdk.root);
  if (sdk.sdkVersion !== '5-r.5') throw new Error('SDK_VERSION_UNVERIFIED: 本版验证的 SDK 为 5-r.5。');
  const token = randomBytes(24).toString('hex');
  const models = new Map<string, Awaited<ReturnType<typeof readModel>>>();
  const presets: { id: string; label: string; name: string; path: string }[] = [];
  for (const [id, label, relative] of modelPresets) {
    const model = await readModel(path.resolve(moduleRoot, relative));
    models.set(id, model); presets.push({ id, label, name: model.name, path: model.path });
  }
  const evidence: any[] = [], requests: { path: string; status: number }[] = [];
  const webFiles = new Set(['index.html', 'style.css', 'app.js', 'contracts.js', 'selftest.js']);
  let port = 0;
  const server = http.createServer(async (req, res) => {
    const rawPath = (req.url ?? '/').split('?')[0];
    const send = (status: number, body: string | Buffer, type = 'application/json') => {
      requests.push({ path: rawPath, status });
      res.writeHead(status, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
        'Permissions-Policy': 'camera=(), microphone=(), geolocation=()' }); res.end(body);
    };
    try {
      if (!allowedHost(req.headers.host, port)) return send(403, JSON.stringify({ error: 'HOST_DENIED' }));
      if (req.headers.origin && req.headers.origin !== `http://127.0.0.1:${port}`) return send(403, JSON.stringify({ error: 'ORIGIN_DENIED' }));
      if (rawPath === '/api/evidence' && req.method === 'POST' && options.verification) {
        if (req.headers['x-preview-token'] !== token) return send(403, '{}');
        const chunks: Buffer[] = []; let total = 0;
        for await (const chunk of req) { total += chunk.length; if (total > 4 * 1024 * 1024) throw new Error('BODY_TOO_LARGE'); chunks.push(chunk); }
        evidence.push(JSON.parse(Buffer.concat(chunks).toString())); return send(200, '{"ok":true}');
      }
      if (req.method !== 'GET') return send(405, '{"error":"READ_ONLY"}');
      if (rawPath === '/api/config') return send(200, JSON.stringify({ presets, sdkVersion: sdk.sdkVersion, sdkRoot: sdk.root,
        verification: !!options.verification, token: options.verification ? token : undefined }));
      if (rawPath.startsWith('/sdk/')) { const value = await sdkMemory.get(rawPath); return send(200, value.body, value.type); }
      if (rawPath.startsWith('/models/')) {
        const [, , id, ...rest] = rawPath.split('/');
        const name = decodeURIComponent(rest.join('/'));
        const model = models.get(id), data = model?.files[name];
        if (!model || !data || !Object.hasOwn(model.files, name)) return send(404, '{"error":"FILE_NOT_ALLOWED"}');
        return send(200, data, name.endsWith('.png') ? 'image/png' : name.endsWith('.json') ? 'application/json' : 'application/octet-stream');
      }
      const file = rawPath === '/' ? 'index.html' : rawPath.slice(1);
      if (!webFiles.has(file)) return send(404, '{"error":"NOT_FOUND"}');
      return send(200, await readFile(await safeFile(path.join(moduleRoot, 'web'), file)), file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : 'text/javascript');
    } catch (error) { send(400, JSON.stringify({ error: (error as Error).message })); }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 0, '127.0.0.1', resolve); });
  port = (server.address() as import('node:net').AddressInfo).port;
  return { server, port, url: `http://127.0.0.1:${port}`, sdk, sdkMemory, models, evidence, requests,
    close: () => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(e => e ? reject(e) : resolve()); }) };
}
export async function openBrowser(url: string) {
  const candidates = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'];
  for (const exe of candidates) {
    try { await access(exe); } catch { continue; }
    const child = spawn(exe, [`--app=${url}`, '--new-window', '--window-size=1180,880'], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', error => console.error('浏览器启动失败，请手动打开本地地址：', error.message)); child.unref(); return exe;
  }
  throw new Error('BROWSER_MISSING: 没有找到 Chrome 或 Edge，请手动用浏览器打开本地地址。');
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.some(x => !['--open'].includes(x))) throw new Error('ARGUMENT_INVALID: 支持的参数：--open');
    const app = await startServer();
    console.log(`本地 Live2D 轻量预览器 v0.1\n${app.url}\nSDK ${app.sdk.sdkVersion}（外部只读）\n请保留此窗口；按 Ctrl+C 关闭本地服务。`);
    if (args.includes('--open')) await openBrowser(app.url);
    process.once('SIGINT', async () => { await app.close(); process.exit(0); });
  } catch (error) { console.error('ERROR: ' + (error as Error).message); process.exitCode = 1; }
}
