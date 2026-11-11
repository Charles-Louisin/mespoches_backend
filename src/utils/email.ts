import { Resend } from 'resend';
import { escapeHtml, generateSecureOtp } from './security';

const resend = new Resend(process.env.RESEND_API_KEY);

const SITE_URL = (process.env.APP_URL || 'https://www.mespoches.store').replace(/\/$/, '');
const CONTACT_EMAIL = 'contact@mespoches.store';

/** Expéditeur vérifié sur Resend. Jamais une adresse personnelle. */
const FROM_EMAIL =
  process.env.RESEND_FROM_EMAIL || `MES POCHES <noreply@mespoches.store>`;

const REPLY_TO = process.env.RESEND_REPLY_TO || CONTACT_EMAIL;

function logoUrl(): string {
  return `${SITE_URL}/logo.png`;
}

function emailLayout(body: string): string {
  return `<!DOCTYPE html>
<html lang="fr">
<body style="margin:0;padding:0;background:#f4f7fb;">
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:520px;margin:0 auto;padding:28px 20px;color:#1b1630;">
    <img src="${logoUrl()}" width="56" height="56" alt="MES POCHES" style="display:block;width:56px;height:56px;border-radius:14px;border:0;" />
    <p style="margin:14px 0 0;font-size:13px;letter-spacing:0.18em;font-weight:700;color:#2563EB;">MES POCHES</p>
    ${body}
    <p style="margin-top:28px;color:#6b7280;font-size:13px;line-height:1.5;">
      Une question ? Écrivez à
      <a href="mailto:${CONTACT_EMAIL}" style="color:#2563EB;text-decoration:none;">${CONTACT_EMAIL}</a>
    </p>
  </div>
</body>
</html>`;
}

export function generateVerificationCode(): string {
  return generateSecureOtp();
}

export async function sendVerificationEmail(
  to: string,
  code: string
): Promise<void> {
  if (!process.env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY manquant');
  }

  const { error } = await resend.emails.send({
    from: FROM_EMAIL,
    to,
    ...(REPLY_TO ? { replyTo: REPLY_TO } : {}),
    subject: 'Votre code de vérification — MES POCHES',
    html: emailLayout(`
        <p style="font-size:16px;line-height:1.6;">Bienvenue. Utilisez ce code pour vérifier votre adresse e-mail :</p>
        <div style="background:#EEF4FF;border-radius:14px;padding:24px;text-align:center;margin:24px 0;">
          <span style="font-size:36px;font-weight:bold;letter-spacing:8px;color:#1d4ed8;">${escapeHtml(code)}</span>
        </div>
        <p style="color:#6b7280;font-size:14px;line-height:1.5;">Ce code expire dans 15 minutes. Si vous n'avez pas demandé ce code, ignorez cet e-mail.</p>
    `),
  });

  if (error) {
    console.error('Erreur Resend:', error);
    throw new Error("Impossible d'envoyer l'email de vérification");
  }
}

export async function sendPasswordResetEmail(
  to: string,
  code: string
): Promise<void> {
  if (!process.env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY manquant');
  }

  const { error } = await resend.emails.send({
    from: FROM_EMAIL,
    to,
    ...(REPLY_TO ? { replyTo: REPLY_TO } : {}),
    subject: 'Réinitialisation du mot de passe — MES POCHES',
    html: emailLayout(`
        <p style="font-size:16px;line-height:1.6;">Vous avez demandé à définir ou réinitialiser votre mot de passe. Utilisez ce code :</p>
        <div style="background:#EEF4FF;border-radius:14px;padding:24px;text-align:center;margin:24px 0;">
          <span style="font-size:36px;font-weight:bold;letter-spacing:8px;color:#1d4ed8;">${escapeHtml(code)}</span>
        </div>
        <p style="color:#6b7280;font-size:14px;line-height:1.5;">Ce code expire dans 15 minutes. Si vous n'avez pas fait cette demande, ignorez cet e-mail.</p>
    `),
  });

  if (error) {
    console.error('Erreur Resend reset:', error);
    throw new Error("Impossible d'envoyer l'email de réinitialisation");
  }
}

/**
 * Prévient le titulaire qu'une inscription a été tentée avec son email.
 * Permet à /register de répondre la même chose qu'un compte existe ou non.
 */
