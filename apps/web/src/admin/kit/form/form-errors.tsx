'use client';

import { Alert, type FormInstance } from 'antd';
import { useEffect, useMemo, useRef } from 'react';

import { toNamePath, type FieldName } from './types';
import { applyFieldErrors, matchApiError, type FieldErrorMatch } from './zod-bridge';

/**
 * Shows a failed save's 422 on the fields `fieldNames` names, and returns the
 * match so the caller can put the rest in a banner. `null` means `error` is
 * not a 422 that names any field, so it is the banner's alone.
 *
 * Pass the fields the form renders right now and that show their own errors.
 * An error lands on a field once per failed save: when a hidden field comes
 * into view it gets its error, but a field the operator has since corrected
 * does not get it back.
 */
export function useFieldErrors(
  form: FormInstance,
  error: unknown,
  fieldNames: readonly FieldName[],
  options: { prefix?: string | undefined } = {},
): FieldErrorMatch | null {
  // Keyed by value so a new array of the same names does not re-match.
  const namesKey = JSON.stringify(fieldNames.map(toNamePath));
  const names = useMemo(() => JSON.parse(namesKey) as (string | number)[][], [namesKey]);
  const { prefix } = options;
  const match = useMemo(() => matchApiError(error, names, { prefix }), [error, names, prefix]);

  const applied = useRef<{ error: unknown; keys: Set<string> }>({ error: null, keys: new Set() });
  useEffect(() => {
    if (applied.current.error !== error) applied.current = { error, keys: new Set() };
    if (!match) return;
    const { keys } = applied.current;
    const fresh = match.matched.filter((field) => !keys.has(JSON.stringify(field.name)));
    for (const field of fresh) keys.add(JSON.stringify(field.name));
    applyFieldErrors(form, fresh);
  }, [error, match, form]);

  return match;
}

/** The form-level error: its message, plus each error no field can show. */
export function FormErrorBanner({
  message,
  details,
}: {
  message: string;
  details: readonly string[];
}) {
  return (
    <Alert
      type="error"
      showIcon
      message={message}
      {...(details.length > 0
        ? {
            description: details.map((detail) => <div key={detail}>{detail}</div>),
          }
        : {})}
      style={{ marginBottom: 16 }}
    />
  );
}
