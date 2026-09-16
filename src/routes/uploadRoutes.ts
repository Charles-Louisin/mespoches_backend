import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { UTApi, UTFile } from 'uploadthing/server';
import { protect } from '../middleware/auth';

const router = Router();
const MAX_BYTES = 4 * 1024 * 1024;
const utapi = new UTApi();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1 },
});

function multerSingle(req: Request, res: Response, next: NextFunction): void {
  upload.single('file')(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({
        success: false,
        message: 'Image trop volumineuse (max 4 Mo)',
      });
      return;
    }
    if (err) {
      res.status(400).json({
        success: false,
        message: 'Fichier illisible',
      });
      return;
    }
    next();
  });
}

router.post('/image', protect, multerSingle, async (req: Request, res: Response) => {
  if (!process.env.UPLOADTHING_TOKEN?.trim()) {
    return res.status(503).json({
      success: false,
      message: 'Upload non configuré (UPLOADTHING_TOKEN)',
    });
  }

  const file = req.file;
  if (!file?.buffer?.length) {
    return res.status(400).json({
      success: false,
      message: 'Aucune image',
    });
  }

  const type = (file.mimetype || 'image/jpeg').toLowerCase();
  if (!type.startsWith('image/')) {
    return res.status(400).json({
      success: false,
      message: 'Format image requis',
    });
  }

  const name = (file.originalname || 'mes-poches.jpg').replace(/[^\w.-]+/g, '_');

  try {
    const uploaded = await utapi.uploadFiles(new UTFile([file.buffer], name));
    const result = Array.isArray(uploaded) ? uploaded[0] : uploaded;
    if (!result || result.error || !result.data) {
      console.error('UploadThing failed:', result?.error);
      return res.status(502).json({
        success: false,
        message: 'Envoi impossible',
      });
    }
    const url = result.data.ufsUrl || result.data.url;
    if (!url) {
      return res.status(502).json({
        success: false,
        message: 'URL image manquante',
      });
    }
    return res.json({ success: true, data: { url } });
  } catch (err) {
    console.error('Upload image error:', err);
    return res.status(500).json({
      success: false,
      message: 'Envoi impossible',
    });
  }
});

export default router;
