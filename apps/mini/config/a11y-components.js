/**
 * The ARIA attributes the kit sets, per Taro component: what `a11y-plugin.js` adds to the WeChat
 * templates and `a11y-runtime.js` adds to the runtime's component table. One list for both, and it
 * must be: Taro numbers each component's attributes (`p0`, `p1`… in sorted order) once for the
 * template and again at run time, so an attribute known to only one side shifts every later
 * number and the template reads the wrong prop (an `<image>` whose `src` is `lazy-load`'s value).
 * `''` = no default value: the attribute is bound only when a prop sets it.
 */
const ARIA = {
  'aria-role': "''",
  'aria-label': "''",
  'aria-hidden': "''",
  'aria-checked': "''",
  'aria-selected': "''",
  'aria-disabled': "''",
  'aria-modal': "''",
  'aria-live': "''",
};

module.exports = {
  View: ARIA,
  Text: ARIA,
  Image: { 'aria-role': "''", 'aria-label': "''", 'aria-hidden': "''" },
  Button: { 'aria-label': "''", 'aria-disabled': "''" },
  // Field, Textarea, SearchBar and Stepper name their inputs for a screen reader; without these
  // entries WeChat's input templates dropped the label.
  Input: { 'aria-label': "''" },
  Textarea: { 'aria-label': "''" },
};
