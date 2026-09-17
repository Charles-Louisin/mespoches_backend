import { Types } from 'mongoose'
import Transaction from '../models/Transaction'
import Wallet from '../models/Wallet'
import Budget from '../models/Budget'
import SavingsGoal from '../models/SavingsGoal'
import PlannedExpense from '../models/PlannedExpense'
import { getTotalSavings } from '../utils/savingsAllocation'
import { SAVINGS_LIST_SELECT, WALLET_LIST_SELECT } from '../utils/projections'

export type MonthStats = {
  month: number
  year: number
  totalIncome: number
  totalExpense: number
  balance: number
  incomeCount: number
  expenseCount: number
}

export type CategoryStat = {
  category: string
  total: number
  count: number
}

export type TxHit = {
  id: string
  description: string
  amount: number
  date: string
  category: string | null
}

const WEEKDAYS = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam']

function monthRange(year: number, month: number) {
  const start = new Date(year, month - 1, 1)
  const end = new Date(year, month, 0, 23, 59, 59, 999)
  return { start, end, daysInMonth: end.getDate() }
}

function catName(value: unknown): string | null {
  if (value && typeof value === 'object' && 'name' in value) {
    const name = (value as { name?: string }).name
    return name ? String(name) : null
  }
  return null
}

export async function getMonthStats(
  userId: Types.ObjectId,
  year: number,
  month: number
): Promise<MonthStats> {
  const { start, end } = monthRange(year, month)
  const rows = await Transaction.aggregate<{ _id: string; total: number; count: number }>([
    {
      $match: {
        user_id: userId,
        type: { $in: ['income', 'expense'] },
        date: { $gte: start, $lte: end },
      },
    },
    { $group: { _id: '$type', total: { $sum: '$amount' }, count: { $sum: 1 } } },
  ])
  const income = rows.find((r) => r._id === 'income')
  const expense = rows.find((r) => r._id === 'expense')
  const totalIncome = income?.total ?? 0
  const totalExpense = expense?.total ?? 0
  return {
    month,
    year,
    totalIncome,
    totalExpense,
    balance: totalIncome - totalExpense,
    incomeCount: income?.count ?? 0,
    expenseCount: expense?.count ?? 0,
  }
}

export async function getCategoryStats(
  userId: Types.ObjectId,
  type: 'income' | 'expense',
  start: Date,
  end: Date
): Promise<CategoryStat[]> {
  const rows = await Transaction.aggregate<{ category: string; total: number; count: number }>([
    {
      $match: {
        user_id: userId,
        type,
        category_id: { $ne: null },
        date: { $gte: start, $lte: end },
      },
    },
    {
      $group: {
        _id: '$category_id',
        total: { $sum: '$amount' },
        count: { $sum: 1 },
      },
    },
    {
      $lookup: {
        from: 'categories',
        localField: '_id',
        foreignField: '_id',
        as: 'cat',
      },
    },
    { $unwind: { path: '$cat', preserveNullAndEmptyArrays: true } },
    {
      $project: {
        _id: 0,
        category: { $ifNull: ['$cat.name', 'Sans catégorie'] },
        total: 1,
        count: 1,
      },
    },
    { $sort: { total: -1 } },
  ])
  return rows
}

function toHitFromLean(t: {
  _id: unknown
  description?: string
  amount: number
  date: Date
  category_id?: unknown
}): TxHit {
  return {
    id: String(t._id),
    description: t.description || catName(t.category_id) || 'Mouvement',
    amount: t.amount,
    date: new Date(t.date).toISOString(),
    category: catName(t.category_id),
  }
}

async function topHits(
  userId: Types.ObjectId,
  type: 'income' | 'expense',
  start: Date,
  end: Date
): Promise<TxHit[]> {
  const rows = await Transaction.find({
    user_id: userId,
    type,
    date: { $gte: start, $lte: end },
  })
    .select('description amount date category_id')
    .populate('category_id', 'name')
    .sort({ amount: -1 })
    .limit(5)
    .lean()
  return rows.map(toHitFromLean)
}

