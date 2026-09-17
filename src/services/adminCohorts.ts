import { FilterQuery, Types } from 'mongoose';
import User, { IUser } from '../models/User';
import Wallet from '../models/Wallet';
import Transaction from '../models/Transaction';
import PendingTransaction from '../models/PendingTransaction';
import SubscriptionPayment from '../models/SubscriptionPayment';
import AnalyticsEvent from '../models/AnalyticsEvent';

function daysAgo(n: number): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return d;
}

export type CohortPerson = {
  id: string;
  email: string;
  name: string;
  lastLoginAt: Date | null;
  created_at: Date;
  plan: string;
  emailVerified: boolean;
  hint?: string;
};

type LeanUser = Pick<IUser, 'email' | 'name' | 'lastLoginAt' | 'created_at' | 'plan' | 'emailVerified'> & {
  _id: Types.ObjectId;
};

function toPerson(u: LeanUser, hint?: string): CohortPerson {
  return {
    id: String(u._id),
    email: u.email,
    name: u.name || '',
    lastLoginAt: u.lastLoginAt || null,
    created_at: u.created_at,
    plan: u.plan || 'free',
    emailVerified: !!u.emailVerified,
    hint,
  };
}

const SELECT = 'email name lastLoginAt created_at plan emailVerified';

async function findPeople(
  filter: FilterQuery<IUser>,
  hint?: string
): Promise<CohortPerson[]> {
  const users = await User.find(filter)
    .select(SELECT)
    .sort({ lastLoginAt: -1, created_at: -1 })
    .limit(250)
    .lean();
  return (users as LeanUser[]).map((u) => toPerson(u, hint));
}

async function findPeopleByIds(
  ids: Types.ObjectId[],
  hints?: Map<string, string>
): Promise<CohortPerson[]> {
  if (!ids.length) return [];
  const users = await User.find({ _id: { $in: ids } })
    .select(SELECT)
    .sort({ lastLoginAt: -1, created_at: -1 })
    .limit(250)
    .lean();
  return (users as LeanUser[]).map((u) => toPerson(u, hints?.get(String(u._id))));
}

async function lastErrorHints(ids: Types.ObjectId[], since: Date) {
  const rows = await AnalyticsEvent.aggregate([
    { $match: { name: 'error', user_id: { $in: ids }, created_at: { $gte: since } } },
    { $sort: { created_at: -1 } },
    {
      $group: {
        _id: '$user_id',
        message: { $first: '$props.message' },
        screen: { $first: '$screen' },
      },
    },
  ]);
  const map = new Map<string, string>();
  for (const r of rows as { _id: Types.ObjectId; message?: string; screen?: string }[]) {
    const msg = typeof r.message === 'string' && r.message ? r.message : 'erreur';
    map.set(String(r._id), r.screen ? `${r.screen} · ${msg}` : msg);
  }
  return map;
}

