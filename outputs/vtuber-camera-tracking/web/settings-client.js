import {SETTINGS_DEFAULTS,validateSettings} from './settings-schema.js';
export class SettingsClient {
  constructor({token,readControls,applyControls,onState,request=(...args)=>fetch(...args)}){Object.assign(this,{token,readControls,applyControls,onState,request});this.busy=false;this.ready=false;this.revision=null;this.saved=null;this.message='正在读取本机设置…';this.path='';}
  state(message=this.message){this.message=message;this.onState({busy:this.busy,ready:this.ready,message,path:this.path});}
  async call(method,body){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
    try{
      const response=await this.request('/api/settings',{method,signal:controller.signal,cache:'no-store',headers:{'Content-Type':'application/json','X-Settings-Token':this.token},...(body?{body:JSON.stringify(body)}:{})});
      const data=await response.json();if(!response.ok)throw new Error(data.error??'设置操作失败。');
      data.settings=validateSettings(data.settings);return data;
    }finally{clearTimeout(timer);}
  }
  async load(){
    if(this.busy)return;this.busy=true;this.state('正在读取本机设置…');
    try{const data=await this.call('GET');this.applyControls(data.settings);this.revision=data.revision;this.saved=data.source==='saved'?JSON.stringify(data.settings):null;this.path=data.path;this.message=data.message;}
    catch{this.revision=null;if(!this.ready)this.applyControls({...SETTINGS_DEFAULTS});this.message='读取设置失败，当前界面仍可使用。检查本地服务后点“重新读取”；不会自动开启摄像头。';}
    finally{this.ready=true;this.busy=false;this.state();}
  }
  changed(){if(this.ready&&!this.busy)this.state('已修改，尚未保存。点击“保存设置”后才会在下次启动恢复。');}
  async save(reset=false){
    if(this.busy||!this.ready)return;this.busy=true;this.state(reset?'正在恢复并保存默认设置…':'正在保存设置…');
    try{
      const settings=reset?{...SETTINGS_DEFAULTS}:validateSettings({schemaVersion:1,...this.readControls()});
      const data=await this.call('POST',{settings,revision:this.revision});this.revision=data.revision;this.saved=JSON.stringify(data.settings);this.path=data.path;this.applyControls(data.settings);
      this.message=(reset?'已恢复并保存默认设置（闭眼阈值 0.30）。':'')+data.message;
    }catch(e){this.message='保存未确认成功：'+(e?.message??'本地服务不可用。')+' 当前界面值保留；若连接中断，请重新读取确认磁盘结果。';}
    finally{this.busy=false;this.state();}
  }
}