export async function buildMonthOverview(userId: Types.ObjectId, year: number, month: number) {
  const { start, end, daysInMonth } = monthRange(year, month)
  const prevMonth = month === 1 ? 12 : month - 1
  const prevYear = month === 1 ? year - 1 : year
  const prev = monthRange(prevYear, prevMonth)
  const now = new Date()
  const isCurrent = year === now.getFullYear() && month === now.getMonth() + 1
  const daysElapsed = isCurrent ? Math.max(1, now.getDate()) : daysInMonth

  const matchMonth = {
    user_id: userId,
    date: { $gte: start, $lte: end },
    is_transfer_mirror: { $ne: true },
  }

  const [
    selected,
    previous,
    expenses,
    incomes,
    prevExpenses,
    weekdayRaw,
    walletFlow,
    transferAgg,
    savingsGoalAgg,
    activeDaysAgg,
    topExpenses,
    topIncomes,
    wallets,
    budgets,
    _prevBudgets,
    goals,
    totalSavings,
    planned,
  ] = await Promise.all([
    getMonthStats(userId, year, month),
    getMonthStats(userId, prevYear, prevMonth),
    getCategoryStats(userId, 'expense', start, end),
    getCategoryStats(userId, 'income', start, end),
    getCategoryStats(userId, 'expense', prev.start, prev.end),
    Transaction.aggregate<{ _id: { dow: number; type: string }; total: number; count: number }>([
      { $match: matchMonth },
      {
        $group: {
          _id: { dow: { $dayOfWeek: '$date' }, type: '$type' },
          total: { $sum: '$amount' },
          count: { $sum: 1 },
        },
      },
    ]),
    Transaction.aggregate<{ _id: { wallet: Types.ObjectId; type: string }; total: number }>([
      {
        $match: {
          ...matchMonth,
          type: { $in: ['income', 'expense'] },
          wallet_id: { $ne: null },
        },
      },
      { $group: { _id: { wallet: '$wallet_id', type: '$type' }, total: { $sum: '$amount' } } },
    ]),
    Transaction.aggregate<{ volume: number; count: number }>([
      { $match: { ...matchMonth, type: 'transfer' } },
      { $group: { _id: null, volume: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]),
    Transaction.aggregate<{ _id: Types.ObjectId; total: number }>([
      { $match: { ...matchMonth, savings_goal_id: { $ne: null } } },
      { $group: { _id: '$savings_goal_id', total: { $sum: '$amount' } } },
    ]),
    Transaction.aggregate<{ n: number }>([
      { $match: matchMonth },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$date' } } } },
      { $count: 'n' },
    ]),
    topHits(userId, 'expense', start, end),
    topHits(userId, 'income', start, end),
    Wallet.find({ user_id: userId, is_deleted: { $ne: true } }).select(WALLET_LIST_SELECT).lean(),
    Budget.find({ user_id: userId, year, month }).populate('category_id', 'name').lean(),
    Budget.find({ user_id: userId, year: prevYear, month: prevMonth }).populate('category_id', 'name').lean(),
    SavingsGoal.find({ user_id: userId }).select(SAVINGS_LIST_SELECT).lean(),
    getTotalSavings(userId),
    PlannedExpense.find({
      user_id: userId,
      status: 'scheduled',
      scheduled_date: { $gte: start, $lte: end },
    })
      .select('amount')
      .lean(),
  ])

  const activeDays = activeDaysAgg[0]?.n ?? 0
  const savingsRate = selected.totalIncome > 0 ? selected.balance / selected.totalIncome : null
  const expenseRatio = selected.totalIncome > 0 ? selected.totalExpense / selected.totalIncome : null
  const dailyExpenseAvg = selected.totalExpense / daysElapsed
  const dailyIncomeAvg = selected.totalIncome / daysElapsed
  const avgExpenseTicket =
    selected.expenseCount > 0 ? selected.totalExpense / selected.expenseCount : 0
  const avgIncomeTicket =
    selected.incomeCount > 0 ? selected.totalIncome / selected.incomeCount : 0
  const projectedExpense = isCurrent ? dailyExpenseAvg * daysInMonth : selected.totalExpense
  const cash = wallets.reduce((s, w) => s + (w.current_balance || 0), 0)
  const runwayDays = dailyExpenseAvg > 0 ? Math.floor(cash / dailyExpenseAvg) : null

  const weekday = WEEKDAYS.map((label, i) => {
    const mongoDow = i + 1
    const expense = weekdayRaw.find((r) => r._id.dow === mongoDow && r._id.type === 'expense')
    const income = weekdayRaw.find((r) => r._id.dow === mongoDow && r._id.type === 'income')
    const count = weekdayRaw
      .filter((r) => r._id.dow === mongoDow)
      .reduce((s, r) => s + r.count, 0)
    return {
      day: label,
      expense: expense?.total ?? 0,
      income: income?.total ?? 0,
      count,
    }
  })

  const flowMap = new Map<string, { income: number; expense: number }>()
  for (const row of walletFlow) {
    const id = String(row._id.wallet)
    const cur = flowMap.get(id) || { income: 0, expense: 0 }
    if (row._id.type === 'income') cur.income = row.total
    if (row._id.type === 'expense') cur.expense = row.total
    flowMap.set(id, cur)
  }

  const walletMix = wallets.map((w) => {
    const id = String(w._id)
    const flow = flowMap.get(id) || { income: 0, expense: 0 }
    return {
      id,
      name: w.name,
      balance: w.current_balance,
      income: flow.income,
      expense: flow.expense,
      net: flow.income - flow.expense,
    }
  })

  const spentByCat = new Map<string, number>()
  for (const row of expenses) spentByCat.set(row.category, row.total)
  const prevSpentByCat = new Map<string, number>()
  for (const row of prevExpenses) prevSpentByCat.set(row.category, row.total)

  const budgetRows = budgets.map((b) => {
    const name = catName(b.category_id) || 'Budget'
    const spent = spentByCat.get(name) ?? 0
    const prevSpent = prevSpentByCat.get(name) ?? 0
    const percent = b.limit_amount > 0 ? (spent / b.limit_amount) * 100 : 0
    return {
      id: String(b._id),
      category: name,
      limit: b.limit_amount,
      spent,
      remaining: Math.max(0, b.limit_amount - spent),
      percent,
      over: spent > b.limit_amount,
      vsPrevious: spent - prevSpent,
    }
  })

  const monthInByGoal = new Map<string, number>()
  for (const row of savingsGoalAgg) {
    monthInByGoal.set(String(row._id), row.total)
  }

  const savingsRows = goals.map((g) => {
    const current = g.saved_amount ?? 0
    const monthIn = monthInByGoal.get(String(g._id)) ?? 0
    const remaining = Math.max(0, g.target_amount - current)
    const progress = g.target_amount > 0 ? Math.min(100, (current / g.target_amount) * 100) : 0
    let onTrack: boolean | null = null
    if (g.deadline) {
      const leftMs = new Date(g.deadline).getTime() - now.getTime()
      const monthsLeft = Math.max(1, leftMs / (30.44 * 24 * 3600 * 1000))
      const neededPerMonth = remaining / monthsLeft
      onTrack = monthIn >= neededPerMonth * 0.8 || remaining === 0
    }
    return {
      id: String(g._id),
      title: g.title,
      current,
      target: g.target_amount,
      remaining,
      progress,
      monthIn,
      deadline: g.deadline ? new Date(g.deadline).toISOString() : null,
      onTrack,
    }
  })

  const categoryShifts = expenses.slice(0, 8).map((row) => {
    const prevTotal = prevSpentByCat.get(row.category) ?? 0
    return {
      category: row.category,
      current: row.total,
      previous: prevTotal,
      delta: row.total - prevTotal,
    }
  })

  const delta = {
    totalIncome: selected.totalIncome - previous.totalIncome,
    totalExpense: selected.totalExpense - previous.totalExpense,
    balance: selected.balance - previous.balance,
    incomeCount: selected.incomeCount - previous.incomeCount,
    expenseCount: selected.expenseCount - previous.expenseCount,
  }
  const percent = {
    totalIncome: previous.totalIncome === 0 ? null : (delta.totalIncome / previous.totalIncome) * 100,
    totalExpense: previous.totalExpense === 0 ? null : (delta.totalExpense / previous.totalExpense) * 100,
    balance: previous.balance === 0 ? null : (delta.balance / Math.abs(previous.balance)) * 100,
  }

  return {
    selected,
    previous,
    comparison: { selected, previous, delta, percent },
    expenses,
    incomes,
    kpis: {
      savingsRate,
      expenseRatio,
      dailyExpenseAvg,
      dailyIncomeAvg,
      avgExpenseTicket,
      avgIncomeTicket,
      activeDays,
      daysInMonth,
      daysElapsed,
      isCurrent,
      projectedExpense,
      cash,
      totalSavings,
      runwayDays,
      transferVolume: transferAgg[0]?.volume ?? 0,
      transferCount: transferAgg[0]?.count ?? 0,
      savingsDeposited: savingsGoalAgg.reduce((s, r) => s + r.total, 0),
      plannedAmount: planned.reduce((s, p) => s + p.amount, 0),
      plannedCount: planned.length,
      budgetsOver: budgetRows.filter((b) => b.over).length,
      budgetsOk: budgetRows.filter((b) => !b.over).length,
    },
    wallets: walletMix,
    budgets: budgetRows,
    savings: savingsRows,
    weekday,
    topExpenses,
    topIncomes,
    categoryShifts,
    largestExpense: topExpenses[0] ?? null,
    largestIncome: topIncomes[0] ?? null,
  }
}

export function briefingSnapshot(overview: Awaited<ReturnType<typeof buildMonthOverview>>) {
  return {
    month: overview.selected,
    previous: overview.previous,
    kpis: overview.kpis,
    topExpenseCategories: overview.expenses.slice(0, 5),
    budgets: overview.budgets.map((b) => ({
      category: b.category,
      percent: Math.round(b.percent),
      over: b.over,
    })),
    savings: overview.savings.map((g) => ({
      title: g.title,
      progress: Math.round(g.progress),
      monthIn: g.monthIn,
      onTrack: g.onTrack,
    })),
    largestExpense: overview.largestExpense,
  }
}
