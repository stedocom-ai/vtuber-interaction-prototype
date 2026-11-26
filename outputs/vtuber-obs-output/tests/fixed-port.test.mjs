import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {access,mkdir,mkdtemp} from 'node:fs/promises';
import {startServer,moduleRoot,OUTPUT_PORT} from '../src/server.ts';
import {startServer as startTrackingServer} from '../../vtuber-camera-tracking/src/server.ts';
import {startServer as startPreviewServer} from '../../vtuber-local-preview/src/server.ts';
import {DEFAULT_POSE} from '../web/protocol.js';

const clientId='fixed-port-session';
const json=async(url)=>{
  const response=await fetch(url);assert.equal(response.status,200);return response.json();
};
const post=(app,route,body,token,headers={})=>fetch(app.url+route,{
  method:'POST',headers:{Origin:app.url,'Content-Type':'application/json','X-Output-Token':token,...headers},body:JSON.stringify(body),
});
function statusWithHost(url,host){
  return new Promise((resolve,reject)=>{
    const request=http.get(url,{headers:{Host:host}},response=>{
      response.resume();response.once('end',()=>resolve(response.statusCode));
    });
    request.once('error',reject);request.setTimeout(5000,()=>request.destroy(new Error('本机安全检查请求超时。')));
  });
}

