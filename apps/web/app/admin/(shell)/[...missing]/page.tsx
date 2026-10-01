import { notFound } from 'next/navigation';

/**
 * Any `/admin/…` path no page claims. Without it Next falls through to the root
 * 404, outside the shell, and a mistyped address loses the menu and the header.
 * Here it renders `(shell)/not-found.tsx` inside the shell instead.
 */
export default function MissingAdminPage(): never {
  notFound();
}
