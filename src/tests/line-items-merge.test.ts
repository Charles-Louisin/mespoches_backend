import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeLineItems } from '../utils/lineItemsMerge';

const existing = [
  { description: 'Pain', amount: 500, quantity: 2, unit_amount: 250, type: 'expense' as const, category_id: 'catA' },
  { description: 'Riz', amount: 4500, quantity: 1, type: 'expense' as const, category_id: 'catA' },
  { description: 'Savon', amount: 800, quantity: 1, type: 'expense' as const, category_id: 'catB' },
];

test('une ligne supprimée ne revient pas', () => {
  const incoming = [
    { description: 'Pain', amount: 500, quantity: 2, unit_amount: 250 },
    { description: 'Savon', amount: 800 },
  ];
  const out = mergeLineItems(existing, incoming, [{}, {}], 'expense');
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((l) => l.description), ['Pain', 'Savon']);
  // Catégorie reprise de l'ancienne ligne de même libellé, pas de la position.
  assert.equal(out[1].category_id, 'catB');
  assert.equal(out[1].amount, 800);
});

test('un montant modifié est gardé', () => {
  const incoming = [{ description: 'Riz', amount: 5000 }];
  const out = mergeLineItems(existing, incoming, [{}], 'expense');
  assert.equal(out[0].amount, 5000);
  assert.equal(out[0].quantity, 1);
});

test('une catégorie fournie remplace l’ancienne', () => {
  const out = mergeLineItems(existing, [{ description: 'Pain', amount: 500, category_id: 'x' }], [{ category_id: 'catZ' }], 'expense');
  assert.equal(out[0].category_id, 'catZ');
});