test('output fixed address preserves local security and starts a new session after restart',async(t)=>{
  await mkdir(path.join(moduleRoot,'verification'),{recursive:true});
  const run=await mkdtemp(path.join(moduleRoot,'verification/fixed-port-'));
  const settingsDirectory=path.join(run,'isolated-settings');
  const options={verification:true,settingsDirectory};
  let app,firstController,firstTracking;
  try{
    await t.test('optional port rejects noninteger, out-of-range and nonnumeric values before listening',async()=>{
      for(const port of [-1,65536,1.5,NaN,Infinity,'43127',null]){
        await assert.rejects(startTrackingServer({...options,port}),/PORT_INVALID/);
        await assert.rejects(startServer({...options,port}),/PORT_INVALID/);
      }
    });
    app=await startServer(options);
    firstController=await json(app.url+'/api/output/controller');
    firstTracking=await json(app.url+'/api/config');
    const originalUrl=app.url,originalOutputUrl=app.outputUrl;

    await t.test('output defaults to one fixed IPv4 loopback port and the existing read-only path',async()=>{
      assert.equal(app.port,OUTPUT_PORT);assert.equal(OUTPUT_PORT,43127);
      assert.equal(app.server.address().address,'127.0.0.1');
      assert.equal(app.url,'http://127.0.0.1:'+OUTPUT_PORT);
      assert.equal(app.outputUrl,app.url+'/obs/output');assert.equal(firstController.outputUrl,app.outputUrl);
      const outputUrl=new URL(app.outputUrl);assert.equal(outputUrl.search,'');assert.equal(outputUrl.hash,'');
      const state=await json(app.url+'/api/output/state');
      assert.equal(state.active,false);assert.equal(state.revision,0);assert.deepEqual(state.values,DEFAULT_POSE);
    });

    await t.test('unchanged preview and tracking entry defaults use ephemeral loopback ports while output port is occupied',async()=>{
      let preview,tracking;
      try{
        preview=await startPreviewServer();tracking=await startTrackingServer(options);
        for(const legacy of [preview,tracking]){
          assert.ok(legacy.port>0);assert.notEqual(legacy.port,OUTPUT_PORT);
          assert.equal(legacy.server.address().address,'127.0.0.1');
          assert.equal((await fetch(legacy.url+'/api/config')).status,200);
        }
        assert.notEqual(preview.port,tracking.port);
      }finally{await tracking?.close();await preview?.close();}
    });

    await t.test('duplicate start rejects EADDRINUSE without moving the port or interrupting the existing publisher',async()=>{
      assert.equal((await post(app,'/api/output/start',{clientId},firstController.token)).status,200);
      const values={...DEFAULT_POSE,ParamAngleX:11,ParamMouthOpenY:.4};
      let sequence=0,keepAlive=true,heartbeatError;
      const publish=async()=>assert.equal((await post(app,'/api/output/frame',{clientId,sequence:sequence++,modelId:'gold',values},firstController.token)).status,200);
      await publish();
      // Keep the existing lease alive during the other server's read-only asset initialization.
      // Each POST finishes before the next sequence is allocated; no overlapping publishers.
      const heartbeat=(async()=>{
        try{
          while(keepAlive){
            await new Promise(resolve=>setTimeout(resolve,100));
            if(keepAlive)await publish();
          }
        }catch(error){heartbeatError=error;}
      })();
      try{await assert.rejects(startServer(options),{code:'EADDRINUSE'});}
      finally{keepAlive=false;await heartbeat;}
      if(heartbeatError)throw heartbeatError;
      assert.equal(app.url,originalUrl);assert.equal(app.server.listening,true);
      await publish();
      const state=await json(app.url+'/api/output/state');assert.equal(state.active,true);assert.deepEqual(state.values,values);
      assert.ok((await json(app.url+'/api/output/controller')).token===firstController.token);
    });

    await t.test('normal close permits the exact same address and regenerates both tokens without restoring output or lease',async()=>{
      await app.close();app=undefined;
      app=await startServer(options);
      assert.equal(app.url,originalUrl);assert.equal(app.outputUrl,originalOutputUrl);
      const controller=await json(app.url+'/api/output/controller'),tracking=await json(app.url+'/api/config');
      assert.ok(controller.token!==firstController.token);assert.ok(tracking.settingsToken!==firstTracking.settingsToken);
      const state=await json(app.url+'/api/output/state');
      assert.equal(state.active,false);assert.equal(state.stale,false);assert.equal(state.revision,0);assert.deepEqual(state.values,DEFAULT_POSE);
      const frame={clientId,sequence:2,modelId:'gold',values:{...DEFAULT_POSE,ParamAngleX:21}};
      for(const [route,body] of [['/api/output/start',{clientId}],['/api/output/frame',frame],['/api/output/stop',{clientId}]]){
        assert.equal((await post(app,route,body,firstController.token)).status,403);
      }
      const staleLease=await post(app,'/api/output/frame',frame,controller.token);
      assert.equal(staleLease.status,409);assert.equal((await staleLease.json()).code,'OUTPUT_NOT_ACTIVE');
      const settingsResponse=await fetch(app.url+'/api/settings',{method:'POST',headers:{Origin:app.url,'Content-Type':'application/json','X-Settings-Token':firstTracking.settingsToken},body:'{}'});
      assert.equal(settingsResponse.status,403);
      const after=await json(app.url+'/api/output/state');assert.equal(after.active,false);assert.equal(after.revision,0);assert.deepEqual(after.values,DEFAULT_POSE);
    });

    await t.test('fixed address retains exact Host, same-Origin and dedicated-token requirements',async()=>{
      const controller=await json(app.url+'/api/output/controller');
      for(const host of ['localhost:'+app.port,'127.0.0.1:'+(app.port+1),'outside.invalid']){
        assert.equal(await statusWithHost(app.url+'/api/output/state',host),403);
      }
      assert.equal((await fetch(app.url+'/api/output/state',{headers:{Origin:'https://outside.invalid'}})).status,403);
      assert.equal((await post(app,'/api/output/start',{clientId},'wrong')).status,403);
      assert.equal((await post(app,'/api/output/start',{clientId},controller.token,{Origin:'http://localhost:'+app.port})).status,403);
      assert.equal((await fetch(app.url+'/api/output/start',{method:'POST',headers:{'Content-Type':'application/json','X-Output-Token':controller.token},body:JSON.stringify({clientId})})).status,403);
      assert.equal((await post(app,'/api/output/start',{clientId},controller.token)).status,200);
      assert.equal((await post(app,'/api/output/stop',{clientId},controller.token)).status,200);
      const config=await json(app.url+'/api/output/config');assert.ok(!('token'in config));assert.ok(!('settingsToken'in config));
    });

    await t.test('restart and settings reads do not create persistent session or personal-settings files',async()=>{
      assert.equal((await fetch(app.url+'/api/settings')).status,200);
      await assert.rejects(access(settingsDirectory),{code:'ENOENT'});
    });
  }finally{await app?.close();}
});
