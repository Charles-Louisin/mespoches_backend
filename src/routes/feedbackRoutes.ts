import { Router, Request, Response } from 'express';
import Joi from 'joi';
import mongoose from 'mongoose';
import FeedbackMessage from '../models/FeedbackMessage';
import User from '../models/User';
import { invalidateUserCache, protect, adminOnly } from '../middleware/auth';
import { feedbackLimiter } from '../utils/security';
import { notifyAdminsOfFeedback, notifyUserOfAdminReply } from '../utils/expoPush';

const router = Router();
router.use(protect);

const MAX_BODY = 4000;

const bodySchema = Joi.object({
  body: Joi.string().min(1).max(MAX_BODY).required(),
});

const tokenSchema = Joi.object({
  token: Joi.string().min(20).max(200).required(),
});

function cleanBody(raw: unknown): string {
  return String(raw ?? '')
    .replace(/\u0000/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

function previewOf(body: string): string {
  return body.replace(/\s+/g, ' ').trim().slice(0, 120);
}

function displayName(user: { name?: string; email?: string } | null | undefined): string {
  const name = user?.name?.trim();
  if (name) return name;
  return user?.email?.split('@')[0] || 'Utilisateur';
}

router.post('/push-token', async (req: Request, res: Response) => {
  try {
    const { error, value } = tokenSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ success: false, message: 'Jeton de notification invalide' });
    }
    const token = value.token.trim();
    await User.findByIdAndUpdate(req.user!._id, { expoPushToken: token });
    invalidateUserCache(String(req.user!._id));
    return res.json({ success: true, data: { ok: true } });
  } catch (err) {
    console.error('feedback push-token:', err);
    return res.status(500).json({ success: false, message: 'Enregistrement du jeton impossible' });
  }
});

router.get('/inbox-ping', async (req: Request, res: Response) => {
  try {
    const me = req.user!;
    if (me.role === 'admin') {
      const rows = await FeedbackMessage.aggregate([
        { $match: { from: 'user', read_at: null } },
        { $sort: { created_at: -1 } },
        {
          $group: {
            _id: '$user_id',
            preview: { $first: '$body' },
            lastAt: { $first: '$created_at' },
            unread: { $sum: 1 },
          },
        },
        { $sort: { lastAt: -1 } },
        { $limit: 1 },
      ]);
      const row = rows[0];
      const unread = row?.unread ?? 0;
      return res.json({
        success: true,
        data: {
          role: 'admin',
          unread,
          preview: unread ? previewOf(String(row.preview || '')) : '',
          userId: row?._id ? String(row._id) : '',
          lastAt: row?.lastAt ? new Date(row.lastAt).toISOString() : '',
        },
      });
    }

    const [unread, last] = await Promise.all([
      FeedbackMessage.countDocuments({
        user_id: me._id,
        from: 'admin',
        read_at: null,
      }),
      FeedbackMessage.findOne({ user_id: me._id, from: 'admin' })
        .sort({ created_at: -1 })
        .select('body created_at')
        .lean(),
    ]);
    return res.json({
      success: true,
      data: {
        role: 'user',
        unread,
        preview: unread && last?.body ? previewOf(last.body) : '',
        userId: String(me._id),
        lastAt: last?.created_at ? new Date(last.created_at).toISOString() : '',
      },
    });
  } catch (err) {
    console.error('feedback inbox-ping:', err);
    return res.status(500).json({ success: false, message: 'Impossible de vérifier la messagerie' });
  }
});

router.get('/me', async (req: Request, res: Response) => {
  try {
    const list = await FeedbackMessage.find({ user_id: req.user!._id })
      .sort({ created_at: 1 })
      .lean();
    await FeedbackMessage.updateMany(
      { user_id: req.user!._id, from: 'admin', read_at: null },
      { $set: { read_at: new Date() } }
    );
    return res.json({ success: true, data: list });
  } catch (err) {
    console.error('feedback me:', err);
    return res.status(500).json({ success: false, message: 'Impossible de charger les messages' });
  }
});

