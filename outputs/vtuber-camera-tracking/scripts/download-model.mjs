import { mkdir, access, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root = new URL('../models/', import.meta.url); await mkdir(root, { recursive:true });
const target = new URL('face_landmarker.task', root);
try { await access(target); throw new Error('OUTPUT_EXISTS: 不覆盖现有追踪模型。'); } catch(e) { if(e.code !== 'ENOENT') throw e; }
const url = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const response = await fetch(url); if(!response.ok) throw new Error('MODEL_DOWNLOAD_FAILED: '+response.status);
const bytes = Buffer.from(await response.arrayBuffer()); if(bytes.length < 1000000 || bytes.length > 20000000) throw new Error('MODEL_SIZE_INVALID');
const info = { source:url, downloadedAt:new Date().toISOString(), bytes:bytes.length, sha256:createHash('sha256').update(bytes).digest('hex'), generation:response.headers.get('x-goog-generation'), license:'Apache-2.0 (component model cards)', packageVersion:'0.10.35' };
if(info.sha256!=='64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff')throw new Error('MODEL_HASH_UNVERIFIED: 下载结果不匹配本版已验证模型，未写入。');
await writeFile(target,bytes,{flag:'wx'}); await writeFile(new URL('model-lock.json',root),JSON.stringify(info,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(info,null,2));
