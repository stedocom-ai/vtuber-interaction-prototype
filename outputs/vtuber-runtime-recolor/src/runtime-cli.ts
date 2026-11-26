import { integrate, moduleRoot } from './integrate.ts';
import { parseRuntimeArgs } from './cli-options.ts';
try {
  const options = parseRuntimeArgs(process.argv.slice(2), moduleRoot);
  const result = await integrate({ sdk: options.sdk, color: options.color, modelName: options.outputName,
    output: options.output, stageAOnly: options.stageAOnly, ...(options.sourceModel ? { sourceModel: options.sourceModel } : {}) });
  console.log(JSON.stringify({ status: result.status, output: result.output, modelCreated: result.modelCreated,
    color: options.color, modelName: options.outputName,
    ownership: { directOverlapPixels: result.phaseA.directOverlapPixels, guardedOverlapPixels: result.phaseA.guardedOverlapPixels },
    ...('report' in result && result.report ? { changedPixels: result.report.changedPixels, passedChecks: result.report.passedChecks, viewerFile: result.report.viewerFile, vtsFolder: result.report.vtsFolder } : {}) }, null, 2));
  if (result.status === 'ERROR') process.exitCode = 2;
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2; }
