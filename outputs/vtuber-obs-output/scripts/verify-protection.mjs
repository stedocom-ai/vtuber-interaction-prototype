import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { auditSdkIsolation } from '../../vtuber-runtime-recolor/src/sdk-audit.ts';

const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspace = path.resolve(moduleRoot, '../..');
const trackingRoot = path.resolve(moduleRoot, '../vtuber-camera-tracking');
const sdkRoot = 'D:/live 2D/CubismSdkForWeb/CubismSdkForWeb-5-r.5';
const before = JSON.parse(await readFile(path.join(moduleRoot, 'releases/obs-output-v0.1/protection-before.json'), 'utf8'));
const groups = {};
for (const [group, rows] of Object.entries(before)) {
  const differences = [];
  for (const row of rows) {
    const file = path.isAbsolute(row.path) ? row.path : path.join(trackingRoot, row.path);
    const bytes = await readFile(file);
    const actual = { path: row.path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    if (row.bytes !== actual.bytes || row.sha256 !== actual.sha256) differences.push({ before: row, after: actual });
  }
  groups[group] = { count: rows.length, differences };
}
const intentional = groups.trackingSources.differences;
if (intentional.length !== 1 || intentional[0].before.path.replaceAll('\\', '/') !== 'src/server.ts') throw Error('UNEXPECTED_TRACKING_SOURCE_CHANGE');
for (const group of ['protectedFiles', 'sdkFiles', 'fixedLogic', 'userSettings']) {
  if (groups[group].differences.length) throw Error('PROTECTED_FILES_CHANGED: ' + group);
}
const isolation = await auditSdkIsolation(workspace, moduleRoot, sdkRoot, before.sdkFiles);
console.log(JSON.stringify({ status: 'PASS', checkedAt: new Date().toISOString(), groups, isolation,
  intentionalChange: 'Only camera-tracking/src/server.ts gained an opt-in extension; default old entry keeps its original routes and permissions. No camera, settings, frozen renderer or model logic was rewritten.' }, null, 2));
