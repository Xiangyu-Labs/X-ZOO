/**
 * The cart domain's public surface.
 *
 * Only route files call these; no other domain needs the cart. The dependency
 * between the cart and the order aggregate points **cart -> order** and only
 * that way: the cart reads live catalogue data through `order/catalog.port.ts`
 * and 再次购买 asks the order domain for its lines, while checkout empties the
 * two `cart_items` rows it consumed from inside `order.repo.ts`. Keeping the
 * arrow one-way is what stops the two module graphs from becoming circular.
 */
export {
  addItem,
  count,
  list,
  rebuy,
  removeItem,
  removeItems,
  setSelection,
  updateItem,
} from './cart.service';

export { MAX_CART_QUANTITY, MAX_CART_ROWS, stateOf, isAvailable } from './cart.rules';
