import { preflight } from './preflight.ts';
try {
  if (process.argv.length > 2) throw new Error('USAGE: 本入口仅执行当前参考模型的只读前置检查，不提供纹理改写开关');
  const r = await preflight();
  console.log(JSON.stringify({ status: r.status, code: r.code, modelPath: r.modelPath, allModelReferencesExist: r.allModelReferencesExist,
    originalsUnchanged: r.originalsUnchanged, modifiedPixels: 0, newModelCreated: r.newModelCreated, reportDirectory: r.output }, null, 2));
  process.exitCode = 2;
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2; }
