import { Router, Request, Response } from 'express';
import { protect, premiumOnly } from '../middleware/auth';
import { aiService, formatAiError } from '../services/ai';
import {
  buildMonthOverview,
  briefingSnapshot,
  getCategoryStats,
  getMonthStats,
} from '../services/analyticsOverviewService';
import { aiScanLimiter } from '../utils/security';

const router = Router();

function parseYearMonth(req: Request): { year: number; month: number } | null {
  const year = parseInt(req.query.year as string, 10);
  const month = parseInt(req.query.month as string, 10);
  if (!year || !month || month < 1 || month > 12) return null;
  return { year, month };
}

router.get('/current-month', protect, async (req: Request, res: Response) => {
  try {
    const now = new Date();
    const stats = await getMonthStats(req.user!._id, now.getFullYear(), now.getMonth() + 1);
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
    const parsed = parseYearMonth(req);
    if (!parsed) {
      return res.status(400).json({
        success: false,
        message: 'Paramètres invalides (year, month)',
      });
    }
    const stats = await getMonthStats(req.user!._id, parsed.year, parsed.month);
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
    const parsed = parseYearMonth(req);
    if (!parsed) {
      return res.status(400).json({
        success: false,
        message: 'Paramètres invalides (year, month)',
      });
    }
    const prevMonth = parsed.month === 1 ? 12 : parsed.month - 1;
    const prevYear = parsed.month === 1 ? parsed.year - 1 : parsed.year;
    const [selected, previous] = await Promise.all([
      getMonthStats(req.user!._id, parsed.year, parsed.month),
      getMonthStats(req.user!._id, prevYear, prevMonth),
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
        previous.totalIncome === 0 ? null : (delta.totalIncome / previous.totalIncome) * 100,
      totalExpense:
        previous.totalExpense === 0 ? null : (delta.totalExpense / previous.totalExpense) * 100,
      balance: previous.balance === 0 ? null : (delta.balance / previous.balance) * 100,
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
    const startDate = typeof req.query.startDate === 'string' ? new Date(req.query.startDate) : undefined;
    const endDate = typeof req.query.endDate === 'string' ? new Date(req.query.endDate) : undefined;
    const now = new Date();
    const start = startDate && !Number.isNaN(startDate.getTime()) ? startDate : new Date(now.getFullYear(), now.getMonth(), 1);
    const end = endDate && !Number.isNaN(endDate.getTime()) ? endDate : new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
    const stats = await getCategoryStats(req.user!._id, 'expense', start, end);
    return res.json({ success: true, count: stats.length, data: stats });
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
    const startDate = typeof req.query.startDate === 'string' ? new Date(req.query.startDate) : undefined;
    const endDate = typeof req.query.endDate === 'string' ? new Date(req.query.endDate) : undefined;
    const now = new Date();
    const start = startDate && !Number.isNaN(startDate.getTime()) ? startDate : new Date(now.getFullYear(), now.getMonth(), 1);
    const end = endDate && !Number.isNaN(endDate.getTime()) ? endDate : new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
    const stats = await getCategoryStats(req.user!._id, 'income', start, end);
    return res.json({ success: true, count: stats.length, data: stats });
  } catch (error) {
    console.error('Erreur analytics incomes-by-category:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des revenus par catégorie',
    });
  }
});

router.get('/overview', protect, premiumOnly, async (req: Request, res: Response) => {
  try {
    const parsed = parseYearMonth(req);
    if (!parsed) {
      return res.status(400).json({
        success: false,
        message: 'Paramètres invalides (year, month)',
      });
    }
    const data = await buildMonthOverview(req.user!._id, parsed.year, parsed.month);
    return res.json({ success: true, data });
  } catch (error) {
    console.error('Erreur analytics overview:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de l’analyse du mois',
    });
  }
});

router.get('/briefing', protect, premiumOnly, aiScanLimiter, async (req: Request, res: Response) => {
  try {
    const parsed = parseYearMonth(req);
    if (!parsed) {
      return res.status(400).json({
        success: false,
        message: 'Paramètres invalides (year, month)',
      });
    }
    const overview = await buildMonthOverview(req.user!._id, parsed.year, parsed.month);
    const briefing = await aiService.analyzeMonthBriefing(briefingSnapshot(overview));
    return res.json({ success: true, data: briefing });
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: formatAiError(error),
    });
  }
});

export default router;
