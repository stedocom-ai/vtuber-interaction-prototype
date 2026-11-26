import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,mkdtemp,readFile,writeFile,readdir,access,symlink,lstat} from 'node:fs/promises';
import {SETTINGS_DEFAULTS,validateSettings} from '../web/settings-schema.js';
import {SettingsClient} from '../web/settings-client.js';
import {SettingsStore} from '../src/settings-store.ts';
import {startServer,moduleRoot} from '../src/server.ts';
const base=path.join(moduleRoot,'verification');await mkdir(base,{recursive:true});
const root=await mkdtemp(path.join(base,'settings-unit-'));
let index=0;
const store=()=>new SettingsStore(path.join(root,'case-'+ ++index));
const preferred={...SETTINGS_DEFAULTS,eyeCloseThreshold:.4,reverseY:true,swapEyes:true};
test('schema defaults retain 0.30, enable mirrored X/Y and leave Z/eye swap off',()=>{assert.equal(SETTINGS_DEFAULTS.eyeCloseThreshold,.3);assert.equal(SETTINGS_DEFAULTS.reverseX,true);assert.equal(SETTINGS_DEFAULTS.reverseY,true);assert.equal(SETTINGS_DEFAULTS.reverseZ,false);assert.equal(SETTINGS_DEFAULTS.swapEyes,false);assert.deepEqual(validateSettings(SETTINGS_DEFAULTS),SETTINGS_DEFAULTS);});
for(const [name,value] of [
  ['unknown camera field',{...preferred,autoStartCamera:true}],['unknown face data',{...preferred,faceScores:[.8]}],['future version',{...preferred,schemaVersion:2}],['missing field',{schemaVersion:1}],['string switch',{...preferred,reverseX:'false'}],['string threshold',{...preferred,eyeCloseThreshold:'0.4'}],['low threshold',{...preferred,eyeCloseThreshold:.1}],['high threshold',{...preferred,eyeCloseThreshold:.9}],['NaN',{...preferred,eyeCloseThreshold:NaN}],['array',[]],['null',null]
])test('schema rejects '+name,()=>assert.throws(()=>validateSettings(value)));
test('missing configuration reads defaults without creating any file',async()=>{const s=store(),r=await s.load();assert.equal(r.source,'defaults');assert.equal(r.revision,'missing');await assert.rejects(access(s.directory),{code:'ENOENT'});});
test('explicit save stores only approved fields and survives new store instance',async()=>{const s=store();const a=await s.save(preferred,'missing');assert.equal(a.source,'saved');const b=await new SettingsStore(s.directory).load();assert.deepEqual(b.settings,preferred);assert.equal(a.revision,b.revision);assert.deepEqual(JSON.parse(await readFile(s.file,'utf8')),preferred);});
test('new Y default never migrates or overwrites existing false or other personal values',async()=>{
  const directory=path.join(root,'legacy-y-preference'),s=new SettingsStore(directory);
  const legacy={schemaVersion:1,eyeCloseThreshold:.49,reverseX:false,reverseY:false,reverseZ:true,swapEyes:true};
  await mkdir(directory);await writeFile(s.file,JSON.stringify(legacy)+'\n');const before=await readFile(s.file);
  const loaded=await new SettingsStore(directory).load();assert.equal(loaded.source,'saved');assert.deepEqual(loaded.settings,legacy);
  let applied;const client=new SettingsClient({token:'test',readControls:()=>legacy,applyControls:value=>applied=value,onState(){},request:async(_,options)=>{assert.equal(options.method,'GET');return{ok:true,json:async()=>loaded};}});
  await client.load();assert.deepEqual(applied,legacy);assert.deepEqual(await readFile(s.file),before);
});
test('reset saves defaults including new Y=true without retaining hidden preferences',async()=>{const s=store(),a=await s.save({...preferred,reverseY:false},'missing');await s.save(SETTINGS_DEFAULTS,a.revision);assert.deepEqual((await s.load()).settings,SETTINGS_DEFAULTS);});
for(const [name,content] of [['invalid JSON','{broken'],['unsupported version',JSON.stringify({...preferred,schemaVersion:99})],['out of range',JSON.stringify({...preferred,eyeCloseThreshold:5})]])test('bad configuration degrades safely and is backed up only on explicit save: '+name,async()=>{
  const s=store();await mkdir(s.directory);await writeFile(s.file,content);const r=await s.load();assert.equal(r.source,'invalid');assert.deepEqual(r.settings,SETTINGS_DEFAULTS);assert.equal(await readFile(s.file,'utf8'),content);assert.equal((await readdir(s.directory)).length,1);
  const saved=await s.save(preferred,r.revision);assert.equal(await readFile(saved.backupPath,'utf8'),content);assert.deepEqual((await s.load()).settings,preferred);
});
test('oversized configuration is preserved and saving with null revision is blocked',async()=>{const s=store();await mkdir(s.directory);await writeFile(s.file,'x'.repeat(9000));const r=await s.load();assert.equal(r.source,'unavailable');await assert.rejects(s.save(preferred,r.revision));assert.equal((await readFile(s.file)).length,9000);});
test('directory in place of file cannot be overwritten',async()=>{const s=store();await mkdir(s.file,{recursive:true});const r=await s.load();assert.equal(r.source,'unavailable');await assert.rejects(s.save(preferred,'missing'));});
test('junction settings directory is refused without touching target',async(t)=>{const s=store(),target=path.join(root,'junction-target');await mkdir(target);await writeFile(path.join(target,'tracking-settings.json'),'untouched');let check=s,before;try{await symlink(target,s.directory,'junction');}catch(error){if(error.code!=='EPERM'||!process.env.SETTINGS_JUNCTION_FIXTURE)throw error;const fixture=path.resolve(process.env.SETTINGS_JUNCTION_FIXTURE),relative=path.relative(base,fixture);assert.match(relative,/^settings-unit-[a-zA-Z0-9]+[\\/]case-9$/);assert.ok((await lstat(fixture)).isSymbolicLink());check=new SettingsStore(fixture);t.diagnostic('Current environment cannot create junctions; exercising existing verified junction read-only: '+fixture);}before=await readFile(check.file);assert.equal((await check.load()).source,'unavailable');await assert.rejects(check.save(preferred,'missing'));assert.deepEqual(await readFile(check.file),before);assert.equal(await readFile(path.join(target,'tracking-settings.json'),'utf8'),'untouched');});
test('stale window revision cannot overwrite newer settings',async()=>{const s=store(),a=await s.save(preferred,'missing');await assert.rejects(s.save(SETTINGS_DEFAULTS,'missing'),/另一个窗口/);assert.equal((await s.load()).revision,a.revision);});
test('external edit detected and preserved',async()=>{const s=store(),a=await s.save(preferred,'missing');await writeFile(s.file,JSON.stringify(SETTINGS_DEFAULTS));await assert.rejects(s.save(preferred,a.revision),/另一个窗口/);assert.deepEqual((await s.load()).settings,SETTINGS_DEFAULTS);});
test('only one concurrent writer succeeds and no temp/lock remains',async()=>{const s=store();const r=await Promise.allSettled([s.save(preferred,'missing'),s.save(SETTINGS_DEFAULTS,'missing')]);assert.equal(r.filter(x=>x.status==='fulfilled').length,1);assert.deepEqual(await readdir(s.directory),['tracking-settings.json']);});
test('existing write lock is not stolen or removed',async()=>{const s=store();await mkdir(s.directory);const lock=path.join(s.directory,'.settings-write.lock');await writeFile(lock,'other process');await assert.rejects(s.save(preferred,'missing'),/另一个窗口/);assert.equal(await readFile(lock,'utf8'),'other process');});
test('failed commit preserves old file and cleans own temporary files',async()=>{const s=store(),a=await s.save(preferred,'missing'),before=await readFile(s.file);const broken=new SettingsStore(s.directory,async()=>{throw new Error('simulated rename failure');});await assert.rejects(broken.save(SETTINGS_DEFAULTS,a.revision),/simulated/);assert.deepEqual(await readFile(s.file),before);assert.deepEqual(await readdir(s.directory),['tracking-settings.json']);});
test('invalid input cannot create an output directory',async()=>{const s=store();await assert.rejects(s.save({...preferred,autoStartCamera:true},'missing'));await assert.rejects(access(s.directory),{code:'ENOENT'});});
const mockResponse=(data,ok=true)=>({ok,json:async()=>data});
test('client loads options only and never initiates camera',async()=>{let applied;const c=new SettingsClient({token:'x',readControls:()=>preferred,applyControls:x=>applied=x,onState(){},request:async()=>mockResponse({settings:preferred,revision:'a'.repeat(64),source:'saved',message:'loaded'})});await c.load();assert.equal(c.ready,true);assert.deepEqual(applied,preferred);assert.equal(c.busy,false);});
test('client load failure falls back and allows retry',async()=>{let applied;const c=new SettingsClient({token:'x',readControls:()=>preferred,applyControls:x=>applied=x,onState(){},request:async()=>{throw new Error('network');}});await c.load();assert.deepEqual(applied,SETTINGS_DEFAULTS);assert.equal(c.ready,true);assert.match(c.message,/读取设置失败/);});
test('client rejected save keeps current controls and shows readable failure',async()=>{let applied=0,post;const c=new SettingsClient({token:'x',readControls:()=>({...preferred,schemaVersion:undefined}),applyControls:()=>applied++,onState(){},request:async(_,options)=>{post=options;return mockResponse({error:'冲突'},false);}});c.ready=true;c.revision='missing';c.readControls=()=>{const {schemaVersion,...v}=preferred;return v;};await c.save();assert.equal(applied,0);assert.match(c.message,/冲突/);assert.equal(JSON.parse(post.body).revision,'missing');});
test('client duplicate save is ignored while request is in flight',async()=>{let calls=0,finish;const pending=new Promise(r=>finish=r);const c=new SettingsClient({token:'x',readControls:()=>{const{schemaVersion,...v}=preferred;return v;},applyControls(){},onState(){},request:async()=>{calls++;await pending;return mockResponse({settings:preferred,revision:'b'.repeat(64),source:'saved',message:'saved'});}});c.ready=true;c.revision='missing';const first=c.save();await c.save();finish();await first;assert.equal(calls,1);});
test('HTTP security, save, multi-port restart restore, reset and no disk write from GET',async()=>{
  const directory=path.join(root,'http-settings');let app=await startServer({settingsDirectory:directory});
  const connect=async()=>{const config=await(await fetch(app.url+'/api/config')).json();return {'Content-Type':'application/json','X-Settings-Token':config.settingsToken,Origin:app.url};};
  const post=(headers,body)=>fetch(app.url+'/api/settings',{method:'POST',headers,body:JSON.stringify(body)});
  try{
    let headers=await connect();const initial=await(await fetch(app.url+'/api/settings')).json();assert.equal(initial.source,'defaults');await assert.rejects(access(directory),{code:'ENOENT'});
    const body={settings:preferred,revision:'missing'};
    assert.equal((await post({},body)).status,403);
    assert.equal((await post({...headers,Origin:'https://untrusted.example'},body)).status,403);
    const {Origin,...withoutOrigin}=headers;assert.equal((await post(withoutOrigin,body)).status,403);
    assert.equal((await post({...headers,'X-Settings-Token':'wrong'},body)).status,403);
    assert.equal((await post({...headers,'Content-Type':'text/plain'},body)).status,415);
    assert.equal((await post(headers,{...body,path:'C:/anything'})).status,400);
    assert.equal((await post(headers,{...body,settings:{...preferred,autoStartCamera:true}})).status,400);
    assert.equal((await post(headers,{...body,settings:{...preferred,eyeCloseThreshold:'0.4'}})).status,400);
    assert.equal((await post(headers,{...body,settings:{...preferred,padding:'x'.repeat(5000)}})).status,413);
    await assert.rejects(access(directory),{code:'ENOENT'});
    const saved=await post(headers,body);assert.equal(saved.status,200);const data=await saved.json();
    assert.equal((await post(headers,body)).status,409);
    const oldPort=app.port,oldToken=headers['X-Settings-Token'];await app.close();app=await startServer({settingsDirectory:directory});headers=await connect();
    assert.notEqual(headers['X-Settings-Token'],oldToken);assert.deepEqual((await(await fetch(app.url+'/api/settings')).json()).settings,preferred);
    const reset=await post(headers,{settings:SETTINGS_DEFAULTS,revision:data.revision});assert.equal(reset.status,200);assert.deepEqual((await reset.json()).settings,SETTINGS_DEFAULTS);
    assert.equal((await fetch(app.url+'/user-data/tracking-settings.json')).status,404);
    assert.equal((await fetch(app.url+'/api/settings',{method:'DELETE'})).status,405);
    assert.ok(oldPort>0&&app.port>0);
  }finally{await app.close();}
});
