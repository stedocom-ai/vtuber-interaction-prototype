import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFile, realpath } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { moduleRoot as previewRoot, workspace, defaultSdk, modelPresets, readModel, allowedHost, hash } from '../../vtuber-local-preview/src/server.ts';
import { memorySdk } from '../../vtuber-local-preview/src/sdk-memory.ts';
import { resolveSdk } from '../../vtuber-runtime-recolor/src/core-reader.ts';
import { SettingsStore, SettingsError } from './settings-store.ts';
import { requestTrackingPage } from './browser-launch.ts';

export const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export type LocalSend = (status: number, body: string | Buffer, type?: string, disableMedia?: boolean) => void;
export interface LocalPageExtension {
  handle(req: http.IncomingMessage, route: string, send: LocalSend): Promise<boolean>;
  transformAsset(file: string, body: string): string;
}
export async function startServer(options: {verification?: boolean;settingsDirectory?:string;extension?:LocalPageExtension;port?:number} = {}) {
  const requestedPort=options.port===undefined?0:options.port;
  if(!Number.isInteger(requestedPort)||requestedPort<0||requestedPort>65535)throw new Error('PORT_INVALID: 监听端口必须是 0 至 65535 的整数。');
  if(options.verification&&!options.settingsDirectory)throw new Error('VERIFICATION_REQUIRES_ISOLATED_SETTINGS_DIRECTORY');
  const settingsStore=new SettingsStore(options.settingsDirectory??path.join(moduleRoot,'user-data'));
  // Fail closed if the accepted renderer integration contract changes.
  const frozen = JSON.parse(await readFile(path.join(previewRoot, 'releases/local-preview-v0.1/implementation-fingerprints.json'), 'utf8'));
  for (const f of frozen) if (hash(await readFile(path.resolve(workspace, f.path))) !== f.sha256) throw new Error('PREVIEW_BASELINE_CHANGED: 已验收预览器实现有变化，请先复核。');
  const sdk = await resolveSdk(defaultSdk, workspace);
  if (sdk.sdkVersion !== '5-r.5') throw new Error('SDK_VERSION_UNVERIFIED');
  const sdkMemory = memorySdk(sdk.root);
  const vendor = await realpath(path.join(moduleRoot, 'node_modules/@mediapipe/tasks-vision'));
  const lock = JSON.parse(await readFile(path.join(moduleRoot, 'models/model-lock.json'), 'utf8'));
  const faceModel = await readFile(path.join(moduleRoot, 'models/face_landmarker.task'));
  if (hash(faceModel) !== lock.sha256) throw new Error('TRACKING_MODEL_CHANGED: 本地追踪模型校验失败。');
  const pkg = JSON.parse(await readFile(path.join(vendor, 'package.json'), 'utf8'));
  if (pkg.version !== '0.10.35') throw new Error('TRACKER_VERSION_CHANGED');
  const models = new Map(), presets: any[] = [];
  for (const [id, label, relative] of modelPresets) {
    const model = await readModel(path.resolve(previewRoot, relative)); models.set(id, model);
    presets.push({id, label, name: model.name, path: model.path});
  }
  const token = randomBytes(24).toString('hex'), evidence: any[] = [], requests: any[] = [];
  const localFiles = new Set(['tracking-app.js','tracking.css','tracker-worker.js','mapping.js','session.js','worker-client.js','tracking-selftest.js','settings-schema.js','settings-client.js']);
  const vendorFiles = new Set(['vision_bundle.cjs', 'wasm/vision_wasm_internal.js','wasm/vision_wasm_internal.wasm','wasm/vision_wasm_nosimd_internal.js','wasm/vision_wasm_nosimd_internal.wasm','wasm/vision_wasm_module_internal.js','wasm/vision_wasm_module_internal.wasm']);
  let port = 0;
  const server = http.createServer(async (req, res) => {
    const raw = (req.url ?? '/').split('?')[0];
    const send: LocalSend = (status, body, type = 'application/json', disableMedia = false) => {
      requests.push({path: raw, status}); if (requests.length > 5000) requests.shift();
      res.writeHead(status, {'Content-Type': type, 'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
        'Referrer-Policy':'no-referrer', 'Permissions-Policy':disableMedia?'camera=(), microphone=(), geolocation=()':'camera=(self), microphone=(), geolocation=()',
        'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self'; img-src 'self' blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"}); res.end(body);
    };
    try {
      if (!allowedHost(req.headers.host, port) || (req.headers.origin && req.headers.origin !== `http://127.0.0.1:${port}`)) return send(403, '{"error":"ORIGIN_DENIED"}');
      if (options.extension && await options.extension.handle(req, raw, send)) return;
      if(raw==='/api/settings'){
        if(req.method==='GET')return send(200,JSON.stringify(await settingsStore.load()));
        if(req.method!=='POST')return send(405,'{"error":"设置仅支持读取或显式保存。"}');
        if(req.headers.origin!==`http://127.0.0.1:${port}`||req.headers['x-settings-token']!==token)return send(403,'{"error":"设置保存来源校验失败，请从本机页面操作。"}');
        if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']??''))return send(415,'{"error":"设置请求必须使用 JSON。"}');
        let size=0;const chunks:Buffer[]=[];
        for await(const chunk of req){size+=chunk.length;if(size>4096)throw new SettingsError('设置请求过大。',413);chunks.push(chunk);}
        let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new SettingsError('设置请求不是有效 JSON。');}
        if(!body||Object.keys(body).length!==2||!Object.hasOwn(body,'settings')||!Object.hasOwn(body,'revision'))throw new SettingsError('设置请求只能包含设置与版本。');
        try{return send(200,JSON.stringify(await settingsStore.save(body.settings,body.revision)));}
        catch(e){if((e as NodeJS.ErrnoException).code)throw new SettingsError('设置无法写入，请检查文件占用或目录权限。原配置未主动截断，请重新读取确认。',500);throw e;}
      }
      if (raw === '/api/evidence' && req.method === 'POST' && options.verification) {
        if (req.headers['x-preview-token'] !== token) return send(403, '{}');
        const chunks: Buffer[] = []; let n = 0;
        for await (const c of req) { n += c.length; if (n > 1024*1024) throw new Error('BODY_TOO_LARGE'); chunks.push(c); }
        evidence.push(JSON.parse(Buffer.concat(chunks).toString())); return send(200,'{"ok":true}');
      }
      if (req.method !== 'GET') return send(405,'{"error":"READ_ONLY"}');
      if (raw === '/api/config') return send(200,JSON.stringify({presets, sdkVersion:sdk.sdkVersion, sdkRoot:sdk.root, verification:false, trackingVerification:!!options.verification, token:options.verification ? token : undefined, settingsToken:token,trackerVersion:pkg.version, modelSha256:lock.sha256}));
      if (raw.startsWith('/sdk/')) { const asset = await sdkMemory.get(raw); return send(200,asset.body,asset.type); }
      if (raw.startsWith('/models/')) {
        const [,,id,...parts] = raw.split('/'), name = decodeURIComponent(parts.join('/'));
        const model = models.get(id);
        if (!model || !Object.hasOwn(model.files,name)) return send(404,'{}');
        return send(200,model.files[name],name.endsWith('.png')?'image/png':name.endsWith('.json')?'application/json':'application/octet-stream');
      }
      if (raw === '/tracker-model/face_landmarker.task') return send(200,faceModel,'application/octet-stream');
      if (raw.startsWith('/vendor/')) {
        const file = raw.slice(8); if (!vendorFiles.has(file)) return send(404,'{}');
        return send(200,await readFile(path.join(vendor,file)),file.endsWith('.wasm')?'application/wasm':'text/javascript');
      }
      const file = raw === '/' ? 'index.html' : raw.slice(1);
      if (file === 'tracking-selftest.js' && !options.verification) return send(404,'{}');
      if (localFiles.has(file)) return send(200,await readFile(path.join(moduleRoot,'web',file)),file.endsWith('.css')?'text/css':'text/javascript');
      if (!['index.html','app.js','contracts.js','style.css'].includes(file)) return send(404,'{}');
      let body = await readFile(path.join(previewRoot,'web',file),'utf8');
      if (file === 'index.html') body = body.replace('本地 Live2D 轻量预览器 v0.1','本地摄像头追踪技术验证 v0.1').replace('Live2D 轻量预览器 <small>','Live2D 本地追踪 <small>').replace('直接驱动模型原有参数；没有摄像头追踪或自动眨眼。','摄像头关闭时可手动调节；追踪开启时由人脸动作驱动。').replace('</head>','<link rel="stylesheet" href="/tracking.css"><script type="module" src="/tracking-app.js"></script></head>');
      if (file === 'app.js') body += '\n' + await readFile(path.join(moduleRoot,'web/preview-bridge.js'),'utf8');
      if (file === 'index.html') body=body.replaceAll('技术验证 v0.1','设置保存与恢复 v0.1（追踪 v0.1.5）').replace('所有修改只发生在运行内存中','模型只读 / 追踪偏好仅在点击保存时写入本机');
      if (options.extension) body = options.extension.transformAsset(file, body);
      return send(200,body,file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.css')?'text/css':'text/javascript');
    } catch (e) { send(e instanceof SettingsError?e.status:400,JSON.stringify({error:(e as Error).message})); }
  });
  await new Promise<void>((resolve,reject) => {server.once('error',reject);server.listen(requestedPort,'127.0.0.1',resolve);});
  port = (server.address() as import('node:net').AddressInfo).port;
  return {server,port,url:`http://127.0.0.1:${port}`,sdk,sdkMemory,models,evidence,requests,
    close:()=>new Promise<void>((resolve,reject)=>{server.closeAllConnections();server.close(e=>e?reject(e):resolve());})};
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.slice(2).some(x=>x!=='--open')) throw new Error('只支持 --open 参数');
    const app = await startServer(); console.log(`本地摄像头追踪 v0.1.5 / 设置保存与恢复 v0.1\n${app.url}\n摄像头默认关闭；所有处理在本机。保留此窗口，Ctrl+C 停止服务；Edge 页面由你正常关闭。`);
    process.once('SIGINT',async()=>{await app.close();process.exit(0);});
    if (process.argv.includes('--open')) await requestTrackingPage(app.url);
  } catch(e) {console.error('ERROR: '+(e as Error).message);process.exitCode=1;}
}
