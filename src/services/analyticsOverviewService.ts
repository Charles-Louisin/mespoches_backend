import { Types } from 'mongoose'
import Transaction from '../models/Transaction'
import Wallet from '../models/Wallet'
import Budget from '../models/Budget'
import SavingsGoal from '../models/SavingsGoal'
import PlannedExpense from '../models/PlannedExpense'
import { getTotalSavings } from '../utils/savingsAllocation'

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

function entityId(value: unknown): string {
  if (!value) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'object' && '_id' in value) return String((value as { _id: unknown })._id)
  return String(value)
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
  const [incomeTransactions, expenseTransactions] = await Promise.all([
    Transaction.find({ user_id: userId, type: 'income', date: { $gte: start, $lte: end } }),
    Transaction.find({ user_id: userId, type: 'expense', date: { $gte: start, $lte: end } }),
  ])
  const totalIncome = incomeTransactions.reduce((sum, t) => sum + t.amount, 0)
  const totalExpense = expenseTransactions.reduce((sum, t) => sum + t.amount, 0)
  return {
    month,
    year,
    totalIncome,
    totalExpense,
    balance: totalIncome - totalExpense,
    incomeCount: incomeTransactions.length,
    expenseCount: expenseTransactions.length,
  }
}

export async function getCategoryStats(
  userId: Types.ObjectId,
  type: 'income' | 'expense',
  start: Date,
  end: Date
): Promise<CategoryStat[]> {
  const transactions = await Transaction.find({
    user_id: userId,
    type,
    category_id: { $ne: null },
    date: { $gte: start, $lte: end },
  }).populate('category_id')

  const map: Record<string, CategoryStat> = {}
  for (const tx of transactions) {
    const name = catName(tx.category_id) || 'Sans catégorie'
    if (!map[name]) map[name] = { category: name, total: 0, count: 0 }
    map[name].total += tx.amount
    map[name].count += 1
  }
  return Object.values(map).sort((a, b) => b.total - a.total)
}

export async function buildMonthOverview(userId: Types.ObjectId, year: number, month: number) {
  const { start, end, daysInMonth } = monthRange(year, month)
  const prevMonth = month === 1 ? 12 : month - 1
  const prevYear = month === 1 ? year - 1 : year
  const prev = monthRange(prevYear, prevMonth)
  const now = new Date()
  const isCurrent = year === now.getFullYear() && month === now.getMonth() + 1
  const daysElapsed = isCurrent ? Math.max(1, now.getDate()) : daysInMonth

  const [
    selected,
    previous,
    expenses,
    incomes,
    prevExpenses,
    txs,
    wallets,
    budgets,
    prevBudgets,
    goals,
    totalSavings,
    planned,
  ] = await Promise.all([
    getMonthStats(userId, year, month),
    getMonthStats(userId, prevYear, prevMonth),
    getCategoryStats(userId, 'expense', start, end),
    getCategoryStats(userId, 'income', start, end),
    getCategoryStats(userId, 'expense', prev.start, prev.end),
    Transaction.find({
      user_id: userId,
      date: { $gte: start, $lte: end },
      is_transfer_mirror: { $ne: true },
    })
      .populate('category_id')
      .populate('wallet_id')
      .populate('savings_goal_id')
      .sort({ amount: -1 }),
    Wallet.find({ user_id: userId, is_deleted: { $ne: true } }),
    Budget.find({ user_id: userId, year, month }).populate('category_id'),
    Budget.find({ user_id: userId, year: prevYear, month: prevMonth }).populate('category_id'),
    SavingsGoal.find({ user_id: userId }),
    getTotalSavings(userId),
    PlannedExpense.find({
      user_id: userId,
      status: 'scheduled',
      scheduled_date: { $gte: start, $lte: end },
    }),
  ])

  const incomesTx = txs.filter((t) => t.type === 'income')
  const expensesTx = txs.filter((t) => t.type === 'expense')
  const transfersTx = txs.filter((t) => t.type === 'transfer')
  const savingsTx = txs.filter((t) => Boolean(t.savings_goal_id))

  const activeDays = new Set(txs.map((t) => t.date.toISOString().slice(0, 10))).size
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

  const toHit = (t: (typeof txs)[number]): TxHit => ({
    id: String(t._id),
    description: t.description || catName(t.category_id) || 'Mouvement',
    amount: t.amount,
    date: t.date.toISOString(),
    category: catName(t.category_id),
  })

  const weekday = WEEKDAYS.map((label, i) => ({
    day: label,
    expense: expensesTx.filter((t) => t.date.getDay() === i).reduce((s, t) => s + t.amount, 0),
    income: incomesTx.filter((t) => t.date.getDay() === i).reduce((s, t) => s + t.amount, 0),
    count: txs.filter((t) => t.date.getDay() === i).length,
  }))

  const walletMix = wallets.map((w) => {
    const id = String(w._id)
    const related = txs.filter((t) => entityId(t.wallet_id) === id)
    const income = related.filter((t) => t.type === 'income').reduce((s, t) => s + t.amount, 0)
    const expense = related.filter((t) => t.type === 'expense').reduce((s, t) => s + t.amount, 0)
    return {
      id,
      name: w.name,
      balance: w.current_balance,
      income,
      expense,
      net: income - expense,
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
  for (const t of savingsTx) {
    const goal = t.savings_goal_id as { _id?: unknown } | string | null
    const key = String(typeof goal === 'object' && goal && '_id' in goal ? goal._id : goal)
    monthInByGoal.set(key, (monthInByGoal.get(key) ?? 0) + t.amount)
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
      transferVolume: transfersTx.reduce((s, t) => s + t.amount, 0),
      transferCount: transfersTx.length,
      savingsDeposited: savingsTx.reduce((s, t) => s + t.amount, 0),
      plannedAmount: planned.reduce((s, p) => s + p.amount, 0),
      plannedCount: planned.length,
      budgetsOver: budgetRows.filter((b) => b.over).length,
      budgetsOk: budgetRows.filter((b) => !b.over).length,
    },
    wallets: walletMix,
    budgets: budgetRows,
    savings: savingsRows,
    weekday,
    topExpenses: expensesTx.slice(0, 5).map(toHit),
    topIncomes: incomesTx.slice(0, 5).map(toHit),
    categoryShifts,
    largestExpense: expensesTx[0] ? toHit(expensesTx[0]) : null,
    largestIncome: incomesTx[0] ? toHit(incomesTx[0]) : null,
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
