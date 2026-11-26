import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {readFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import type {IncomingMessage} from 'node:http';
import {startServer as startTrackingServer,moduleRoot as trackingRoot} from '../../vtuber-camera-tracking/src/server.ts';
import type {LocalPageExtension,LocalSend} from '../../vtuber-camera-tracking/src/server.ts';
import {moduleRoot as previewRoot} from '../../vtuber-local-preview/src/server.ts';
import {requestTrackingPage} from '../../vtuber-camera-tracking/src/browser-launch.ts';
import {OutputState,OutputError} from './state.ts';
import {MODEL_ID,STALE_MS} from '../web/protocol.js';

export const moduleRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const OUTPUT_PORT=43127;
function exactObject(value: unknown, keys: string[]): asserts value is Record<string,any> {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))
    throw Object.assign(new Error('请求字段不符合本轮输出协议，不允许画面或额外字段。'),{status:400,code:'OUTPUT_BODY_INVALID'});
}
async function readBody(req: IncomingMessage) {
  if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']??''))throw Object.assign(new Error('输出请求必须使用 JSON。'),{status:415,code:'OUTPUT_JSON_REQUIRED'});
  if(Number(req.headers['content-length'])>4096){req.resume();throw Object.assign(new Error('输出请求过大；本轮只接受六个参数，不接受图像。'),{status:413,code:'OUTPUT_BODY_TOO_LARGE'});}
  let size=0;const chunks:Buffer[]=[];
  for await(const chunk of req){size+=chunk.length;if(size>4096)throw Object.assign(new Error('输出请求过大；本轮只接受六个参数，不接受图像。'),{status:413,code:'OUTPUT_BODY_TOO_LARGE'});chunks.push(chunk);}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
  catch{throw Object.assign(new Error('输出请求不是有效 JSON。'),{status:400,code:'OUTPUT_JSON_INVALID'});}
}

