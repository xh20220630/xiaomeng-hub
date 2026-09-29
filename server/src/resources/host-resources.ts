import { constants } from 'node:fs';
import { open, realpath, stat, mkdir, readdir, opendir, writeFile, unlink } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import type {
  ResourceContext,
  ResourceMetadata,
  ResourceText,
  ResourceDirectory,
  ResourceAttachment,
} from '../types/resources.js';

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_TEXT_BYTES = 4 * 1024 * 1024;
const MAX_PIXELS = 25_000_000;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const versionOf = (s: Stats) => hash(`${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`);
const textExtensions = new Set(
  'txt md markdown json jsonl log ts tsx js jsx mjs cjs py dart rs go java kt kts cs c cpp h hpp css scss html htm svg xml yaml yml toml ini conf env sh bash ps1 sql csv gitignore editorconfig'.split(
    ' ',
  ),
);
const imageTypes: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

export class ResourceError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export function resourceError(error: unknown): ResourceError {
  if (error instanceof ResourceError) return error;
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR')
    return new ResourceError('NOT_FOUND', '文件不存在或已被删除', 404);
  if (code === 'EACCES' || code === 'EPERM')
    return new ResourceError('FORBIDDEN', '宿主机没有读取此文件的权限', 403);
  return new ResourceError('READ_FAILED', '暂时无法读取文件，请重试', 500);
}

