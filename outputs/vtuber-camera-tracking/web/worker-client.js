export class WorkerTracker {
  constructor(){
    this.worker=new Worker('/tracker-worker.js');this.pending=null;this.closed=false;
    this.ready=new Promise((resolve,reject)=>{this.init={resolve,reject,timer:setTimeout(()=>this.fail(new Error('本地追踪模型加载超时，请停止后重试。')),30000)};});
    this.worker.onmessage=({data})=>{
      if(data.type==='error')return this.fail(new Error(data.message));
      if(data.type==='ready'&&this.init){clearTimeout(this.init.timer);this.init.resolve();this.init=null;}
      if(data.type==='result'&&this.pending){clearTimeout(this.pending.timer);this.pending.resolve(data);this.pending=null;}
    };
    this.worker.onerror=()=>this.fail(new Error('追踪线程启动失败，请检查本地依赖与浏览器。'));
    this.worker.postMessage({type:'init'});
  }
  frame(bitmap,timestamp){
    if(this.closed||this.pending){bitmap.close();return Promise.reject(new Error('TRACKER_BUSY_OR_CLOSED'));}
    return new Promise((resolve,reject)=>{
      this.pending={resolve,reject,timer:setTimeout(()=>this.fail(new Error('追踪计算超过 5 秒，已停止。')),5000)};
      try {this.worker.postMessage({type:'frame',bitmap,timestamp},[bitmap]);}
      catch(e){bitmap.close();this.fail(e);}
    });
  }
  fail(error){for(const p of [this.init,this.pending])if(p){clearTimeout(p.timer);p.reject(error);}this.init=this.pending=null;this.worker.terminate();this.closed=true;}
  close(){if(!this.closed)this.fail(new Error('TRACKER_STOPPED'));}
}
