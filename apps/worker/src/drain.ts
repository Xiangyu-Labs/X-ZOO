/**
 * Runs a bounded delete again and again until a batch comes back short, so a
 * nightly sweep keeps up with a table that gains more than one batch a day.
 *
 * Each call is its own statement (its own transaction), so no lock is held
 * across batches — the reason the sweeps are batched at all. `maxBatches`
 * bounds one run: a table that was never swept still drains over several
 * nights instead of keeping the job busy until morning.
 */
export async function drainInBatches(
  batch: () => Promise<number>,
  options: { limit: number; maxBatches?: number },
): Promise<number> {
  const maxBatches = options.maxBatches ?? 100;
  let total = 0;
  for (let round = 0; round < maxBatches; round += 1) {
    const removed = await batch();
    total += removed;
    if (removed < options.limit) break;
  }
  return total;
}