export function within(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

export function parseReference(value: string) {
  if (typeof value !== 'string' || value.length > 4096 || /[\0\r\n]/.test(value))
    throw new ResourceError('INVALID_REFERENCE', '文件路径无效');
  let reference = value.trim().replace(/^<(.*)>$/, '$1');
  let line: number | undefined;
  const suffix = /(?::(\d+)(?::\d+)?|#L(\d+)(?:-L?\d+)?)$/.exec(reference);
  if (suffix) {
    line = Number(suffix[1] || suffix[2]);
    if (!Number.isSafeInteger(line) || line < 1 || line > 1_000_000)
      throw new ResourceError('INVALID_REFERENCE', '行号超出预览范围');
    reference = reference.slice(0, suffix.index);
  }
  if (reference.startsWith('file:')) {
    try {
      reference = fileURLToPath(reference);
    } catch {
      throw new ResourceError('INVALID_REFERENCE', '文件地址无效');
    }
  } else {
    try {
      reference = decodeURIComponent(reference);
    } catch {
      throw new ResourceError('INVALID_REFERENCE', '文件路径编码无效');
    }
  }
  if (
    /^[\\/]{2}|[\0\r\n]/.test(reference) ||
    (process.platform === 'win32' && /[<>"|?*]|:(?![\\/])/.test(reference))
  ) {
    throw new ResourceError('OUTSIDE_ROOT', '不支持网络共享、设备路径或特殊文件名', 403);
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(reference) && !/^[a-z]:[/\\]/i.test(reference))
    throw new ResourceError('INVALID_REFERENCE', '此地址不是宿主机文件');
  return { reference: reference || '.', line };
}

type Entry = {
  context: ResourceContext;
  file: string;
  roots: string[];
  metadata: ResourceMetadata;
  touched: number;
};

export class HostResources {
  private entries = new Map<string, Entry>();
  private activeImages = 0;
  private snapshotWrite: Promise<unknown> = Promise.resolve();
  private snapshotQuota: number;
  readonly cacheRoot: string;
  readonly extraRoots: string[];

  constructor(
    options: { cacheRoot?: string; extraRoots?: string[]; snapshotQuotaBytes?: number } = {},
  ) {
    this.snapshotQuota = options.snapshotQuotaBytes ?? 512 * 1024 * 1024;
    this.cacheRoot = path.resolve(
      options.cacheRoot ||
        process.env.RESOURCE_CACHE_DIR ||
        path.join(os.homedir(), '.xiaomeng', 'resources'),
    );
    this.extraRoots =
      options.extraRoots ??
      (process.env.RESOURCE_ROOTS || '').split(path.delimiter).filter(Boolean);
  }

  private entry(context: ResourceContext, id: string) {
    const entry = this.entries.get(id);
    if (
      !entry ||
      entry.context.sessionId !== context.sessionId ||
      entry.context.cwd !== context.cwd ||
      Date.now() - entry.touched > 3600000
    ) {
      throw new ResourceError('RESOURCE_EXPIRED', '预览已过期，请重新打开文件', 410);
    }
    entry.touched = Date.now();
    return entry;
  }

  async resolve(
    context: ResourceContext,
    value: string,
    baseId?: string,
  ): Promise<ResourceMetadata> {
    if (!context.cwd || !path.isAbsolute(context.cwd))
      throw new ResourceError('NO_WORKSPACE', '此会话没有可用的工作目录', 409);
    let parsed: { reference: string; line?: number };
    let roots: string[];
    let file: string;
    const snapshot = /^attachment:([a-f0-9]{64})\.(png|jpg|webp)$/.exec(value);
    if (snapshot) {
      roots = [await realpath(path.join(this.cacheRoot, hash(context.sessionId)))];
      file = path.join(roots[0], `${snapshot[1]}.${snapshot[2]}`);
      parsed = { reference: file };
    } else {
      parsed = parseReference(value);
      roots = await Promise.all([context.cwd, ...this.extraRoots].map((root) => realpath(root)));
      const base = baseId ? this.entry(context, baseId) : null;
      const directory = base
        ? base.metadata.kind === 'directory'
          ? base.file
          : path.dirname(base.file)
        : context.cwd;
      file = base && /^#L\d/.test(value) ? base.file : path.resolve(directory, parsed.reference);
    }
    file = await realpath(file);
    if (!roots.some((root) => within(root, file)))
      throw new ResourceError('OUTSIDE_ROOT', '文件不在项目或已共享的目录中', 403);
    const info = await stat(file);
    if (!info.isFile() && !info.isDirectory())
      throw new ResourceError('UNSUPPORTED_TYPE', '不支持预览此类文件');
    const extension = path.extname(file).toLowerCase();
    const imageType = imageTypes[extension];
    const text =
      textExtensions.has(extension.slice(1)) ||
      textExtensions.has(path.basename(file).replace(/^\./, ''));
    const kind = info.isDirectory()
      ? 'directory'
      : imageType
        ? 'image'
        : ['.md', '.markdown'].includes(extension)
          ? 'markdown'
          : text
            ? 'text'
            : 'file';
    const metadata: ResourceMetadata = {
      resourceId: randomUUID(),
      name: snapshot ? `图片-${snapshot[1].slice(0, 8)}.${snapshot[2]}` : path.basename(file),
      kind,
      mimeType: imageType || (text ? 'text/plain; charset=utf-8' : 'application/octet-stream'),
      size: info.size,
      version: versionOf(info),
      modifiedAt: info.mtimeMs,
      snapshot: !!snapshot,
      previewAvailable: kind !== 'file' && (kind !== 'image' || info.size <= MAX_IMAGE_BYTES),
      line: parsed.line,
    };
    const entry = { context: { ...context }, file, roots, metadata, touched: Date.now() };
    this.entries.set(metadata.resourceId, entry);
    while (this.entries.size > 1000) this.entries.delete(this.entries.keys().next().value!);
    return metadata;
  }

  private async checked(entry: Entry, version?: string) {
    const actual = await realpath(entry.file);
    if (actual !== entry.file || !entry.roots.some((root) => within(root, actual)))
      throw new ResourceError('OUTSIDE_ROOT', '文件位置发生变化，请重新打开', 403);
    const info = await stat(actual);
    if (versionOf(info) !== (version || entry.metadata.version))
      throw new ResourceError('RESOURCE_CHANGED', '文件已经修改，请刷新预览', 409);
    return info;
  }

  async metadata(context: ResourceContext, id: string) {
    const entry = this.entry(context, id);
    await this.checked(entry);
    return entry.metadata;
  }

  private async bytes(entry: Entry, max: number, partial = false, version?: string) {
    const before = await this.checked(entry, version);
    if (!before.isFile()) throw new ResourceError('UNSUPPORTED_TYPE', '请选择一个文件');
    if (!partial && before.size > max)
      throw new ResourceError('TOO_LARGE', '文件超过预览大小限制', 413);
    const handle = await open(entry.file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const opened = await handle.stat();
      if (versionOf(opened) !== versionOf(before))
        throw new ResourceError('RESOURCE_CHANGED', '文件已经修改，请刷新预览', 409);
      const buffer = Buffer.alloc(Math.min(before.size, max));
      let read = 0;
      while (read < buffer.length) {
        const result = await handle.read(buffer, read, buffer.length - read, read);
        if (!result.bytesRead) break;
        read += result.bytesRead;
      }
      // Check the open handle and the resolved path again before returning any bytes.
      if (read !== buffer.length || versionOf(await handle.stat()) !== versionOf(before))
        throw new ResourceError('RESOURCE_CHANGED', '读取期间文件发生变化', 409);
      await this.checked(entry, version);
      return buffer;
    } finally {
      await handle.close();
    }
  }

  async text(
    context: ResourceContext,
    id: string,
    version: string,
    startLine = 1,
  ): Promise<ResourceText> {
    if (!Number.isInteger(startLine) || startLine < 1 || startLine > 1_000_000)
      throw new ResourceError('INVALID_RANGE', '行号无效');
    const entry = this.entry(context, id);
    if (!['text', 'markdown'].includes(entry.metadata.kind))
      throw new ResourceError('UNSUPPORTED_TYPE', '此文件不能作为文本预览');
    const buffer = await this.bytes(entry, MAX_TEXT_BYTES, true, version);
    const encoding =
      buffer[0] === 0xff && buffer[1] === 0xfe
        ? 'utf-16le'
        : buffer[0] === 0xfe && buffer[1] === 0xff
          ? 'utf-16be'
          : 'utf-8';
    const truncated = buffer.length < entry.metadata.size;
    let content: string;
    try {
      content = new TextDecoder(encoding, { fatal: true }).decode(buffer, { stream: truncated });
    } catch {
      throw new ResourceError('UNSUPPORTED_ENCODING', '文件编码暂不支持 UTF-8 / UTF-16 预览');
    }
    if (content.includes('\0'))
      throw new ResourceError('UNSUPPORTED_TYPE', '检测到二进制内容，无法作为文本预览');
    const lines = content.split(/\r?\n/);
    const selected: string[] = [];
    let length = 0;
    let clipped = false;
    for (const line of lines.slice(startLine - 1, startLine + 199)) {
      const bytes = Buffer.byteLength(line + '\n');
      if (length + bytes > 256 * 1024) {
        if (!selected.length) {
          selected.push(line.slice(0, 60000));
          clipped = true;
        }
        break;
      }
      selected.push(line);
      length += bytes;
    }
    return {
      text: selected.join('\n'),
      startLine,
      nextLine:
        !clipped && startLine + selected.length <= lines.length
          ? startLine + selected.length
          : null,
      truncated: truncated || clipped,
      encoding,
      version: entry.metadata.version,
    };
  }

  async image(context: ResourceContext, id: string, version: string, thumbnail: boolean) {
    const entry = this.entry(context, id);
    if (entry.metadata.kind !== 'image')
      throw new ResourceError('UNSUPPORTED_TYPE', '此文件不是支持的图片');
    if (this.activeImages >= 2) throw new ResourceError('BUSY', '图片正在加载，请稍后重试', 429);
    this.activeImages++;
    try {
      const bytes = await this.bytes(entry, MAX_IMAGE_BYTES, false, version);
      const image = sharp(bytes, { limitInputPixels: MAX_PIXELS, failOn: 'warning' });
      const meta = await image.metadata();
      if (!['png', 'jpeg', 'webp'].includes(meta.format || '') || (meta.pages || 1) > 1)
        throw new ResourceError('UNSUPPORTED_TYPE', '首期支持静态 PNG、JPEG、WebP 图片');
      if (!meta.width || !meta.height || meta.width * meta.height > MAX_PIXELS)
        throw new ResourceError('TOO_LARGE', '图片像素超过预览限制', 413);
      entry.metadata.width = meta.width;
      entry.metadata.height = meta.height;
      return thumbnail
        ? {
            bytes: await image
              .rotate()
              .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
              .webp({ quality: 80 })
              .timeout({ seconds: 10 })
              .toBuffer(),
            mimeType: 'image/webp',
          }
        : { bytes, mimeType: meta.format === 'jpeg' ? 'image/jpeg' : `image/${meta.format}` };
    } catch (error) {
      if (error instanceof ResourceError) throw error;
      if ((error as NodeJS.ErrnoException)?.code) throw error;
      throw new ResourceError('INVALID_IMAGE', '图片无法解码或超过预览限制');
    } finally {
      this.activeImages--;
    }
  }

  async list(context: ResourceContext, id: string, cursor = '0'): Promise<ResourceDirectory> {
    const entry = this.entry(context, id);
    if (entry.metadata.kind !== 'directory')
      throw new ResourceError('UNSUPPORTED_TYPE', '请选择一个目录');
    await this.checked(entry);
    const offset = Number(cursor);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000)
      throw new ResourceError('INVALID_RANGE', '目录游标无效');
    const children = [];
    for await (const child of await opendir(entry.file)) {
      children.push(child);
      if (children.length > 10000)
        throw new ResourceError('TOO_LARGE', '目录项目过多，请打开更具体的子目录', 413);
    }
    const items = children
      .filter((child) => child.isDirectory() || child.isFile())
      .sort(
        (a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name),
      );
    await this.checked(entry);
    return {
      directory: entry.metadata,
      entries: items.slice(offset, offset + 100).map((child) => ({
        name: child.name,
        reference: encodeURIComponent(child.name),
        directory: child.isDirectory(),
      })),
      nextCursor: offset + 100 < items.length ? String(offset + 100) : null,
    };
  }

  async snapshot(
    context: ResourceContext,
    data: string,
    mimeType: string,
  ): Promise<ResourceAttachment> {
    const extension = (
      { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' } as Record<string, string>
    )[mimeType];
    if (
      !extension ||
      data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(data)
    )
      throw new ResourceError('INVALID_IMAGE', '图片附件无效或过大');
    const bytes = Buffer.from(data, 'base64');
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES)
      throw new ResourceError('TOO_LARGE', '图片附件过大', 413);
    const name = `${hash(bytes)}.${extension}`;
    const directory = path.join(this.cacheRoot, hash(context.sessionId));
    const write = async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const filename = path.join(directory, name);
      try {
        await stat(filename);
        return;
      } catch {
        /* New snapshots are written once. */
      }
      const files: { file: string; directory: string; stat: Stats }[] = [];
      for (const dir of await readdir(this.cacheRoot, { withFileTypes: true })) {
        if (!dir.isDirectory() || !/^[a-f0-9]{64}$/.test(dir.name)) continue;
        const snapshotDirectory = path.join(this.cacheRoot, dir.name);
        for (const entry of await readdir(snapshotDirectory, { withFileTypes: true })) {
          if (!entry.isFile() || !/^[a-f0-9]{64}\.(png|jpg|webp)$/.test(entry.name)) continue;
          const file = path.join(snapshotDirectory, entry.name);
          const info = await stat(file).catch(() => null);
          if (info) files.push({ file, directory: snapshotDirectory, stat: info });
        }
      }
      let total = files.reduce((sum, file) => sum + file.stat.size, 0);
      let sessionTotal = files
        .filter((file) => file.directory === directory)
        .reduce((sum, file) => sum + file.stat.size, 0);
      for (const oldest of files.sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs)) {
        const expired = oldest.stat.mtimeMs < Date.now() - 30 * 24 * 3600000;
        if (
          !expired &&
          total + bytes.length <= this.snapshotQuota &&
          (oldest.directory !== directory || sessionTotal + bytes.length <= 128 * 1024 * 1024)
        )
          continue;
        await unlink(oldest.file).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
        total -= oldest.stat.size;
        if (oldest.directory === directory) sessionTotal -= oldest.stat.size;
      }
      if (bytes.length > this.snapshotQuota)
        throw new ResourceError('TOO_LARGE', '图片附件超过缓存配额', 413);
      await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
    };
    this.snapshotWrite = this.snapshotWrite.catch(() => {}).then(write);
    await this.snapshotWrite;
    return {
      reference: `attachment:${name}`,
      name: `图片.${extension}`,
      kind: 'image',
      snapshot: true,
    };
  }
}

export const localResources = new HostResources();
