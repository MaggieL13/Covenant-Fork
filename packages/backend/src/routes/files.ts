import { Router } from 'express';
import multer from 'multer';
import { basename } from 'path';
import rateLimit from 'express-rate-limit';
import { getDb } from '../services/db.js';
import { deleteFile, getFile, listFiles, saveFile } from '../services/files.js';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

const uploadRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: 'Too many uploads, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
});

router.post('/files', uploadRateLimiter, upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No file provided' });
      return;
    }

    const rawName = req.file.originalname || 'unnamed';
    const safeName = basename(rawName).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 255);
    const fileMeta = saveFile(req.file.buffer, safeName, req.file.mimetype);
    res.json(fileMeta);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Upload failed';
    console.error('File upload error:', message);
    res.status(400).json({ error: message });
  }
});

router.get('/files/list', (_req, res) => {
  try {
    const files = listFiles();
    const rows = getDb()
      .prepare('SELECT metadata FROM messages WHERE metadata IS NOT NULL AND deleted_at IS NULL')
      .all() as Array<{ metadata: string }>;

    // Match the FilePanel's fallback set so historical Telegram messages
    // (which wrote voiceFileId / photoFileId before metadata was
    // normalized to a unified fileId) aren't flagged as orphans and
    // accidentally deleted from the Library.
    const FILE_ID_KEYS = ['fileId', 'voiceFileId', 'photoFileId'] as const;
    const usedFileIds = new Set<string>();
    for (const row of rows) {
      try {
        const metadata = JSON.parse(row.metadata);
        for (const key of FILE_ID_KEYS) {
          const value = metadata?.[key];
          if (typeof value === 'string' && value.length > 0) {
            usedFileIds.add(value);
          }
        }
      } catch {
        // Preserve current best-effort behavior on malformed metadata.
      }
    }

    const enriched = files.map((file) => ({
      ...file,
      inUse: usedFileIds.has(file.fileId),
    }));

    const totalSize = files.reduce((sum, file) => sum + file.size, 0);
    const orphanCount = enriched.filter((file) => !file.inUse).length;

    res.json({ files: enriched, totalSize, totalCount: files.length, orphanCount });
  } catch (error) {
    console.error('Error listing files:', error);
    res.status(500).json({ error: 'Failed to list files' });
  }
});

router.delete('/files/:id', (req, res) => {
  try {
    const deleted = deleteFile(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting file:', error);
    res.status(500).json({ error: 'Failed to delete file' });
  }
});

router.get('/files/:id', (req, res) => {
  try {
    const file = getFile(req.params.id);
    if (!file) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    const contentType = file.mimeType.startsWith('text/')
      ? `${file.mimeType}; charset=utf-8`
      : file.mimeType;

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.sendFile(file.path);
  } catch (error) {
    console.error('File download error:', error);
    res.status(500).json({ error: 'Failed to retrieve file' });
  }
});

export default router;
