import { acquireJobLock } from '../utils/jobLock';
import { monthKey, runGoalTipsSweep, tipPeriodFor } from '../services/goalInsights';

/**
 * Conseils IA des objectifs : un passage par heure pendant les fenêtres de début et de fin de mois.
 * Chaque utilisateur reçoit au plus 2 conseils par mois (début, fin) ; le verrou évite les doublons
 * entre instances.
 */
export function startGoalTipsScheduler(): void {
  const tick = async () => {
    const period = tipPeriodFor();
    if (!period) return;
    const hour = new Date().toISOString().slice(0, 13);
    const locked = await acquireJobLock(`goal-tips:${monthKey()}:${period}:${hour}`, 55 * 60 * 1000);
    if (!locked) return;
    const n = await runGoalTipsSweep();
    if (n) console.log(`💡 Conseils objectifs (${period}) : ${n} utilisateur(s)`);
  };
  const run = () => tick().catch((err) => console.error('goalTipsScheduler:', err));
  setTimeout(run, 60_000).unref?.();
  setInterval(run, 60 * 60 * 1000).unref?.();
}
