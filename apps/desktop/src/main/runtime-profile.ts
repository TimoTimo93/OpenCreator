import { basename, dirname, join } from 'node:path';

export function resolveDesktopUserDataPath(
  defaultPath: string,
  development: boolean
): string {
  if (!development) return defaultPath;
  const resolved = join(
    dirname(defaultPath),
    `${basename(defaultPath)} Development`
  );
  return defaultPath.includes('/') && !defaultPath.includes('\\')
    ? resolved.replaceAll('\\', '/')
    : resolved;
}
