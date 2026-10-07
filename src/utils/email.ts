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