export async function startServer(options:{verification?:boolean;settingsDirectory?:string;port?:number}={}) {
  const state=new OutputState(),token=randomBytes(24).toString('hex');
  let runtime:Awaited<ReturnType<typeof startTrackingServer>>|undefined;
  const assets=new Map([
    ['/obs/output.css','output.css'],['/obs/controller.css','controller.css'],
    ['/obs/controller.js','controller.js'],['/obs/controller-client.js','controller-client.js'],
    ['/obs/output-page.js','output-page.js'],['/obs/protocol.js','protocol.js'],
  ]);
  const extension:LocalPageExtension={
    async handle(req,route,send){
      if(!route.startsWith('/obs/')&&!route.startsWith('/api/output/'))return false;
      const respond:LocalSend=(status,body,type='application/json')=>send(status,body,type,true);
      try {
        if(req.method==='GET'){
          if(route==='/obs/output'){
            respond(200,await readFile(path.join(moduleRoot,'web/output.html')),'text/html; charset=utf-8');return true;
          }
          const asset=assets.get(route);
          if(asset){respond(200,await readFile(path.join(moduleRoot,'web',asset)),asset.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8');return true;}
          if(route==='/obs/contracts.js'){
            respond(200,await readFile(path.join(previewRoot,'web/contracts.js')),'text/javascript; charset=utf-8');return true;
          }
          if(route==='/obs/renderer.js'){
            let renderer=await readFile(path.join(previewRoot,'web/app.js'),'utf8');
            const marker="fetch('/api/config', { cache: 'no-store' })";
            if(renderer.split(marker).length!==2)throw new Error('RENDERER_ADAPTER_MISMATCH: 冻结渲染器入口不符合预期。');
            renderer=renderer.replace(marker,"fetch('/api/output/config', { cache: 'no-store' })");
            renderer+='\n'+await readFile(path.join(trackingRoot,'web/preview-bridge.js'),'utf8');
            respond(200,renderer,'text/javascript; charset=utf-8');return true;
          }
          if(route==='/api/output/state'){respond(200,JSON.stringify(state.read()));return true;}
          if(route==='/api/output/controller'||route==='/api/output/config'){
            if(!runtime)throw Object.assign(new Error('输出服务尚未就绪。'),{status:503,code:'OUTPUT_NOT_READY'});
            const model=runtime.models.get(MODEL_ID);
            if(!model)throw new Error('OUTPUT_MODEL_MISSING: 缺少已验收金色模型。');
            const config=route==='/api/output/controller'
              ?{token,modelId:MODEL_ID,modelName:model.name,modelPath:model.path,outputUrl:`${runtime.url}/obs/output`,staleMs:STALE_MS}
              :{presets:[{id:MODEL_ID,label:'金色 · 本轮唯一输出模板',name:model.name,path:model.path}],sdkVersion:runtime.sdk.sdkVersion,sdkRoot:runtime.sdk.root,verification:false};
            respond(200,JSON.stringify(config));return true;
          }
          respond(404,'{"error":"输出地址不存在。","code":"OUTPUT_NOT_FOUND"}');return true;
        }
        if(!['/api/output/start','/api/output/frame','/api/output/stop'].includes(route)){
          respond(405,'{"error":"这是只读输出地址。","code":"OUTPUT_READ_ONLY"}');return true;
        }
        if(req.method!=='POST'){respond(405,'{"error":"输出控制只接受显式 POST。","code":"OUTPUT_METHOD_INVALID"}');return true;}
        if(req.headers.origin!==`http://${req.headers.host}`||req.headers['x-output-token']!==token){
          respond(403,'{"error":"输出控制来源校验失败，请从本机控制页操作。","code":"OUTPUT_ORIGIN_DENIED"}');return true;
        }
        const body=await readBody(req);
        if(route==='/api/output/frame'){
          exactObject(body,['clientId','sequence','modelId','values']);state.publish(body as any);
        } else {
          exactObject(body,['clientId']);
          if(route==='/api/output/start')state.start(body.clientId);else state.stop(body.clientId);
        }
        respond(200,JSON.stringify(state.read()));return true;
      } catch(error){
        const problem=error as Error&{status?:number;code?:string};
        respond(error instanceof OutputError?error.status:problem.status??400,JSON.stringify({error:problem.message,code:problem.code??'OUTPUT_ERROR'}));
        return true;
      }
    },
    transformAsset(file,body){
      if(file==='index.html')return body.replace(/<title>[^<]*<\/title>/,'<title>Live2D 纯净角色输出技术验证 v0.1</title>').replace('</head>','<link rel="stylesheet" href="/obs/controller.css"><script type="module" src="/obs/controller.js"></script></head>');
      if(file==='app.js')return body+'\nexport const outputModelIdentity = () => active && !busy && !dead ? {name:active.name,source:active.source} : null;\n';
      return body;
    },
  };
  const app=await startTrackingServer({...options,port:options.port===undefined?OUTPUT_PORT:options.port,extension});runtime=app;
  return {...app,state,outputUrl:app.url+'/obs/output'};
}

export function outputStartupMessage(error:unknown):string {
  const problem=error as NodeJS.ErrnoException;
  if(problem?.code==='EADDRINUSE')return '固定端口 '+OUTPUT_PORT+' 已被占用，输出程序未启动。可能已打开本项目，请检查已有服务窗口；确认后由你手动关闭并重试。不会改用其他端口、结束其他进程或打开占用者网页。';
  if(problem?.code==='EACCES'||problem?.code==='EPERM')return '无法监听本机固定端口 '+OUTPUT_PORT+'，输出程序未启动。请检查端口访问限制；不会改用其他地址或端口。';
  return error instanceof Error?error.message:String(error);
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try {
    if(process.argv.slice(2).some(arg=>arg!=='--open'))throw new Error('只支持 --open 参数。');
    const app=await startServer();
    console.log(`纯净角色输出技术验证 v0.1\n控制页：${app.url}\nOBS 浏览器源：${app.outputUrl}\n本轮仅金色模型，1280×720 / OBS 设置 30 FPS。\n先点击控制页“开始输出”；摄像头仍需你单独开启。切到后台会停止输出和摄像头。\n不录制、不推流、不上传画面。保留此窗口，Ctrl+C 停服务；OBS 固定地址可复用。首次从旧随机地址迁移需更新一次；重启后刷新控制页并手动开始，OBS 如未恢复请手动刷新浏览器源。`);
    process.once('SIGINT',async()=>{await app.close();process.exit(0);});
    if(process.argv.includes('--open'))await requestTrackingPage(app.url);
  }catch(error){console.error('ERROR: '+outputStartupMessage(error));process.exitCode=1;}
}