export async function sendExistingAccountEmail(to: string): Promise<void> {
  if (!process.env.RESEND_API_KEY) {
    console.warn('RESEND_API_KEY manquant — notification compte existant ignorée');
    return;
  }

  const { error } = await resend.emails.send({
    from: FROM_EMAIL,
    to,
    ...(REPLY_TO ? { replyTo: REPLY_TO } : {}),
    subject: 'Tentative d’inscription — MES POCHES',
    html: emailLayout(`
        <p style="font-size:16px;line-height:1.6;">Quelqu'un vient d'essayer de créer un compte avec cette adresse e-mail, mais un compte existe déjà.</p>
        <p style="font-size:16px;line-height:1.6;">Si c'était vous, connectez-vous. Mot de passe oublié ? Utilisez « Mot de passe oublié » sur la page de connexion.</p>
        <p style="color:#6b7280;font-size:14px;line-height:1.5;">Si ce n'était pas vous, aucune action n'est nécessaire : votre compte n'a pas été modifié.</p>
    `),
  });

  if (error) {
    console.error('Erreur Resend compte existant:', error);
  }
}

interface PlannedExpenseReminderRow {
  amount: number;
  description: string;
  scheduled_date: Date;
  wallet_id?: { name?: string } | null;
  category_id?: { name?: string } | null;
}

export async function sendPlannedExpensesReminderEmail(
  to: string,
  userName: string,
  items: PlannedExpenseReminderRow[]
): Promise<void> {
  if (!process.env.RESEND_API_KEY) {
    console.warn('RESEND_API_KEY manquant — rappel dépenses prévues ignoré');
    return;
  }

  const tomorrowLabel = items[0]?.scheduled_date
    ? new Date(items[0].scheduled_date).toLocaleDateString('fr-FR', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      })
    : 'demain';

  const rows = items
    .map((item) => {
      const walletName =
        item.wallet_id && typeof item.wallet_id === 'object'
          ? item.wallet_id.name
          : 'Poche';
      const label =
        (item.category_id &&
          typeof item.category_id === 'object' &&
          item.category_id.name) ||
        item.description ||
        'Dépense';
      return `<li style="margin: 8px 0;"><strong>${escapeHtml(label)}</strong> — ${escapeHtml(item.amount.toLocaleString('fr-FR'))} (${escapeHtml(walletName)})</li>`;
    })
    .join('');

  const { error } = await resend.emails.send({
    from: FROM_EMAIL,
    to,
    ...(REPLY_TO ? { replyTo: REPLY_TO } : {}),
    subject: `Rappel : vos dépenses prévues pour ${tomorrowLabel} — MES POCHES`,
    html: emailLayout(`
        <p style="font-size:16px;line-height:1.6;">Bonjour ${escapeHtml(userName)},</p>
        <p style="font-size:16px;line-height:1.6;">Demain (<strong>${escapeHtml(tomorrowLabel)}</strong>), les dépenses suivantes seront débitées automatiquement si votre solde le permet :</p>
        <ul style="padding-left:20px;">${rows}</ul>
        <p style="color:#6b7280;font-size:14px;line-height:1.5;">Si le solde est insuffisant le jour J, la dépense sera annulée. Vous pouvez encore l'annuler depuis l'app avant cette date.</p>
    `),
  });

  if (error) {
    console.error('Erreur Resend rappel dépenses:', error);
    throw new Error("Impossible d'envoyer le rappel");
  }
}

export type TwoFactorPurpose = 'login' | 'enable' | 'disable';

const TWO_FACTOR_COPY: Record<TwoFactorPurpose, { subject: string; intro: string }> = {
  login: {
    subject: 'Code de connexion — MES POCHES',
    intro: 'Une connexion à votre compte est en cours. Saisissez ce code dans l’application :',
  },
  enable: {
    subject: 'Activer la double authentification — MES POCHES',
    intro: 'Pour activer la double authentification, saisissez ce code dans l’application :',
  },
  disable: {
    subject: 'Désactiver la double authentification — MES POCHES',
    intro: 'Pour désactiver la double authentification, saisissez ce code dans l’application :',
  },
};

/** Code de double authentification (connexion, activation ou désactivation). */
export async function sendTwoFactorEmail(to: string, code: string, purpose: TwoFactorPurpose): Promise<void> {
  if (!process.env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY manquant');
  }
  const copy = TWO_FACTOR_COPY[purpose];
  const { error } = await resend.emails.send({
    from: FROM_EMAIL,
    to,
    ...(REPLY_TO ? { replyTo: REPLY_TO } : {}),
    subject: copy.subject,
    html: emailLayout(`
        <p style="font-size:16px;line-height:1.6;">${escapeHtml(copy.intro)}</p>
        <div style="background:#EEF4FF;border-radius:14px;padding:24px;text-align:center;margin:24px 0;">
          <span style="font-size:36px;font-weight:bold;letter-spacing:8px;color:#1d4ed8;">${escapeHtml(code)}</span>
        </div>
        <p style="color:#6b7280;font-size:14px;line-height:1.5;">Ce code expire dans 10 minutes. Si ce n’est pas vous, ne communiquez ce code à personne et changez votre mot de passe.</p>
    `),
  });
  if (error) {
    console.error('Erreur Resend 2FA:', error);
    throw new Error("Impossible d'envoyer le code de connexion");
  }
}

