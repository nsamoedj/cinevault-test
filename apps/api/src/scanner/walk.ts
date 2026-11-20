import { opendir, stat } from 'node:fs/promises';
import path from 'node:path';
import { subtitleFormat } from '@cinevault/shared';
import { isVideoFile } from './parse.js';

export interface WalkedFile {
  /** Relative to the walked root, "/"-separated. */
  relPath: string;
  absPath: string;
  size: number;
  modifiedAt: Date;
}

export interface WalkResult {
  files: WalkedFile[];
  /** Lower-cased file names per directory (relative, "" for the root), to spot local artwork. */
  namesByDir: Map<string, Set<string>>;
  /** Subtitle files (.srt, .ass, .ssa, .vtt) per directory, as named on disk. */
  subtitlesByDir: Map<string, string[]>;
}

const SKIP_DIRS = /^(?:[.@#$].*|system volume information|lost\+found)$/i;

/** Lists files below `root`. Unreadable directories are reported, not fatal. */
export async function walk(
  root: string,
  onError?: (dir: string, error: unknown) => void,
): Promise<WalkResult> {
  const files: WalkedFile[] = [];
  const namesByDir = new Map<string, Set<string>>();
  const subtitlesByDir = new Map<string, string[]>();

  async function visit(relDir: string): Promise<void> {
    const absDir = path.join(root, ...relDir.split('/').filter(Boolean));
    let dir;
    try {
      dir = await opendir(absDir);
    } catch (error) {
      onError?.(relDir, error);
      return;
    }
    const names = new Set<string>();
    namesByDir.set(relDir, names);
    const subdirs: string[] = [];
    for await (const entry of dir) {
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.test(entry.name)) subdirs.push(relPath);
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      names.add(entry.name.toLowerCase());
      if (subtitleFormat(entry.name)) {
        const list = subtitlesByDir.get(relDir) ?? [];
        list.push(entry.name);
        subtitlesByDir.set(relDir, list);
        continue;
      }
      if (!isVideoFile(entry.name)) continue;
      const absPath = path.join(absDir, entry.name);
      try {
        const info = await stat(absPath);
        if (info.isFile())
          files.push({ relPath, absPath, size: info.size, modifiedAt: info.mtime });
      } catch (error) {
        onError?.(relPath, error);
      }
    }
    for (const subdir of subdirs.sort()) await visit(subdir);
  }

  await visit('');
  return { files, namesByDir, subtitlesByDir };
}
