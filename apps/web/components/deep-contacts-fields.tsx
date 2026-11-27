/** The deep contact search options on a collection form (on by default, second read off). */
export function DeepContactsFields() {
  return (
    <fieldset className="space-y-2 rounded-lg border border-line p-3 text-sm">
      <legend className="px-1 font-medium">الإيميل والرقم</legend>
      <label className="flex items-start gap-2">
        <input type="checkbox" name="deep_contacts" defaultChecked className="mt-1" />
        <span>
          بحث عميق بعد الانتهاء (مجاني): لمن لم يظهر له إيميل أو رقم، يُقرأ موقعه وصفحة «تواصل معنا»
          فيه وحساباته الأخرى.
        </span>
      </label>
      <label className="flex items-start gap-2">
        <input type="checkbox" name="deep_reread" className="mt-1" />
        <span>
          ومعه قراءة ثانية عبر Apify لمن بقي بلا تواصل (≈ $1.60 لكل 1000): تُظهر زر التواصل أكثر من
          القراءة المجانية.
        </span>
      </label>
    </fieldset>
  );
}
