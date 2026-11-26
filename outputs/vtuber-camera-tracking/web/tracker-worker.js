// Classic worker: MediaPipe's WASM loader can use importScripts. Never import SDK/Core here.
self.exports={};
let tracker;
self.onmessage=async({data})=>{
  try {
    if(data.type==='init'){
      importScripts('/vendor/vision_bundle.cjs');
      const {FaceLandmarker,FilesetResolver}=self.exports;
      const files=await FilesetResolver.forVisionTasks('/vendor/wasm');
      tracker=await FaceLandmarker.createFromOptions(files,{baseOptions:{modelAssetPath:'/tracker-model/face_landmarker.task',delegate:'CPU'},runningMode:'VIDEO',numFaces:1,outputFaceBlendshapes:true,outputFacialTransformationMatrixes:true,minFaceDetectionConfidence:.5,minFacePresenceConfidence:.5,minTrackingConfidence:.5});
      self.postMessage({type:'ready'});
    } else if(data.type==='frame'){
      if(!tracker)throw new Error('TRACKER_NOT_READY');
      const start=performance.now();
      const r=tracker.detectForVideo(data.bitmap,data.timestamp);
      self.postMessage({type:'result',result:{faceBlendshapes:r.faceBlendshapes,facialTransformationMatrixes:r.facialTransformationMatrixes},latency:performance.now()-start});
    }
  } catch(error){self.postMessage({type:'error',message:String(error?.message??error)});}
  finally {if(data.type==='frame')data.bitmap?.close();}
};
