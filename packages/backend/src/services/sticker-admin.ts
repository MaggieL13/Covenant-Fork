import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { PROJECT_ROOT } from '../config.js';

export function parseStickerAliases(aliases: unknown): string[] {
  return aliases && typeof aliases === 'string'
    ? aliases.split(',').map((alias) => alias.trim()).filter(Boolean)
    : [];
}

export function sanitizeStickerFilename(name: string, mimeType: string): string {
  const ext = mimeType === 'image/webp' ? '.webp' : '.png';
  const sanitizedName = name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100);
  return `${sanitizedName}${ext}`;
}

export function ensureStickerPackDir(packId: string): string {
  const packDir = resolve(PROJECT_ROOT, 'data', 'stickers', packId);
  mkdirSync(packDir, { recursive: true });
  return packDir;
}

export function writeStickerFile(packId: string, filename: string, buffer: Buffer): void {
  const packDir = ensureStickerPackDir(packId);
  writeFileSync(join(packDir, filename), buffer);
}

export function deleteStickerPackFiles(packId: string): void {
  const packDir = resolve(PROJECT_ROOT, 'data', 'stickers', packId);
  if (existsSync(packDir)) {
    rmSync(packDir, { recursive: true, force: true });
  }
}

export function deleteStickerFile(packId: string, filename: string): void {
  const filePath = resolve(PROJECT_ROOT, 'data', 'stickers', packId, filename);
  if (existsSync(filePath)) {
    rmSync(filePath);
  }
}
