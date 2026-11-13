/**
 * D'où peut venir l'argent pour couvrir un montant : la combinaison de poches la plus simple.
 * 1. Une seule poche suffit → la plus petite qui couvre tout (les grosses poches restent intactes).
 * 2. Sinon → les plus grosses poches d'abord, jusqu'à couvrir le montant (le moins de poches possible),
 *    la dernière ne donnant que le reste.
 * Retourne null si l'ensemble des poches ne suffit pas.
 */
export type FundingWallet = { id: string; name: string; balance: number };
export type FundingSource = { wallet_id: string; name: string; amount: number };

export function fundingSources(wallets: FundingWallet[], needed: number): FundingSource[] | null {
  if (needed <= 0) return [];
  const usable = wallets.filter((w) => w.balance > 0);
  const total = usable.reduce((s, w) => s + w.balance, 0);
  if (total < needed) return null;

  const single = usable
    .filter((w) => w.balance >= needed)
    .sort((a, b) => a.balance - b.balance)[0];
  if (single) return [{ wallet_id: single.id, name: single.name, amount: needed }];

  const out: FundingSource[] = [];
  let rest = needed;
  for (const w of [...usable].sort((a, b) => b.balance - a.balance)) {
    if (rest <= 0) break;
    const take = Math.min(w.balance, rest);
    out.push({ wallet_id: w.id, name: w.name, amount: take });
    rest -= take;
  }
  return out;
}