export interface AdminPaymentEmail {
  success: boolean;
  message: string;
  tier: string;
  periodLabel: string;
  amount: string;
  charged: string | null;
  net: string | null;
  reference: string;
  saspayTransactionId: string | null;
  saspayStatus: string | null;
  createdAt: Date;
  completedAt: Date | null;
  payer: {
    id: string;
    name: string;
    email: string;
    memberSince: Date | null;
    activeTier: string;
    source: string | null;
    premiumUntil: Date | null;
  } | null;
  periodStart: Date | null;
  periodEnd: Date | null;
}

const fmtDate = (d: Date | null | undefined): string =>
  d
    ? new Date(d).toLocaleString('fr-FR', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Africa/Douala',
      })
    : '—';

/** Résultat d'un paiement d'abonnement, envoyé aux admins. */
export async function sendAdminPaymentEmail(to: string, p: AdminPaymentEmail): Promise<void> {
  if (!process.env.RESEND_API_KEY) {
    console.warn('RESEND_API_KEY manquant — alerte paiement admin ignorée');
    return;
  }
  const row = (label: string, value: string | null | undefined) =>
    `<tr><td style="padding:6px 12px 6px 0;color:#6b7280;font-size:14px;vertical-align:top;white-space:nowrap;">${escapeHtml(label)}</td><td style="padding:6px 0;font-size:14px;color:#1b1630;">${escapeHtml(value || '—')}</td></tr>`;
  const section = (title: string, rows: string) =>
    `<p style="margin:24px 0 6px;font-size:13px;font-weight:700;color:#1b1630;">${escapeHtml(title)}</p><table style="border-collapse:collapse;width:100%;">${rows}</table>`;

  const tone = p.success
    ? { bg: '#ECFDF5', fg: '#047857', title: 'Paiement réussi' }
    : { bg: '#FEF2F2', fg: '#B91C1C', title: 'Paiement échoué' };

  const payer = p.payer;
  const html = emailLayout(`
      <div style="background:${tone.bg};border-radius:14px;padding:18px 20px;margin:20px 0 4px;">
        <p style="margin:0;font-size:18px;font-weight:700;color:${tone.fg};">${tone.title}</p>
        <p style="margin:6px 0 0;font-size:15px;color:#1b1630;">${escapeHtml(`${p.tier} ${p.periodLabel} · ${p.amount}`)}</p>
        <p style="margin:6px 0 0;font-size:14px;color:#374151;">${escapeHtml(p.message)}</p>
      </div>
      ${section(
        'Payeur',
        payer
          ? row('Nom', payer.name) +
              row('E-mail', payer.email) +
              row('Identifiant', payer.id) +
              row('Inscrit le', fmtDate(payer.memberSince))
          : row('Compte', 'introuvable (supprimé ?)')
      )}
      ${section(
        'Forfait',
        row('Forfait payé', `${p.tier} (${p.periodLabel})`) +
          (p.success ? row('Début', fmtDate(p.periodStart)) + row('Fin', fmtDate(p.periodEnd)) : '') +
          (payer
            ? row('Forfait actif du compte', payer.activeTier) +
              row('Actif jusqu’au', fmtDate(payer.premiumUntil)) +
              row('Origine', payer.source === 'paid' ? 'payé' : payer.source === 'trial' ? 'essai' : payer.source === 'lifetime' ? 'à vie' : payer.source)
            : '')
      )}
      ${section(
        'Paiement',
        row('Montant', p.amount) +
          row('Débité au client', p.charged) +
          row('Net reçu', p.net) +
          row('Statut SasPay', p.saspayStatus) +
          row('Référence', p.reference) +
          row('Transaction SasPay', p.saspayTransactionId) +
          row('Créé le', fmtDate(p.createdAt)) +
          (p.success ? row('Confirmé le', fmtDate(p.completedAt)) : '')
      )}
      <p style="margin-top:24px;"><a href="${SITE_URL}/admin/payments" style="color:#2563EB;text-decoration:none;font-weight:600;">Voir les paiements dans la console</a></p>
  `);

  const { error } = await resend.emails.send({
    from: FROM_EMAIL,
    to,
    ...(REPLY_TO ? { replyTo: REPLY_TO } : {}),
    subject: `${tone.title} · ${p.tier} ${p.periodLabel} · ${p.amount} — MES POCHES`,
    html,
  });
  if (error) {
    console.error('Erreur Resend alerte paiement:', error);
    throw new Error("Impossible d'envoyer l'alerte de paiement");
  }
}