export async function listCohort(key: string, days = 30) {
  const now = new Date();
  const since = daysAgo(days);
  const d7 = daysAgo(7);
  let title = 'Personnes';
  let people: CohortPerson[] = [];

  const walletIds = (await Wallet.distinct('user_id', {
    is_deleted: { $ne: true },
  })) as Types.ObjectId[];
  const txIds = (await Transaction.distinct('user_id', {
    is_transfer_mirror: { $ne: true },
  })) as Types.ObjectId[];

  if (key.startsWith('event:')) {
    const name = key.slice(6);
    title = `Ont déclenché « ${name} »`;
    const ids = (await AnalyticsEvent.distinct('user_id', {
      name,
      created_at: { $gte: since },
    })) as Types.ObjectId[];
    people = await findPeopleByIds(ids);
    return { key, title, count: people.length, people };
  }

  if (key.startsWith('screen:')) {
    const screen = key.slice(7);
    title = `Derniers passages sur « ${screen} »`;
    const ids = (await AnalyticsEvent.distinct('user_id', {
      screen,
      created_at: { $gte: since },
    })) as Types.ObjectId[];
    people = await findPeopleByIds(ids);
    return { key, title, count: people.length, people };
  }

  switch (key) {
    case 'registered':
      title = 'Tous les inscrits';
      people = await findPeople({});
      break;
    case 'verified':
      title = 'E-mail confirmé';
      people = await findPeople({ emailVerified: true });
      break;
    case 'unverified':
      title = 'E-mail non confirmé — bloqués à l’inscription';
      people = await findPeople({ emailVerified: { $ne: true } }, 'n’a pas validé son e-mail');
      break;
    case 'google':
      title = 'Comptes Google';
      people = await findPeople({ authProvider: { $in: ['google', 'both'] } });
      break;
    case 'signups_period':
      title = `Inscrits sur ${days} jours`;
      people = await findPeople({ created_at: { $gte: since } });
      break;
    case 'signups_7d':
      title = 'Inscrits sur 7 jours';
      people = await findPeople({ created_at: { $gte: d7 } });
      break;
    case 'mau':
      title = 'Connectés sur la période';
      people = await findPeople({ lastLoginAt: { $gte: since } });
      break;
    case 'wau':
      title = 'Connectés sur 7 jours';
      people = await findPeople({ lastLoginAt: { $gte: d7 } });
      break;
    case 'logged_in':
      title = 'Se sont déjà connectés';
      people = await findPeople({ lastLoginAt: { $ne: null } });
      break;
    case 'never_login':
      title = 'E-mail confirmé, jamais connectés';
      people = await findPeople(
        { emailVerified: true, lastLoginAt: null },
        'confirmé, aucune session'
      );
      break;
    case 'paid_premium':
      title = 'Premium payants';
      people = await findPeople({
        plan: 'premium',
        premiumSource: 'paid',
        premiumUntil: { $gt: now },
      });
      break;
    case 'trial':
      title = 'Essai Premium en cours';
      people = await findPeople({
        plan: 'premium',
        premiumSource: 'trial',
        premiumUntil: { $gt: now },
      });
      break;
    case 'has_wallet':
      title = 'Ont au moins une poche';
      people = await findPeopleByIds(walletIds);
      break;
    case 'no_wallet':
      title = 'Connectés sans poche — bloqués à la création';
      people = await findPeople(
        { lastLoginAt: { $ne: null }, _id: { $nin: walletIds } },
        'aucune poche'
      );
      break;
    case 'has_tx':
      title = 'Ont au moins une opération';
      people = await findPeopleByIds(txIds);
      break;
    case 'no_tx':
      title = 'Poche créée, aucune opération';
      people = await findPeople(
        { _id: { $in: walletIds, $nin: txIds } },
        'poche vide'
      );
      break;
    case 'inactive':
      title = 'Ont déjà utilisé l’app, absents sur la période';
      people = await findPeople(
        { lastLoginAt: { $ne: null, $lt: since }, _id: { $in: txIds } },
        'inactifs récemment'
      );
      break;
    case 'income_users': {
      title = 'Ont enregistré un revenu';
      const ids = (await Transaction.distinct('user_id', {
        type: 'income',
        created_at: { $gte: since },
        is_transfer_mirror: { $ne: true },
      })) as Types.ObjectId[];
      people = await findPeopleByIds(ids);
      break;
    }
    case 'expense_users': {
      title = 'Ont enregistré une dépense';
      const ids = (await Transaction.distinct('user_id', {
        type: 'expense',
        created_at: { $gte: since },
        is_transfer_mirror: { $ne: true },
      })) as Types.ObjectId[];
      people = await findPeopleByIds(ids);
      break;
    }
    case 'capturers': {
      title = 'Ont reçu au moins une capture';
      const ids = (await PendingTransaction.distinct('user_id')) as Types.ObjectId[];
      people = await findPeopleByIds(ids);
      break;
    }
    case 'validators': {
      title = 'Ont validé au moins une capture';
      const ids = (await PendingTransaction.distinct('user_id', {
        status: 'validated',
      })) as Types.ObjectId[];
      people = await findPeopleByIds(ids);
      break;
    }
    case 'capture_stuck': {
      title = 'Captures en attente, jamais validées';
      const rows = await PendingTransaction.aggregate([
        {
          $group: {
            _id: '$user_id',
            pending: { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] } },
            validated: { $sum: { $cond: [{ $eq: ['$status', 'validated'] }, 1, 0] } },
          },
        },
        { $match: { pending: { $gt: 0 }, validated: 0 } },
      ]);
      const hints = new Map<string, string>();
      const ids = (rows as { _id: Types.ObjectId; pending: number }[]).map((r) => {
        hints.set(String(r._id), `${r.pending} en file`);
        return r._id;
      });
      people = await findPeopleByIds(ids, hints);
      break;
    }
    case 'pending_now': {
      title = 'File d’attente en cours';
      const ids = (await PendingTransaction.distinct('user_id', {
        status: 'pending',
      })) as Types.ObjectId[];
      people = await findPeopleByIds(ids, undefined);
      break;
    }
    case 'errors': {
      title = 'Ont vu une erreur dans l’app';
      const ids = (await AnalyticsEvent.distinct('user_id', {
        name: 'error',
        created_at: { $gte: since },
      })) as Types.ObjectId[];
      people = await findPeopleByIds(ids, await lastErrorHints(ids, since));
      break;
    }
    case 'paywall': {
      title = 'Ont vu l’écran Premium, sans payer';
      const saw = (await AnalyticsEvent.distinct('user_id', {
        name: 'paywall',
        created_at: { $gte: since },
      })) as Types.ObjectId[];
      const paid = await User.find({
        _id: { $in: saw },
        plan: 'premium',
        premiumSource: 'paid',
        premiumUntil: { $gt: now },
      })
        .select('_id')
        .lean();
      const paidSet = new Set(paid.map((p) => String(p._id)));
      const unpaid = saw.filter((id) => !paidSet.has(String(id)));
      people = await findPeopleByIds(unpaid, undefined);
      break;
    }
    case 'payment_failed': {
      title = 'Paiement Premium échoué';
      const ids = (await SubscriptionPayment.distinct('user_id', {
        status: 'failed',
      })) as Types.ObjectId[];
      people = await findPeopleByIds(ids, undefined);
      break;
    }
    case 'payment_ok': {
      title = 'Paiement Premium abouti';
      const ids = (await SubscriptionPayment.distinct('user_id', {
        status: 'completed',
      })) as Types.ObjectId[];
      people = await findPeopleByIds(ids);
      break;
    }
    default:
      title = 'Cohorte inconnue';
      people = [];
  }

  return { key, title, count: people.length, people };
}
