# Working in this repository

A Chinese shop: Next.js admin + API (`apps/web`), a worker (`apps/worker`), a Taro WeChat
mini-program (`apps/mini`), business logic in `packages/core`, route contracts in
`packages/contracts`. Read [docs/conventions.md](docs/conventions.md) and
[docs/contributing.md](docs/contributing.md) before changing code.

## Starting work

Local `master` is never updated for you, and a worktree made from it starts weeks behind.
Before the first edit: `git fetch origin`, then branch from `origin/master`
(`git switch -c <name> origin/master`), never from local `master` or whatever the main checkout
has open. One pull request per change, based on `master`; do not stack one on another.
Check `gh pr list` first: if an open pull request already touches the same thing, extend it or
wait for it. If your change adds a Drizzle migration, take the next free number on `origin/master`
and say which one in the pull request.

## The bugs this project keeps shipping

Every rule below was broken at least twice, each time fixed in one place while its siblings
stayed. Check your change against the list before you commit.

**Fix the class, not the instance.** When you fix a bug, search the tree for the same pattern
(`rg` the call, the field, the idiom) and fix or list every sibling. Presale fixed an id typed as
a number; groupbuy kept the same bug for weeks.

### Everywhere

1. Staff and shoppers read Chinese only. No `error.message`, `errMsg`, `String(error)`, enum
   codes, route ids, gateway strings or `（refund api）` in anything a person sees. Internal detail
   goes to logs or a staff-only field.
2. Times are Asia/Shanghai. Never show or export `toISOString()`; never `slice(0, 10)` an instant.
   An end date a person picks means the end of that day.
3. Money is a decimal string or integer fen. No float arithmetic (`* 100`, `toFixed` on sums).
   `Math.round(v * 100) === v * 100` is false for 1.1.
4. A literal that must satisfy a contract (a `pageSize`, an id type, a money format) is checked
   against the contract, not guessed. `pageSize` is at most 100.

### Server (`packages/core`)

5. Every write has an inverse (cancel, withdraw, reject, retry, delete, re-add). Make the inverse
   restore what the write took: stock, sales, quota, coupon, seat, refunded quantity. Add the
   inverse to the sequence test.
6. Counters change by `sql` increment under a lock or a guarded `WHERE`, never by writing back a
   value read earlier.
7. Deleting a row that live rows point at is a typed 409, never a foreign-key 500. Terminal
   states (ended, cancelled, refunded, failed team) refuse edits that would revive them.
8. Compare what the gateway says with what we asked for (`amount.total`, not `payer_total`).
9. A failure a person must act on is visible in the admin, not only in a log line.

### Admin (`apps/web`)

10. An edit form shows the record as it is now: never a cached detail from before the last save.
11. Every write control is gated on the atom its route requires; every picker's read route is
    gated or listed in `permission-requirements.ts`.
12. Irreversible or customer-visible actions (禁用, 下架, 作废, 删除, 退款) confirm first, and the
    toast reports what actually happened (`deleted: 0` is not 已删除).
13. Clearing an optional field must be possible (`null`/`''` → absent), and an empty required
    field says 请填写…, not a zod type error.

### Mini-program (`apps/mini`, `packages/storefront-blocks`)

14. Only what WeChat and iOS 12 have: no `Object.fromEntries`, `URLSearchParams`, `matchAll`,
    `.at`, lookbehind regex; WXSS without `*`, tag selectors, `:is/:where/:has`, `inset`,
    `aspect-ratio`. The guards and ESLint catch most; they do not catch everything.
15. Go back to a page that is already below instead of stacking it (`leaveFor`, `navigate`).
16. A write invalidates every read that shows what it changed; pages showing live state refetch
    on show.
17. Button handlers return their promise (`onClick={() => pay()}`), never `() => void pay()`,
    or the double-tap lock does nothing.
18. Keep a focused `Input`'s siblings mounted; toggle a class instead of rendering conditionally.
19. Image URLs go through `assetUrl`/`resolveImage`, including rich text and avatars.

### Tests

20. A stub answers what the server would answer, for the request the code really sends. Stubs go
    through the contract-checked helpers (`respondWith`/`on` on the web, `serveApi` in the mini).
21. Unit-test only what you touched; heavy suites (int, e2e, full turbo) run once per batch, one
    at a time. The dev machine is shared and has crashed from parallel runs.
