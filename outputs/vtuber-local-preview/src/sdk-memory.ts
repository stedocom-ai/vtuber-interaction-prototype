import path from 'node:path';
import { readFile } from 'node:fs/promises';
import ts from '../../vtuber-controlled-recolor/node_modules/typescript/lib/typescript.js';
import { safeFile } from '../../vtuber-controlled-recolor/src/files.ts';

/** External SDK -> memory-only HTTP responses. Never emit source, maps or build files. */
export function memorySdk(root: string) {
  const cache = new Map<string, { body: string | Buffer; type: string }>();
  return {
    cache,
    async get(url: string) {
      if (cache.has(url)) return cache.get(url)!;
      let body: string | Buffer, type: string;
      if (url === '/sdk/core.js') {
        body = await readFile(await safeFile(root, 'Core/live2dcubismcore.js')); type = 'text/javascript';
      } else if (url.startsWith('/sdk/framework/') && url.endsWith('.js')) {
        const relative = url.slice('/sdk/framework/'.length, -3) + '.ts';
        const file = await safeFile(path.join(root, 'Framework/src'), relative);
        const source = await readFile(file, 'utf8');
        body = ts.transpileModule(source, { fileName: file, compilerOptions: {
          target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022,
          sourceMap: false, inlineSourceMap: false, removeComments: true,
        } }).outputText.replace(/(from\s+['"])(\.[^'"]+)(['"])/g, (_all, before, name, after) => before + (name.endsWith('.js') ? name : name + '.js') + after);
        type = 'text/javascript';
      } else if (/^\/sdk\/shaders\/[a-z0-9]+\.(vert|frag)$/.test(url)) {
        body = await readFile(await safeFile(path.join(root, 'Framework/Shaders/WebGL'), url.slice('/sdk/shaders/'.length)));
        type = 'text/plain';
      } else throw new Error('SDK_ROUTE_DENIED');
      const value = { body, type }; cache.set(url, value); return value;
    },
  };
}
