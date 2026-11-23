"use client";

import { type ReactNode, useActionState } from "react";
import type { ActionState } from "@/app/actions";
import { Button, Notice } from "./ui";

/** A form bound to a server action that shows its result message. */
export function ActionForm({
  action,
  children,
  submit,
  className,
  id,
}: {
  action: (state: ActionState, form: FormData) => Promise<ActionState>;
  children: ReactNode;
  submit: string;
  className?: string;
  /** Lets inputs elsewhere on the page join this form with form="id". */
  id?: string;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  return (
    <form id={id} action={formAction} className={className ?? "space-y-4"}>
      {children}
      <Button type="submit" disabled={pending}>
        {pending ? "جارٍ التنفيذ…" : submit}
      </Button>
      {state?.error && <Notice tone="error">{state.error}</Notice>}
      {state?.message && (
        <Notice tone="ok">
          {state.message}
          {state.url && (
            <>
              {" "}
              <a
                className="font-medium underline"
                href={state.url}
                target="_blank"
                rel="noreferrer"
              >
                فتح
              </a>
            </>
          )}
          {state.secret && (
            <code className="ltr mt-2 block select-all break-all rounded bg-white/70 p-2 font-mono text-xs">
              {state.secret}
            </code>
          )}
        </Notice>
      )}
    </form>
  );
}
