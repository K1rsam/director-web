"use client";

import type { ReactNode } from "react";
import { useFormStatus } from "react-dom";

export function ChoiceSubmitButton({ children, disabled, className, name, value }: { children: ReactNode; disabled?: boolean; className?: string; name?: string; value?: number }) {
  const { pending } = useFormStatus();
  return <button type="submit" name={name} value={value} disabled={disabled || pending} className={className} aria-busy={pending}>
    {pending ? <span role="status">正在保存决定，请稍候…</span> : children}
  </button>;
}
