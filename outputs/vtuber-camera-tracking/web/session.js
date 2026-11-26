export function cameraError(error) {
  const messages={NotAllowedError:'摄像头权限未获允许。请由你在浏览器中允许此页面使用摄像头后重试。',NotFoundError:'没有找到摄像头，请连接摄像头后重试。',NotReadableError:'摄像头无法读取，可能被其他程序占用。请关闭占用摄像头的软件后重试。',OverconstrainedError:'摄像头不支持请求的画面设置。',SecurityError:'浏览器禁止访问摄像头，请使用启动器提供的本地地址。',AbortError:'摄像头启动中断，请重试。'};
  return messages[error?.name] ?? ('追踪启动或运行失败：'+String(error?.message??error));
}
// Owns all camera resources; injected dependencies make cancellation races testable without a camera.
export class CameraSession {
  constructor({acquire,createTracker,attach,detach,onState}) {Object.assign(this,{acquire,createTracker,attach,detach,onState});this.generation=0;this.state='idle';this.stream=null;this.tracker=null;}
  change(state,message){this.state=state;this.onState(state,message);}
  async start(){
    if (this.state!=='idle') return;
    const id=++this.generation;this.change('starting','等待你允许摄像头；也可以点击停止取消。');
    try {
      const stream=await this.acquire();
      if(id!==this.generation){stream.getTracks().forEach(t=>t.stop());return;}
      this.stream=stream;
      stream.getTracks().forEach(t=>t.addEventListener('ended',()=>{if(id===this.generation)this.stop('摄像头已断开，已恢复手动控制。');},{once:true}));
      // Store tracker before awaiting readiness so stop can terminate in-flight initialization.
      const tracker=this.createTracker();this.tracker=tracker;
      this.change('starting','摄像头已连接，正在本机加载追踪模型…');
      await tracker.ready;
      if(id!==this.generation)return;
      let playTimer;
      try {await Promise.race([this.attach(stream),new Promise((_,reject)=>{playTimer=setTimeout(()=>reject(new Error('摄像头画面启动超时，请停止后重试。')),8000);})]);}
      finally {clearTimeout(playTimer);}
      if(id!==this.generation)return;
      this.change('running','正在追踪；请保持单人入镜，点击正视校准。');
    } catch(error){if(id===this.generation)this.stop(cameraError(error));}
  }
  stop(message='摄像头已停止，已恢复手动控制。'){
    ++this.generation;
    this.stream?.getTracks().forEach(t=>t.stop());this.stream=null;
    this.tracker?.close();this.tracker=null;this.detach();this.change('idle',message);
  }
}
