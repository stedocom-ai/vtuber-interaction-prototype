import path from 'node:path';

export function normalizeRgbHex(value: unknown): string {
  if (typeof value !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(value)) {
    throw new Error('INVALID_COLOR: 颜色必须严格使用 #RRGGBB；不接受 Alpha、短格式或省略 #');
  }
  return value.toUpperCase();
}

export function validateModelName(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value)) {
    throw new Error('INVALID_OUTPUT_NAME: 名称须以英文字母开头，只能包含英文字母、数字、下划线或连字符，最长 64 字符');
  }
  return value;
}

export interface RuntimeCliOptions {
  sdk: string;
  color: string;
  outputName: string;
  outputDirectory: string;
  output: string;
  sourceModel?: string;
  stageAOnly: boolean;
}

export function parseRuntimeArgs(args: string[], moduleRoot: string): RuntimeCliOptions {
  let sdk: string | undefined, rawColor: string | undefined, rawName: string | undefined, outputDirectory: string | undefined, sourceModel: string | undefined, stageAOnly = false;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (!['--sdk', '--color', '--output-name', '--output-dir', '--source-model', '--stage-a'].includes(flag)) throw new Error('UNKNOWN_ARGUMENT: ' + flag);
    if (seen.has(flag)) throw new Error('DUPLICATE_ARGUMENT: ' + flag);
    seen.add(flag);
    if (flag === '--stage-a') { stageAOnly = true; continue; }
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error('MISSING_ARGUMENT_VALUE: ' + flag);
    if (flag === '--sdk') sdk = value;
    else if (flag === '--color') rawColor = value;
    else if (flag === '--output-name') rawName = value;
    else if (flag === '--output-dir') outputDirectory = value;
    else sourceModel = value;
  }
  if (!sdk) throw new Error('SDK_REQUIRED: 请通过 --sdk 指定本机外部 SDK 路径');
  if (!rawColor) throw new Error('COLOR_REQUIRED: 请通过 --color 指定 #RRGGBB 颜色');
  const color = normalizeRgbHex(rawColor);
  const outputName = validateModelName(rawName ?? `minimal_character_v1_${color.slice(1).toLowerCase()}_test`);
  const base = path.resolve(outputDirectory ?? path.join(moduleRoot, 'runs'));
  return { sdk, color, outputName, outputDirectory: base, output: path.join(base, outputName), ...(sourceModel ? { sourceModel } : {}), stageAOnly };
}
