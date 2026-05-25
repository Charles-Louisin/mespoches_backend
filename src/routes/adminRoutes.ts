import { Router, Request, Response } from 'express';
import User from '../models/User';
import Wallet from '../models/Wallet';
import Transaction from '../models/Transaction';
import { protect, adminOnly } from '../middleware/auth';

const router = Router();

router.get('/users', protect, adminOnly, async (_req: Request, res: Response) => {
  try {
    const users = await User.find().select('-password').lean();

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
        walletsCount: w?.walletsCount || 0,
        transactionsCount: t?.transactionsCount || 0,
        totalIncome: t?.totalIncome || 0,
        totalExpense: t?.totalExpense || 0,
      };
    });

    return res.json({
      success: true,
      count: result.length,
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

    const user = await User.findById(userId).select('-password').lean();
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Utilisateur introuvable',
      });
    }

    const [wallets, transactions] = await Promise.all([
      Wallet.find({ user_id: userId }).lean(),
      Transaction.find({ user_id: userId })
        .populate('wallet_id')
        .populate('destination_wallet_id')
        .populate('category_id')
        .sort({ date: -1 })
        .limit(200)
        .lean(),
    ]);

    return res.json({
      success: true,
      data: { user, wallets, transactions },
    });
  } catch (error) {
    console.error('Erreur admin user detail:', error);
    return res.status(500).json({
      success: false,
      message: "Erreur lors de la récupération des informations de l'utilisateur",
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
      const days = parseInt(req.query.days as string, 10) || 30;

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
