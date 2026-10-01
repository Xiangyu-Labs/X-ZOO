/**
 * A SKU's spec as the shop shows it: the API's `specText` joins the chosen values with `|`
 * (`白|L`); a shopper reads `白 / L`. Empty values are dropped; `null` or `''` is `''`.
 */
export function formatSpec(specText: string | null | undefined): string {
  if (!specText) return '';
  return specText
    .split('|')
    .map((value) => value.trim())
    .filter((value) => value !== '')
    .join(' / ');
}
