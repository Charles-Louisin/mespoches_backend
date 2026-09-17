import { Router, Request, Response } from 'express';
import User from '../models/User';
import Wallet from '../models/Wallet';
import Transaction from '../models/Transaction';
import PendingTransaction from '../models/PendingTransaction';
import AnalyticsEvent from '../models/AnalyticsEvent';
import { protect, adminOnly } from '../middleware/auth';
import { buildAdminInsights, buildTelemetryOverview } from '../services/adminInsights';
import { listCohort } from '../services/adminCohorts';
import { parseListPage, listMeta } from '../utils/pagination';

const router = Router();

const insightsCache = new Map<string, { at: number; data: unknown }>();
const INSIGHTS_TTL_MS = 30_000;

function cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
  const hit = insightsCache.get(key);
  if (hit && Date.now() - hit.at < ttl) return Promise.resolve(hit.data as T);
  return load().then((data) => {
    insightsCache.set(key, { at: Date.now(), data });
    return data;
  });
}

router.get('/users', protect, adminOnly, async (req: Request, res: Response) => {
  try {
    const page = parseListPage(req.query, 100, 200);
    const users = await User.find()
      .select('-password -loginHistory -verificationCode')
      .sort({ lastLoginAt: -1, created_at: -1 })
      .skip(page.skip)
      .limit(page.limit)
      .lean();

    const userIds = users.map((u) => u._id);

    const [walletStats, transactionStats] = await Promise.all([
      Wallet.aggregate([
        { $match: { user_id: { $in: userIds } } },
        {
          $group: {
            _id: '$user_id',
            walletsCount: { $sum: 1 },
          },
        },
      ]),
      Transaction.aggregate([
        { $match: { user_id: { $in: userIds } } },
        {
          $group: {
            _id: '$user_id',
            transactionsCount: { $sum: 1 },
            totalIncome: {
              $sum: {
                $cond: [{ $eq: ['$type', 'income'] }, '$amount', 0],
              },
            },
            totalExpense: {
              $sum: {
                $cond: [{ $eq: ['$type', 'expense'] }, '$amount', 0],
              },
            },
          },
        },
      ]),
    ]);

    const walletMap = new Map<string, { walletsCount: number }>();
    walletStats.forEach((w: { _id: { toString(): string }; walletsCount: number }) => {
      walletMap.set(w._id.toString(), w);
    });

    const transactionMap = new Map<
      string,
      {
        transactionsCount: number;
        totalIncome: number;
        totalExpense: number;
      }
    >();
    transactionStats.forEach(
      (t: {
        _id: { toString(): string };
        transactionsCount: number;
        totalIncome: number;
        totalExpense: number;
      }) => {
        transactionMap.set(t._id.toString(), t);
      }
    );

    const result = users.map((user) => {
      const w = walletMap.get(user._id.toString());
      const t = transactionMap.get(user._id.toString());

      return {
        id: user._id,
        email: user.email,
        name: user.name,
        role: user.role,
        created_at: user.created_at,
        lastLoginAt: user.lastLoginAt,
        plan: user.plan,
        premiumSource: user.premiumSource,
        emailVerified: user.emailVerified,
        authProvider: user.authProvider,
        walletsCount: w?.walletsCount || 0,
        transactionsCount: t?.transactionsCount || 0,
        totalIncome: t?.totalIncome || 0,
        totalExpense: t?.totalExpense || 0,
      };
    });

    return res.json({
      success: true,
      ...listMeta(page, result.length),
      data: result,
    });
  } catch (error) {
    console.error('Erreur admin users:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des utilisateurs',
    });
  }
});

