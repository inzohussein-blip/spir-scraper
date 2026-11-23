"use client";

/** Ticks or clears every row checkbox that belongs to the given form. */
export function SelectAll({ form }: { form: string }) {
  return (
    <input
      type="checkbox"
      aria-label="تحديد الكل"
      title="تحديد الكل"
      onChange={(e) => {
        for (const box of document.querySelectorAll<HTMLInputElement>(
          `input[type="checkbox"][form="${form}"][name="u"]`,
        ))
          box.checked = e.target.checked;
      }}
    />
  );
}
