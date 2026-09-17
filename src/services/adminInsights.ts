import User from '../models/User';
import Wallet from '../models/Wallet';
import Transaction from '../models/Transaction';
import PendingTransaction from '../models/PendingTransaction';
import Category from '../models/Category';
import Budget from '../models/Budget';
import SavingsGoal from '../models/SavingsGoal';
import RecurringTransaction from '../models/RecurringTransaction';
import PlannedExpense from '../models/PlannedExpense';
import SubscriptionPayment from '../models/SubscriptionPayment';
import SmsHabit from '../models/SmsHabit';
import AnalyticsEvent from '../models/AnalyticsEvent';

function daysAgo(n: number): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return d;
}

function fillDays(
  rows: { date: string; [k: string]: number | string }[],
  days: number,
  keys: string[]
): { date: string; [k: string]: number | string }[] {
  const map = new Map(rows.map((r) => [r.date, r]));
  const out: { date: string; [k: string]: number | string }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = daysAgo(i).toISOString().slice(0, 10);
    const prev = map.get(d);
    const row: { date: string; [k: string]: number | string } = { date: d };
    for (const k of keys) row[k] = typeof prev?.[k] === 'number' ? (prev[k] as number) : 0;
    out.push(row);
  }
  return out;
}

export async function buildAdminInsights(days = 30) {
  const now = new Date();
  const since = daysAgo(days);
  const d7 = daysAgo(7);

  const [
    census,
    signupsRaw,
    dauRaw,
    txTypes,
    volumeRaw,
    topCatsRaw,
    walletsByCcy,
    pendingStatus,
    pendingSource,
    pendingOperator,
    captureUsers,
    productCounts,
    revenueRaw,
    walletUserIds,
    txUserIds,
    pendingNowIds,
    errorUserIds,
    paywallUserIds,
    failedPayIds,
  ] = await Promise.all([
    User.aggregate([
      {
        $facet: {
          total: [{ $count: 'n' }],
          verified: [{ $match: { emailVerified: true } }, { $count: 'n' }],
          premium: [
            { $match: { plan: 'premium', premiumUntil: { $gt: now } } },
            { $count: 'n' },
          ],
          trial: [
            {
              $match: {
                plan: 'premium',
                premiumSource: 'trial',
                premiumUntil: { $gt: now },
              },
            },
            { $count: 'n' },
          ],
          google: [{ $match: { authProvider: { $in: ['google', 'both'] } } }, { $count: 'n' }],
          signups7: [{ $match: { created_at: { $gte: d7 } } }, { $count: 'n' }],
          signupsPeriod: [{ $match: { created_at: { $gte: since } } }, { $count: 'n' }],
          mau: [{ $match: { lastLoginAt: { $gte: since } } }, { $count: 'n' }],
          wau: [{ $match: { lastLoginAt: { $gte: d7 } } }, { $count: 'n' }],
          loggedIn: [{ $match: { lastLoginAt: { $ne: null } } }, { $count: 'n' }],
          verifiedNoLogin: [
            { $match: { emailVerified: true, lastLoginAt: null } },
            { $count: 'n' },
          ],
        },
      },
    ]),
    User.aggregate([
      { $match: { created_at: { $gte: since } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$created_at' } },
          count: { $sum: 1 },
        },
      },
      { $project: { _id: 0, date: '$_id', count: 1 } },
      { $sort: { date: 1 } },
    ]),
    User.aggregate([
      { $unwind: '$loginHistory' },
      { $match: { 'loginHistory.date': { $gte: since } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$loginHistory.date' } },
          users: { $addToSet: '$_id' },
        },
      },
      { $project: { _id: 0, date: '$_id', activeUsers: { $size: '$users' } } },
      { $sort: { date: 1 } },
    ]),
    Transaction.aggregate([
      { $match: { created_at: { $gte: since }, is_transfer_mirror: { $ne: true } } },
      { $group: { _id: '$type', count: { $sum: 1 }, volume: { $sum: '$amount' } } },
    ]),
    Transaction.aggregate([
      { $match: { created_at: { $gte: since }, is_transfer_mirror: { $ne: true } } },
      {
        $group: {
          _id: {
            day: { $dateToString: { format: '%Y-%m-%d', date: '$created_at' } },
            type: '$type',
          },
          volume: { $sum: '$amount' },
        },
      },
    ]),
    Transaction.aggregate([
      {
        $match: {
          created_at: { $gte: since },
          is_transfer_mirror: { $ne: true },
          category_id: { $ne: null },
        },
      },
      {
        $group: {
          _id: { cat: '$category_id', type: '$type' },
          count: { $sum: 1 },
          volume: { $sum: '$amount' },
        },
      },
      { $sort: { volume: -1 } },
      { $limit: 8 },
      {
        $lookup: {
          from: 'categories',
          localField: '_id.cat',
          foreignField: '_id',
          as: 'cat',
        },
      },
      {
        $project: {
          _id: 0,
          type: '$_id.type',
          name: { $ifNull: [{ $arrayElemAt: ['$cat.name', 0] }, 'Sans nom'] },
          count: 1,
          volume: 1,
        },
      },
    ]),
    Wallet.aggregate([
      { $match: { is_deleted: { $ne: true } } },
      {
        $group: {
          _id: '$currency',
          count: { $sum: 1 },
          balance: { $sum: '$current_balance' },
        },
      },
    ]),
    PendingTransaction.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    PendingTransaction.aggregate([{ $group: { _id: '$source', count: { $sum: 1 } } }]),
    PendingTransaction.aggregate([{ $group: { _id: '$operator', count: { $sum: 1 } } }]),
    PendingTransaction.aggregate([
      {
        $group: {
          _id: '$user_id',
          validated: { $max: { $cond: [{ $eq: ['$status', 'validated'] }, 1, 0] } },
        },
      },
      {
        $group: {
          _id: null,
          capturers: { $sum: 1 },
          validators: { $sum: '$validated' },
        },
      },
    ]),
    Promise.all([
      Category.countDocuments(),
      Budget.countDocuments(),
      SavingsGoal.countDocuments(),
      RecurringTransaction.countDocuments(),
      PlannedExpense.countDocuments(),
      SmsHabit.countDocuments(),
      Wallet.countDocuments({ is_deleted: { $ne: true } }),
    ]),
    SubscriptionPayment.aggregate([
      {
        $group: {
          _id: { status: '$status', period: '$period' },
          count: { $sum: 1 },
          amount: { $sum: '$amount' },
        },
      },
    ]),
    Wallet.distinct('user_id', { is_deleted: { $ne: true } }),
    Transaction.distinct('user_id', { is_transfer_mirror: { $ne: true } }),
    PendingTransaction.distinct('user_id', { status: 'pending' }),
    AnalyticsEvent.distinct('user_id', { name: 'error', created_at: { $gte: since } }),
    AnalyticsEvent.distinct('user_id', { name: 'paywall', created_at: { $gte: since } }),
    SubscriptionPayment.distinct('user_id', { status: 'failed' }),
  ]);

  const pick = (arr: { n: number }[] | undefined) => arr?.[0]?.n ?? 0;
  const c = census[0] || {};
  const mau = pick(c.mau);
  const wau = pick(c.wau);
  const premium = pick(c.premium);
  const trial = pick(c.trial);
  const total = pick(c.total);
  const verified = pick(c.verified);
  const paidPremium = Math.max(0, premium - trial);
  const capturers = (captureUsers as { capturers?: number; validators?: number }[])[0]?.capturers || 0;
  const validators = (captureUsers as { capturers?: number; validators?: number }[])[0]?.validators || 0;

  const txMap: Record<string, { count: number; volume: number }> = {};
  for (const t of txTypes as { _id: string; count: number; volume: number }[]) {
    txMap[t._id] = { count: t.count, volume: t.volume };
  }

  const volDays: Record<string, { income: number; expense: number }> = {};
  for (const row of volumeRaw as { _id: { day: string; type: string }; volume: number }[]) {
    const day = row._id.day;
    if (!volDays[day]) volDays[day] = { income: 0, expense: 0 };
    if (row._id.type === 'income') volDays[day].income += row.volume;
    if (row._id.type === 'expense') volDays[day].expense += row.volume;
  }

  const pendingMap: Record<string, number> = {};
  for (const s of pendingStatus as { _id: string; count: number }[]) pendingMap[s._id] = s.count;
  const pendingTotal =
    (pendingMap.pending || 0) + (pendingMap.validated || 0) + (pendingMap.rejected || 0);
  const decided = (pendingMap.validated || 0) + (pendingMap.rejected || 0);

  let completedAmount = 0;
  let completedCount = 0;
  let failedCount = 0;
  let payPending = 0;
  let monthlyPaid = 0;
  let yearlyPaid = 0;
  for (const r of revenueRaw as {
    _id: { status: string; period: string };
    count: number;
    amount: number;
  }[]) {
    if (r._id.status === 'completed') {
      completedAmount += r.amount;
      completedCount += r.count;
      if (r._id.period === 'monthly') monthlyPaid += r.count;
      if (r._id.period === 'yearly') yearlyPaid += r.count;
    } else if (r._id.status === 'failed') failedCount += r.count;
    else if (r._id.status === 'pending') payPending += r.count;
  }

  const [categories, budgets, savingsGoals, recurring, planned, smsHabits, liveWallets] =
    productCounts as number[];

  const loggedIn = pick(c.loggedIn);
  const [noWallet, noTx, captureStuckN, incomeUsers, expenseUsers, paidAmongPaywall] =
    await Promise.all([
      User.countDocuments({ lastLoginAt: { $ne: null }, _id: { $nin: walletUserIds } }),
      User.countDocuments({ _id: { $in: walletUserIds, $nin: txUserIds } }),
      PendingTransaction.aggregate([
        {
          $group: {
            _id: '$user_id',
            pending: { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] } },
            validated: { $sum: { $cond: [{ $eq: ['$status', 'validated'] }, 1, 0] } },
          },
        },
        { $match: { pending: { $gt: 0 }, validated: 0 } },
        { $count: 'n' },
      ]).then((r) => (r[0] as { n?: number } | undefined)?.n || 0),
      Transaction.distinct('user_id', {
        type: 'income',
        created_at: { $gte: since },
        is_transfer_mirror: { $ne: true },
      }).then((a) => a.length),
      Transaction.distinct('user_id', {
        type: 'expense',
        created_at: { $gte: since },
        is_transfer_mirror: { $ne: true },
      }).then((a) => a.length),
      User.countDocuments({
        _id: { $in: paywallUserIds },
        plan: 'premium',
        premiumSource: 'paid',
        premiumUntil: { $gt: now },
      }),
    ]);

  const paywallStuck = Math.max(0, (paywallUserIds as unknown[]).length - paidAmongPaywall);

  return {
    periodDays: days,
    kpis: {
      mau,
      wau,
      stickiness: mau ? Math.round((wau / mau) * 1000) / 10 : 0,
      signups7d: pick(c.signups7),
      premiumActive: premium,
      trialActive: trial,
      paidPremium,
      validationRate: decided ? Math.round((pendingMap.validated / decided) * 1000) / 10 : 0,
      expenseVolume30d: txMap.expense?.volume || 0,
      revenueCompleted: completedAmount,
    },
    funnel: {
      signups: pick(c.signupsPeriod),
      mau,
      capturers,
      validators,
      paid: paidPremium,
    },
    journey: [
      { key: 'registered', title: 'Comptes créés', people: total, stuck: 0, stuckKey: '' },
      {
        key: 'verified',
        title: 'E-mail confirmé',
        people: verified,
        stuck: Math.max(0, total - verified),
        stuckKey: 'unverified',
      },
      {
        key: 'logged_in',
        title: 'Première connexion',
        people: loggedIn,
        stuck: pick(c.verifiedNoLogin),
        stuckKey: 'never_login',
      },
      {
        key: 'has_wallet',
        title: 'Première poche',
        people: (walletUserIds as unknown[]).length,
        stuck: noWallet,
        stuckKey: 'no_wallet',
      },
      {
        key: 'has_tx',
        title: 'Première opération',
        people: (txUserIds as unknown[]).length,
        stuck: noTx,
        stuckKey: 'no_tx',
      },
      {
        key: 'mau',
        title: 'Ouvert l’app récemment',
        people: mau,
        stuck: 0,
        stuckKey: 'inactive',
      },
    ],
    problems: [
      { key: 'unverified', title: 'E-mail non confirmé', people: Math.max(0, total - verified) },
      { key: 'never_login', title: 'Jamais ouverts l’app', people: pick(c.verifiedNoLogin) },
      { key: 'no_wallet', title: 'Connectés sans poche', people: noWallet },
      { key: 'no_tx', title: 'Poche sans opération', people: noTx },
      { key: 'capture_stuck', title: 'Captures jamais validées', people: captureStuckN },
      { key: 'errors', title: 'Erreurs dans l’app', people: (errorUserIds as unknown[]).length },
      { key: 'paywall', title: 'Écran Premium sans paiement', people: paywallStuck },
      { key: 'payment_failed', title: 'Paiement échoué', people: (failedPayIds as unknown[]).length },
    ].filter((p) => p.people > 0 || ['unverified', 'errors', 'capture_stuck'].includes(p.key)),
    wins: [
      { key: 'validators', title: 'Ont validé une capture', people: validators },
      { key: 'has_tx', title: 'Ont une opération', people: (txUserIds as unknown[]).length },
      { key: 'mau', title: 'Ouvert l’app récemment', people: mau },
      { key: 'paid_premium', title: 'Premium payants', people: paidPremium },
    ],
    census: {
      registered: total,
      verified,
      unverified: Math.max(0, total - verified),
      googleAuth: pick(c.google),
      signupsPeriod: pick(c.signupsPeriod),
    },
    series: {
      signups: fillDays(signupsRaw, days, ['count']),
      dau: fillDays(dauRaw, days, ['activeUsers']),
      volume: fillDays(
        Object.entries(volDays).map(([date, v]) => ({ date, ...v })),
        days,
        ['income', 'expense']
      ),
    },
    finance: {
      incomeCount: txMap.income?.count || 0,
      expenseCount: txMap.expense?.count || 0,
      transferCount: txMap.transfer?.count || 0,
      incomeVolume: txMap.income?.volume || 0,
      expenseVolume: txMap.expense?.volume || 0,
      incomeUsers,
      expenseUsers,
      topCategories: topCatsRaw,
      walletsByCurrency: (walletsByCcy as { _id: string; count: number; balance: number }[]).map(
        (w) => ({ currency: w._id || 'XAF', count: w.count, balance: w.balance })
      ),
      liveWallets,
    },
    capture: {
      pending: pendingMap.pending || 0,
      validated: pendingMap.validated || 0,
      rejected: pendingMap.rejected || 0,
      queue: pendingTotal,
      pendingUsers: (pendingNowIds as unknown[]).length,
      bySource: (pendingSource as { _id: string; count: number }[]).map((s) => ({
        source: s._id,
        count: s.count,
      })),
      byOperator: (pendingOperator as { _id: string; count: number }[]).map((s) => ({
        operator: s._id || 'unknown',
        count: s.count,
      })),
    },
    product: { categories, budgets, savingsGoals, recurring, planned, smsHabits },
    revenue: {
      completedAmount,
      completedCount,
      failedCount,
      pendingCount: payPending,
      monthlyPaid,
      yearlyPaid,
    },
  };
}