router.get('/users/:id', protect, adminOnly, async (req: Request, res: Response) => {
  try {
    const userId = req.params.id;

    const user = await User.findById(userId)
      .select('-password -loginHistory -verificationCode')
      .lean();
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Utilisateur introuvable',
      });
    }

    const [wallets, transactions, pending, events] = await Promise.all([
      Wallet.find({ user_id: userId }).select('name currency current_balance is_deleted created_at').lean(),
      Transaction.find({ user_id: userId })
        .select('type amount description date wallet_id category_id')
        .populate('wallet_id', 'name')
        .populate('destination_wallet_id', 'name')
        .populate('category_id', 'name')
        .sort({ date: -1 })
        .limit(100)
        .lean(),
      PendingTransaction.aggregate([
        { $match: { user_id: user._id } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
      AnalyticsEvent.find({ user_id: userId }).sort({ created_at: -1 }).limit(80).lean(),
    ]);

    const pendingByStatus: Record<string, number> = {};
    for (const p of pending as { _id: string; count: number }[]) pendingByStatus[p._id] = p.count;

    return res.json({
      success: true,
      data: {
        user,
        wallets,
        transactions,
        pendingByStatus,
        events: events.map((e) => ({
          name: e.name,
          screen: e.screen,
          props: e.props || {},
          at: e.created_at,
        })),
      },
    });
  } catch (error) {
    console.error('Erreur admin user detail:', error);
    return res.status(500).json({
      success: false,
      message: "Erreur lors de la récupération des informations de l'utilisateur",
    });
  }
});

router.get('/cohorts', protect, adminOnly, async (req: Request, res: Response) => {
  try {
    const days = Math.min(90, Math.max(7, parseInt(String(req.query.days || '30'), 10) || 30));
    const key = String(req.query.key || '')
      .toLowerCase()
      .replace(/[^a-z0-9_:-]/g, '')
      .slice(0, 64);
    if (key.length < 2) {
      return res.status(400).json({ success: false, message: 'Cohorte invalide' });
    }
    const data = await listCohort(key, days);
    return res.json({ success: true, data });
  } catch (error) {
    console.error('Erreur admin cohort:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des personnes',
    });
  }
});

router.get('/insights', protect, adminOnly, async (req: Request, res: Response) => {
  try {
    const days = Math.min(90, Math.max(7, parseInt(String(req.query.days || '30'), 10) || 30));
    const data = await cached(`insights:${days}`, INSIGHTS_TTL_MS, () => buildAdminInsights(days));
    return res.json({ success: true, data });
  } catch (error) {
    console.error('Erreur admin insights:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des insights',
    });
  }
});

router.get('/telemetry', protect, adminOnly, async (req: Request, res: Response) => {
  try {
    const days = Math.min(90, Math.max(7, parseInt(String(req.query.days || '30'), 10) || 30));
    const data = await cached(`telemetry:${days}`, INSIGHTS_TTL_MS, () =>
      buildTelemetryOverview(days)
    );
    return res.json({ success: true, data });
  } catch (error) {
    console.error('Erreur admin telemetry:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération de la télémétrie',
    });
  }
});

router.get('/stats/overview', protect, adminOnly, async (_req: Request, res: Response) => {
  try {
    const [usersCount, walletsCount, transactionsCount] = await Promise.all([
      User.countDocuments(),
      Wallet.countDocuments(),
      Transaction.countDocuments(),
    ]);

    const lastLogins = await User.find({ lastLoginAt: { $ne: null } })
      .sort({ lastLoginAt: -1 })
      .limit(20)
      .select('email name lastLoginAt role')
      .lean();

    return res.json({
      success: true,
      data: {
        usersCount,
        walletsCount,
        transactionsCount,
        lastLogins,
      },
    });
  } catch (error) {
    console.error('Erreur admin stats overview:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des statistiques globales',
    });
  }
});

router.get(
  '/stats/daily-active-users',
  protect,
  adminOnly,
  async (req: Request, res: Response) => {
    try {
      const days = Math.min(90, Math.max(7, parseInt(req.query.days as string, 10) || 30));

      const since = new Date();
      since.setDate(since.getDate() - days);

      const pipeline = [
        { $unwind: '$loginHistory' },
        { $match: { 'loginHistory.date': { $gte: since } } },
        {
          $group: {
            _id: {
              day: {
                $dateToString: { format: '%Y-%m-%d', date: '$loginHistory.date' },
              },
            },
            users: { $addToSet: '$_id' },
          },
        },
        {
          $project: {
            _id: 0,
            date: '$_id.day',
            activeUsers: { $size: '$users' },
          },
        },
        { $sort: { date: 1 as const } },
      ];

      const stats = await User.aggregate(pipeline);

      return res.json({
        success: true,
        count: stats.length,
        data: stats,
      });
    } catch (error) {
      console.error('Erreur admin stats daily-active-users:', error);
      return res.status(500).json({
        success: false,
        message: 'Erreur lors de la récupération des utilisateurs actifs quotidiens',
      });
    }
  }
);

export default router;
