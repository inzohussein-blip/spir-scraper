/** Default first message when a project has no template. */
export const DEFAULT_TEMPLATE =
  "مرحباً {name}، تواصلت معك بعد اطلاعي على حسابك @{username} على إنستقرام.";

/** Fills {name} and {username}; a lead without a name is greeted by username. */
export function fillTemplate(
  template: string | null | undefined,
  lead: { username: string; fullName: string | null },
): string {
  return (template?.trim() || DEFAULT_TEMPLATE)
    .replaceAll("{name}", lead.fullName?.trim() || lead.username)
    .replaceAll("{username}", lead.username);
}

/**
 * A wa.me link for a number confirmed in international form (+966…). Numbers
 * whose country is unknown get no link, so a message never goes to a wrong country.
 */
export function waLink(phone: string | null, confirmed: boolean, text: string): string | null {
  if (!phone || !confirmed || !phone.startsWith("+")) return null;
  const digits = phone.slice(1).replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) return null;
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}
