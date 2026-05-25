import { Router, Request, Response } from 'express';
import { Types } from 'mongoose';
import Transaction from '../models/Transaction';
import { protect, premiumOnly } from '../middleware/auth';

const router = Router();

interface MonthStats {
  month: number;
  year: number;
  totalIncome: number;
  totalExpense: number;
  balance: number;
  incomeCount: number;
  expenseCount: number;
}

interface CategoryStat {
  category: string;
  total: number;
  count: number;
}

function getMonthRange(year: number, month: number): { start: Date; end: Date } {
  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month, 0, 23, 59, 59);
  return { start, end };
}

async function getMonthStats({
  userId,
  year,
  month,
}: {
  userId: Types.ObjectId;
  year: number;
  month: number;
}): Promise<MonthStats> {
  const { start, end } = getMonthRange(year, month);

  const [incomeTransactions, expenseTransactions] = await Promise.all([
    Transaction.find({
      user_id: userId,
      type: 'income',
      date: { $gte: start, $lte: end },
    }),
    Transaction.find({
      user_id: userId,
      type: 'expense',
      date: { $gte: start, $lte: end },
    }),
  ]);

  const totalIncome = incomeTransactions.reduce((sum, t) => sum + t.amount, 0);
  const totalExpense = expenseTransactions.reduce((sum, t) => sum + t.amount, 0);

  return {
    month,
    year,
    totalIncome,
    totalExpense,
    balance: totalIncome - totalExpense,
    incomeCount: incomeTransactions.length,
    expenseCount: expenseTransactions.length,
  };
}

async function getCategoryStats({
  userId,
  type,
  startDate,
  endDate,
}: {
  userId: Types.ObjectId;
  type: 'income' | 'expense';
  startDate?: string;
  endDate?: string;
}): Promise<CategoryStat[]> {
  const query: Record<string, unknown> = {
    user_id: userId,
    type,
    category_id: { $ne: null },
  };

  if (startDate || endDate) {
    query.date = {};
    if (startDate) (query.date as Record<string, Date>).$gte = new Date(startDate);
    if (endDate) (query.date as Record<string, Date>).$lte = new Date(endDate);
  }

  const transactions = await Transaction.find(query).populate('category_id');

  const categoryMap: Record<string, CategoryStat> = {};

  transactions.forEach((transaction) => {
    const category = transaction.category_id as { name?: string } | null;
    if (category?.name) {
      const categoryName = category.name;
      if (!categoryMap[categoryName]) {
        categoryMap[categoryName] = {
          category: categoryName,
          total: 0,
          count: 0,
        };
      }
      categoryMap[categoryName].total += transaction.amount;
      categoryMap[categoryName].count += 1;
    }
  });

  return Object.values(categoryMap).sort((a, b) => b.total - a.total);
}

router.get('/current-month', protect, async (req: Request, res: Response) => {
  try {
    const now = new Date();
    const stats = await getMonthStats({
      userId: req.user!._id,
      year: now.getFullYear(),
      month: now.getMonth() + 1,
    });

    return res.json({ success: true, data: stats });
  } catch (error) {
    console.error('Erreur analytics current-month:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des statistiques',
    });
  }
});

router.get('/month', protect, premiumOnly, async (req: Request, res: Response) => {
  try {
    const year = parseInt(req.query.year as string, 10);
    const month = parseInt(req.query.month as string, 10);

    if (!year || !month || month < 1 || month > 12) {
      return res.status(400).json({
        success: false,
        message: 'Paramètres invalides (year, month)',
      });
    }

    const stats = await getMonthStats({ userId: req.user!._id, year, month });
    return res.json({ success: true, data: stats });
  } catch (error) {
    console.error('Erreur analytics month:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des statistiques du mois',
    });
  }
});

router.get('/month-comparison', protect, premiumOnly, async (req: Request, res: Response) => {
  try {
    const year = parseInt(req.query.year as string, 10);
    const month = parseInt(req.query.month as string, 10);

    if (!year || !month || month < 1 || month > 12) {
      return res.status(400).json({
        success: false,
        message: 'Paramètres invalides (year, month)',
      });
    }

    const prevMonth = month === 1 ? 12 : month - 1;
    const prevYear = month === 1 ? year - 1 : year;

    const [selected, previous] = await Promise.all([
      getMonthStats({ userId: req.user!._id, year, month }),
      getMonthStats({ userId: req.user!._id, year: prevYear, month: prevMonth }),
    ]);

    const delta = {
      totalIncome: selected.totalIncome - previous.totalIncome,
      totalExpense: selected.totalExpense - previous.totalExpense,
      balance: selected.balance - previous.balance,
      incomeCount: selected.incomeCount - previous.incomeCount,
      expenseCount: selected.expenseCount - previous.expenseCount,
    };

    const percent = {
      totalIncome:
        previous.totalIncome === 0
          ? null
          : (delta.totalIncome / previous.totalIncome) * 100,
      totalExpense:
        previous.totalExpense === 0
          ? null
          : (delta.totalExpense / previous.totalExpense) * 100,
      balance:
        previous.balance === 0 ? null : (delta.balance / previous.balance) * 100,
    };

    return res.json({
      success: true,
      data: { selected, previous, delta, percent },
    });
  } catch (error) {
    console.error('Erreur analytics month-comparison:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de la comparaison des mois',
    });
  }
});

router.get('/expenses-by-category', protect, premiumOnly, async (req: Request, res: Response) => {
  try {
    const { startDate, endDate } = req.query;
    const stats = await getCategoryStats({
      userId: req.user!._id,
      type: 'expense',
      startDate: typeof startDate === 'string' ? startDate : undefined,
      endDate: typeof endDate === 'string' ? endDate : undefined,
    });

    return res.json({
      success: true,
      count: stats.length,
      data: stats,
    });
  } catch (error) {
    console.error('Erreur analytics expenses-by-category:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des dépenses par catégorie',
    });
  }
});

router.get('/incomes-by-category', protect, premiumOnly, async (req: Request, res: Response) => {
  try {
    const { startDate, endDate } = req.query;
    const stats = await getCategoryStats({
      userId: req.user!._id,
      type: 'income',
      startDate: typeof startDate === 'string' ? startDate : undefined,
      endDate: typeof endDate === 'string' ? endDate : undefined,
    });

    return res.json({
      success: true,
      count: stats.length,
      data: stats,
    });
  } catch (error) {
    console.error('Erreur analytics incomes-by-category:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des revenus par catégorie',
    });
  }
});

export default router;
