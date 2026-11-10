/** Champs utiles aux listes — line_items limités à leurs libellés (affichés sous la transaction), sans raw_text / loginHistory. */
export const WALLET_LIST_SELECT = 'name currency image_url current_balance is_deleted created_at';
export const CATEGORY_LIST_SELECT = 'name type image_url created_at';
export const SAVINGS_LIST_SELECT = 'title target_amount saved_amount deadline created_at';
export const TX_LIST_SELECT =
  'user_id type amount wallet_id destination_wallet_id transfer_group_id is_transfer_mirror category_id savings_goal_id description date balance_before balance_after created_at line_items.description';
export const PENDING_LIST_SELECT = '-raw_text';
