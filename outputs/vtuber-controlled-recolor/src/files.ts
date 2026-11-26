import path from 'node:path';
import { lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { sha256 } from './pixels.ts';

export function within(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}
export function safeRelative(value: unknown): string {
  if (typeof value !== 'string' || !value || value.includes(':') || value.includes('\\') || value.includes('\0') || path.isAbsolute(value) || value.split('/').some(p => !p || p === '.' || p === '..' || p.endsWith('.') || p.endsWith(' '))) throw new Error('UNSAFE_PATH: 文件路径必须是目录内的普通相对路径');
  return value;
}
export async function safeFile(root: string, relative: unknown): Promise<string> {
  const rel = safeRelative(relative), target = path.resolve(root, rel);
  let probe = root;
  for (const part of rel.split('/')) {
    probe = path.join(probe, part);
    if ((await lstat(probe)).isSymbolicLink()) throw new Error('SYMLINK_NOT_ALLOWED: 不允许素材路径经过符号链接或目录联接');
  }
  const actual = await realpath(target);
  if (!within(root, actual)) throw new Error('PATH_ESCAPE: 文件超出输入目录');
  return actual;
}
export async function readLimited(file: string, max = 64 * 1024 * 1024): Promise<Buffer> {
  const info = await stat(file);
  if (!info.isFile() || info.size > max) throw new Error('FILE_SIZE_INVALID: 文件无效或过大 ' + file);
  return readFile(file);
}
export async function readJson(file: string): Promise<unknown> {
  try { return JSON.parse((await readLimited(file, 4 * 1024 * 1024)).toString('utf8')); }
  catch (error) { throw new Error('JSON_READ_ERROR: 无法读取 JSON ' + file, { cause: error }); }
}
export async function save(file: string, value: string | Uint8Array): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, value, { flag: 'wx' });
}
export async function saveJson(file: string, value: unknown): Promise<void> { await save(file, JSON.stringify(value, null, 2) + '\n'); }
export async function resolvedDestination(target: string): Promise<string> {
  let probe = path.resolve(target); const tail: string[] = [];
  while (true) {
    try { return path.join(await realpath(probe), ...tail.reverse()); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(probe); if (parent === probe) throw error;
      tail.push(path.basename(probe)); probe = parent;
    }
  }
}
export interface Fingerprint { path: string; bytes: number; sha256: string }
export async function fingerprint(file: string): Promise<Fingerprint> {
  const bytes = await readLimited(file, 256 * 1024 * 1024);
  return { path: file, bytes: bytes.length, sha256: sha256(bytes) };
}
export async function snapshot(roots: string[]): Promise<Fingerprint[]> {
  const files = new Set<string>();
  async function walk(file: string): Promise<void> {
    const info = await lstat(file);
    if (info.isSymbolicLink()) throw new Error('PROTECTED_SYMLINK: 受保护目录包含链接 ' + file);
    if (info.isDirectory()) for (const name of (await readdir(file)).sort()) await walk(path.join(file, name));
    else if (info.isFile()) files.add(file);
    else throw new Error('PROTECTED_FILE_INVALID: ' + file);
    if (files.size > 10000) throw new Error('TOO_MANY_PROTECTED_FILES');
  }
  for (const root of roots) await walk(root);
  const rows: Fingerprint[] = [];
  for (const file of [...files].sort()) rows.push(await fingerprint(file));
  return rows;
}
