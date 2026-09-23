/** 统一定位源码与编译产物共享的资源，避免启动目录改变数据库或静态页面位置。 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 从当前模块向上寻找服务包，源码和 dist 运行时使用同一数据目录。
 * @returns 包含服务端 package.json 的绝对目录。
 */
function findServerRoot(): string {
  let directory = path.dirname(fileURLToPath(import.meta.url));
  while (!existsSync(path.join(directory, 'package.json'))) {
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error('Cannot locate server package.json');
    directory = parent;
  }
  return directory;
}

/** 服务包根目录；持久化数据不应随 dist 重建而被删除。 */
export const SERVER_ROOT = findServerRoot();
/** 浏览器配对页的位置，生产运行也复用包内静态资源。 */
export const PAIR_PUBLIC_DIR = path.join(SERVER_ROOT, 'public', 'pair');
