import User from '../models/User';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

export async function notifyExpoPush(params: {
  tokens: string[];
  title: string;
  body: string;
  data?: Record<string, string>;
  channelId?: string;
}): Promise<void> {
  const tokens = [
    ...new Set(
      params.tokens.filter(
        (t) =>
          typeof t === 'string' &&
          (t.startsWith('ExponentPushToken') || t.startsWith('ExpoPushToken'))
      )
    ),
  ];
  if (!tokens.length) {
    console.warn('[Expo push] aucun jeton enregistré');
    return;
  }

  const messages = tokens.map((to) => ({
    to,
    title: params.title,
    body: params.body.replace(/\s+/g, ' ').trim().slice(0, 180),
    sound: 'default',
    priority: 'high',
    channelId: params.channelId || 'mes_poches_messages',
    data: params.data ?? {},
  }));

  try {
    const res = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(messages),
    });
    const raw = await res.text();
    if (!res.ok || /"status"\s*:\s*"error"/i.test(raw)) {
      console.error('[Expo push]', res.status, raw.slice(0, 400));
    }
  } catch (err) {
    console.error('Expo push:', err instanceof Error ? err.message : err);
  }
}

export async function notifyAdminsOfFeedback(params: {
  userName: string;
  preview: string;
  userId: string;
  exceptUserId?: string;
}): Promise<void> {
  const admins = await User.find({
    role: 'admin',
    expoPushToken: { $nin: [null, ''] },
    ...(params.exceptUserId ? { _id: { $ne: params.exceptUserId } } : {}),
  })
    .select('expoPushToken')
    .lean();

  await notifyExpoPush({
    tokens: admins.map((a) => a.expoPushToken!).filter(Boolean),
    title: 'Nouveau message',
    body: `${params.userName} : ${params.preview}`,
    data: { type: 'feedback', userId: params.userId },
  });
}

export async function notifyUserOfAdminReply(params: {
  userId: string;
  preview: string;
}): Promise<void> {
  const user = await User.findById(params.userId).select('expoPushToken').lean();
  if (!user?.expoPushToken) return;
  await notifyExpoPush({
    tokens: [user.expoPushToken],
    title: 'Réponse de Mes Poches',
    body: params.preview,
    data: { type: 'feedback-reply', screen: 'feedback' },
  });
}

export async function notifyUserOfPendingTransaction(params: {
  userId: string;
  description: string;
  amount?: number;
}): Promise<void> {
  const user = await User.findById(params.userId).select('expoPushToken').lean();
  if (!user?.expoPushToken) return;
  const amount =
    typeof params.amount === 'number' && params.amount > 0
      ? ` — ${Math.round(params.amount)} FCFA`
      : '';
  await notifyExpoPush({
    tokens: [user.expoPushToken],
    title: 'Transaction à valider',
    body: `${params.description || 'Transaction Mobile Money'}${amount}`,
    channelId: 'mes_poches_transactions',
    data: { type: 'pending', screen: 'pending' },
  });
}
