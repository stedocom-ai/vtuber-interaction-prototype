import path from 'node:path';
import {lstat,realpath,mkdir,open,readFile,rename,unlink,writeFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {SETTINGS_DEFAULTS,validateSettings} from '../web/settings-schema.js';

export class SettingsError extends Error {
  status:number;
  constructor(message:string,status=400){super(message);this.status=status;}
}
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
export class SettingsStore {
  directory:string;file:string;commit:typeof rename;
  constructor(directory:string,commit=rename){this.directory=path.resolve(directory);this.file=path.join(this.directory,'tracking-settings.json');this.commit=commit;}
  async directoryReady(create=false){
    // The parent must already exist and must not resolve through a junction into another directory.
    const parent=path.dirname(this.directory);
    if(path.relative(parent,await realpath(parent))!=='')throw new SettingsError('设置路径经过目录链接，已停止读写。',409);
    if(create)await mkdir(this.directory,{recursive:false}).catch(e=>{if(e.code!=='EEXIST')throw e;});
    let info;try{info=await lstat(this.directory);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;}
    if(!info.isDirectory()||info.isSymbolicLink())throw new SettingsError('设置目录不是普通本地文件夹，已停止读写。',409);
    return true;
  }
  async bytes():Promise<Buffer|null>{
    if(!await this.directoryReady())return null;
    let info;try{info=await lstat(this.file);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}
    if(!info.isFile()||info.isSymbolicLink())throw new SettingsError('设置文件不是普通文件，已停止读写。',409);
    if(info.size>8192)throw new SettingsError('设置文件超过 8 KB，已停止读写；原文件保留。',409);
    const data=await readFile(this.file);if(data.length>8192)throw new SettingsError('设置文件超过大小限制。',409);return data;
  }
  async load(){
    try{
      const bytes=await this.bytes();
      if(bytes===null)return{settings:{...SETTINGS_DEFAULTS},revision:'missing',source:'defaults',message:'尚无已保存设置，使用程序默认值；调整后请点击保存。',path:this.file};
      try{return{settings:validateSettings(JSON.parse(bytes.toString('utf8'))),revision:sha(bytes),source:'saved',message:'已恢复本机设置；此操作不会自动开启摄像头。',path:this.file};}
      catch{return{settings:{...SETTINGS_DEFAULTS},revision:sha(bytes),source:'invalid',message:'设置文件损坏或版本不支持，暂用默认值。原文件未改；点击保存或恢复默认时会先留备份。',path:this.file};}
    }catch{return{settings:{...SETTINGS_DEFAULTS},revision:null,source:'unavailable',message:'无法安全读取设置文件，暂用默认值。请检查文件是否被占用、路径或权限；原文件未改。',path:this.file};}
  }
  async save(value:unknown,revision:unknown){
    const settings=validateSettings(value);
    if(typeof revision!=='string'||!(revision==='missing'||/^[0-9a-f]{64}$/.test(revision)))throw new SettingsError('缺少有效版本，请点击“重新读取”后再保存。',409);
    await this.directoryReady(true);
    const lockPath=path.join(this.directory,'.settings-write.lock');
    let lock;try{lock=await open(lockPath,'wx');}catch(e){if((e as NodeJS.ErrnoException).code==='EEXIST')throw new SettingsError('设置正在由另一个窗口保存，或上次意外退出留下锁文件。请稍后重新读取；不会覆盖现有设置。',409);throw e;}
    let temp:string|undefined;
    try{
      const before=await this.bytes(),current=before===null?'missing':sha(before);
      if(current!==revision)throw new SettingsError('设置已被另一个窗口或程序修改。请先点“重新读取”，确认后再保存。',409);
      let backupPath:string|undefined;
      if(before!==null){
        try{validateSettings(JSON.parse(before.toString('utf8')));}
        catch{backupPath=path.join(this.directory,`tracking-settings.invalid-${Date.now()}-${randomUUID()}.json`);await writeFile(backupPath,before,{flag:'wx'});}
      }
      const data=JSON.stringify(settings,null,2)+'\n';temp=path.join(this.directory,`.tracking-settings-${randomUUID()}.tmp`);
      const handle=await open(temp,'wx');try{await handle.writeFile(data,'utf8');await handle.sync();}finally{await handle.close();}
      // Only rename our own closed temp file; never truncate the existing configuration in-place.
      await this.commit(temp,this.file);temp=undefined;
      return{settings,revision:sha(Buffer.from(data)),source:'saved',path:this.file,backupPath,message:backupPath?'设置已保存；原损坏配置已留备份。':'设置已保存到本机，重新启动后会恢复。'};
    }finally{
      if(temp)await unlink(temp).catch(()=>{});
      await lock.close();await unlink(lockPath);
    }
  }
}
