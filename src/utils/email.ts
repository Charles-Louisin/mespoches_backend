import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

/** Domaine d'envoi vérifié sur Resend (gmail.com ne peut pas servir d'expéditeur). */
const FROM_EMAIL =
  process.env.RESEND_FROM_EMAIL || 'MES POCHES <onboarding@resend.dev>';

const REPLY_TO = process.env.RESEND_REPLY_TO || undefined;

export function generateVerificationCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
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
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h1 style="color: #0ea5e9; font-size: 24px;">MES POCHES</h1>
        <p>Bienvenue ! Utilisez le code ci-dessous pour vérifier votre adresse email :</p>
        <div style="background: #f0f9ff; border-radius: 12px; padding: 24px; text-align: center; margin: 24px 0;">
          <span style="font-size: 36px; font-weight: bold; letter-spacing: 8px; color: #0369a1;">${code}</span>
        </div>
        <p style="color: #6b7280; font-size: 14px;">Ce code expire dans 15 minutes. Si vous n'avez pas demandé ce code, ignorez cet email.</p>
      </div>
    `,
  });

  if (error) {
    console.error('Erreur Resend:', error);
    throw new Error("Impossible d'envoyer l'email de vérification");
  }
}