export async function buildTelemetryOverview(days = 30) {
  const since = daysAgo(days);
  const match = { created_at: { $gte: since } };

  const [totals, byName, byScreen, byDay, byPlatform, byElement, clickCount, viewCount, errorCount, errorUsers, recent] = await Promise.all([
    AnalyticsEvent.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          events: { $sum: 1 },
          users: { $addToSet: '$user_id' },
        },
      },
      { $project: { _id: 0, events: 1, users: { $size: '$users' } } },
    ]),
    AnalyticsEvent.aggregate([
      { $match: match },
      { $group: { _id: '$name', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 12 },
      { $project: { _id: 0, name: '$_id', count: 1 } },
    ]),
    AnalyticsEvent.aggregate([
      { $match: match },
      { $group: { _id: '$screen', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 },
      { $project: { _id: 0, screen: '$_id', count: 1 } },
    ]),
    AnalyticsEvent.aggregate([
      { $match: match },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$created_at' } },
          count: { $sum: 1 },
        },
      },
      { $project: { _id: 0, date: '$_id', count: 1 } },
      { $sort: { date: 1 } },
    ]),
    AnalyticsEvent.aggregate([
      { $match: match },
      { $group: { _id: '$platform', count: { $sum: 1 } } },
      { $project: { _id: 0, platform: '$_id', count: 1 } },
      { $sort: { count: -1 } },
    ]),
    AnalyticsEvent.aggregate([
      { $match: { ...match, 'props.element': { $exists: true, $nin: ['', null] } } },
      { $group: { _id: '$props.element', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 12 },
      { $project: { _id: 0, element: '$_id', count: 1 } },
    ]),
    AnalyticsEvent.countDocuments({ ...match, name: 'click' }),
    AnalyticsEvent.countDocuments({ ...match, name: 'screen_view' }),
    AnalyticsEvent.countDocuments({ ...match, name: 'error' }),
    AnalyticsEvent.distinct('user_id', { ...match, name: 'error' }),
    AnalyticsEvent.find(match)
      .sort({ created_at: -1 })
      .limit(40)
      .populate('user_id', 'email name')
      .lean(),
  ]);

  const named = byName as { name: string; count: number }[];

  return {
    periodDays: days,
    events: totals[0]?.events || 0,
    uniqueUsers: totals[0]?.users || 0,
    clicks: clickCount,
    screenViews: viewCount,
    errors: errorCount,
    errorUsers: (errorUsers as unknown[]).length,
    byName: named,
    byScreen: (byScreen as { screen: string; count: number }[]).filter((s) => s.screen),
    byPlatform: byPlatform as { platform: string; count: number }[],
    byElement: byElement as { element: string; count: number }[],
    byDay: fillDays(byDay as { date: string; count: number }[], days, ['count']),
    recent: (
      recent as {
        name: string;
        screen: string;
        platform: string;
        created_at: Date;
        user_id?: { _id?: unknown; email?: string; name?: string };
      }[]
    ).map((e) => ({
      name: e.name,
      screen: e.screen,
      platform: e.platform,
      at: e.created_at,
      user: e.user_id?.name || e.user_id?.email || '—',
      userId: e.user_id && typeof e.user_id === 'object' && '_id' in e.user_id ? String(e.user_id._id) : '',
    })),
  };
}
