/** URL publique du frontend (page de retour de paiement /paiement/retour) */
export function getFrontendUrl(): string {
  const url =
    process.env.APP_URL?.trim() ||
    process.env.CORS_ORIGIN?.split(',')[0]?.trim() ||
    'http://localhost:3000';
  return url.replace(/\/$/, '');
}

/** URL publique de l'API (webhook SasPay) */
export function getApiPublicUrl(): string {
  const url =
    process.env.API_PUBLIC_URL?.trim() ||
    `http://localhost:${process.env.PORT || 5000}`;
  return url.replace(/\/$/, '');
}
