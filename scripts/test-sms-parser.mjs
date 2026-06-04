import { parseMobileMoneySms } from '../src/utils/mobileMoneySmsParser.ts';

const identity = { names: ['YIMBNE NYEMB'], phones: ['693460259'] };

const sms = [
  ['depense transfert', 'Transfert de 693460259 YIMBNE NYEMB vers 659716308 MBONGANA reussi. ID transaction: PP260429.1026.C42972, Montant Transaction: 500 FCFA, Frais: 5 FCFA, Commission: 0 FCFA, Montant Net: 505 FCFA, Nouveau Solde: 10995.39 FCFA.'],
  ['depense paiement', 'Paiement de ETS L ECLAT reussi par 693460259 YIMBNE NYEMB. ID transaction:MP260429.1037.A65656, Montant:1500 FCFA. Solde: 9495.39 FCFA.'],
  ['depense retrait', "Retrait d'argent reussi par le 657279294 avec le Code : 152792. Informations detaillees : Montant: 1000 FCFA, Frais: 54 FCFA, No de transaction CO260429.1039.C99939, montant net debite 1054 FCFA, Nouveau solde: 8441.39 FCFA."],
  ['revenu transfert', 'Transfert de 696464953 YENGA vers 693460259 YIMBNE NYEMB reussi. Details: ID transaction: PP260429.1319.B57875, Montant Transaction: 1554FCFA, Frais: 0 FCFA, Commission: 0 FCFA, Montant Net: 1554 FCFA, Nouveau Solde: 6941.39 FCFA.'],
];

for (const [label, text] of sms) {
  const r = parseMobileMoneySms(text, identity);
  console.log(label, r ? `${r.type} ${r.amount} FCFA → ${r.counterparty} [${r.pattern}]` : 'FAIL');
}
