import { run } from './run.ts';
try {
  const args = process.argv.slice(2), options: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!key || !['--color', '--config'].includes(key) || !value || value.startsWith('--') || key in options) throw new Error('USAGE: cli.ts --color "#7A5AF8" [--config 配置JSON路径]');
    options[key] = value;
  }
  if (!options['--color']) throw new Error('INVALID_COLOR: 请提供 --color "#7A5AF8"');
  const result = await run({ color: options['--color'], ...(options['--config'] ? { configPath: options['--config'] } : {}) });
  console.log(JSON.stringify({ status: result.report.status, output: result.output, passedChecks: result.report.passedChecks,
    changedPixels: result.report.target.changedPixels, errors: result.report.errors, warnings: result.report.warnings,
    manualPreview: result.report.previews.find(p => p.name === 'character-side-by-side.png')!.path }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2;
}