router.post('/me', feedbackLimiter, async (req: Request, res: Response) => {
  try {
    const { error, value } = bodySchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: 'Écrivez un message (1 à 4000 caractères).',
      });
    }
    const body = cleanBody(value.body);
    if (!body) {
      return res.status(400).json({ success: false, message: 'Le message est vide.' });
    }

    const user = req.user!;
    const doc = await FeedbackMessage.create({
      user_id: user._id,
      author_id: user._id,
      from: 'user',
      body,
    });

    void notifyAdminsOfFeedback({
      userName: displayName(user),
      preview: previewOf(body),
      userId: String(user._id),
      exceptUserId: String(user._id),
    });

    return res.status(201).json({ success: true, data: doc });
  } catch (err) {
    console.error('feedback create:', err);
    return res.status(500).json({ success: false, message: 'Envoi impossible' });
  }
});

router.get('/threads', adminOnly, async (_req: Request, res: Response) => {
  try {
    const rows = await FeedbackMessage.aggregate([
      { $sort: { created_at: -1 } },
      {
        $group: {
          _id: '$user_id',
          lastBody: { $first: '$body' },
          lastAt: { $first: '$created_at' },
          lastFrom: { $first: '$from' },
          unread: {
            $sum: {
              $cond: [
                { $and: [{ $eq: ['$from', 'user'] }, { $eq: ['$read_at', null] }] },
                1,
                0,
              ],
            },
          },
        },
      },
      { $sort: { lastAt: -1 } },
      {
        $lookup: {
          from: 'users',
          localField: '_id',
          foreignField: '_id',
          as: 'user',
        },
      },
      { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
    ]);

    const data = rows.map((row) => ({
      userId: String(row._id),
      name: displayName(row.user),
      email: row.user?.email ?? '',
      lastAt: row.lastAt,
      lastFrom: row.lastFrom,
      preview: previewOf(String(row.lastBody || '')),
      unread: row.unread ?? 0,
    }));

    return res.json({ success: true, data });
  } catch (err) {
    console.error('feedback threads:', err);
    return res.status(500).json({ success: false, message: 'Impossible de charger les discussions' });
  }
});

router.get('/threads/:userId', adminOnly, async (req: Request, res: Response) => {
  try {
    if (!mongoose.isValidObjectId(req.params.userId)) {
      return res.status(400).json({ success: false, message: 'Discussion introuvable' });
    }
    const userId = new mongoose.Types.ObjectId(req.params.userId);
    const [user, messages] = await Promise.all([
      User.findById(userId).select('name email').lean(),
      FeedbackMessage.find({ user_id: userId }).sort({ created_at: 1 }).lean(),
    ]);
    if (!user) {
      return res.status(404).json({ success: false, message: 'Utilisateur introuvable' });
    }

    await FeedbackMessage.updateMany(
      { user_id: userId, from: 'user', read_at: null },
      { $set: { read_at: new Date() } }
    );

    return res.json({
      success: true,
      data: {
        user: { id: String(user._id), name: displayName(user), email: user.email },
        messages,
      },
    });
  } catch (err) {
    console.error('feedback thread:', err);
    return res.status(500).json({ success: false, message: 'Impossible de charger la discussion' });
  }
});

router.post('/threads/:userId', adminOnly, feedbackLimiter, async (req: Request, res: Response) => {
  try {
    if (!mongoose.isValidObjectId(req.params.userId)) {
      return res.status(400).json({ success: false, message: 'Discussion introuvable' });
    }
    const { error, value } = bodySchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: 'Écrivez un message (1 à 4000 caractères).',
      });
    }
    const body = cleanBody(value.body);
    if (!body) {
      return res.status(400).json({ success: false, message: 'Le message est vide.' });
    }

    const userId = new mongoose.Types.ObjectId(req.params.userId);
    const customer = await User.findById(userId).select('_id').lean();
    if (!customer) {
      return res.status(404).json({ success: false, message: 'Utilisateur introuvable' });
    }

    const doc = await FeedbackMessage.create({
      user_id: userId,
      author_id: req.user!._id,
      from: 'admin',
      body,
    });

    void notifyUserOfAdminReply({
      userId: String(userId),
      preview: previewOf(body),
    });

    return res.status(201).json({ success: true, data: doc });
  } catch (err) {
    console.error('feedback reply:', err);
    return res.status(500).json({ success: false, message: 'Réponse impossible' });
  }
});

export default router;
