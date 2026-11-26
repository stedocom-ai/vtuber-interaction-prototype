// Verification-only compatibility for Windows native realpath EPERM in the tool
// environment. The official fs.realpath implementation still walks lstat/readlink;
// this never substitutes the requested path or relaxes file access permissions.
import fs from 'node:fs';
import {promisify} from 'node:util';
import {syncBuiltinESMExports} from 'node:module';
if(process.platform==='win32'){
  const native=fs.promises.realpath.bind(fs.promises),walk=promisify(fs.realpath);
  const evidence=globalThis[Symbol.for('vtuber.verification.realpath')]=[];
  fs.promises.realpath=async(...args)=>{
    try{return await native(...args);}
    catch(error){if(error.code!=='EPERM')throw error;const resolved=await walk(...args);evidence.push({input:String(args[0]),resolved:String(resolved)});return resolved;}
  };
  syncBuiltinESMExports();
}
