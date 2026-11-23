/**
 * Red flags in a message about trading, under financial-promotion rules most
 * regulators share (UK FCA, Gulf CMAs, CySEC...): no promised returns, no
 * "risk-free", fair and balanced, with the risk stated. A check, not legal
 * advice: "block" means do not send as written.
 */

export interface ComplianceIssue {
  code:
    | "guaranteed"
    | "promised_return"
    | "risk_free"
    | "pressure"
    | "license_claim"
    | "no_risk_warning"
    | "certain_signals";
  severity: "block" | "warn";
  /** Arabic explanation for the owner. */
  message: string;
  /** The words that triggered it. */
  match: string;
}

const RULES: {
  code: ComplianceIssue["code"];
  severity: ComplianceIssue["severity"];
  re: RegExp;
  message: string;
}[] = [
  {
    code: "guaranteed",
    severity: "block",
    re: /(ربح|أرباح|ارباح|عائد|عوائد|دخل)\s*(مضمون|مضمونة|ثابت|ثابتة|أكيد|اكيد)|guaranteed\s+(profit|return|income|results?)/i,
    message: "لا تَعِد بربح أو دخل مضمون. هذا ممنوع في الترويج المالي تقريباً عند كل الجهات الرقابية.",
  },
  {
    code: "promised_return",
    severity: "block",
    re: /\d+\s*[%٪]\s*(ربح|أرباح|ارباح|عائد|شهري|يومي|أسبوعي|profit|returns?|monthly|daily|weekly)|(اربح|تربح|ربح)\s*\$?\d+|earn\s+\$?\d+/i,
    message: "رقم ربح محدد يُفهم كوعد بعائد. اذكر الخدمة لا الأرباح المتوقعة.",
  },
  {
    code: "risk_free",
    severity: "block",
    re: /بدون\s*(أي\s*)?(مخاطر|مخاطرة|خسارة)|بلا\s*(مخاطر|مخاطرة|خسارة)|(no|zero)\s+risk|risk[-\s]?free/i,
    message: "التداول فيه مخاطرة دائماً. «بدون مخاطر» عبارة مضللة.",
  },
  {
    code: "certain_signals",
    severity: "warn",
    re: /(توصيات|صفقات|إشارات|اشارات|signals?)(\s+\S+){0,3}\s*100\s*[%٪]|100\s*[%٪]\s*(نجاح|ناجحة|صحيحة|accuracy|win)/i,
    message: "نسبة نجاح 100% لا يمكن إثباتها، وتُعدّ مضللة.",
  },
  {
    code: "pressure",
    severity: "warn",
    re: /فرصة\s*(لن\s*تتكرر|العمر)|آخر\s*فرصة|سارع|الآن\s*فقط|العرض\s*ينتهي\s*اليوم|limited\s+time|act\s+now|last\s+chance/i,
    message: "الضغط بالوقت في الترويج المالي يُعدّ ممارسة غير عادلة. اترك للشخص وقته.",
  },
  {
    code: "license_claim",
    severity: "warn",
    re: /مرخّ?ص|ترخيص|regulated|licensed|authori[sz]ed by/i,
    message: "ذكرت ترخيصاً: تأكد أنه صحيح ويمكن إثباته (اسم الجهة ورقم الترخيص).",
  },
];

const TRADING =
  /تداول|فوركس|فوريكس|ذهب|عملات\s*رقمية|كريبتو|أسهم|اسهم|مؤشرات|trading|forex|\bfx\b|crypto|stocks?|indices|cfd/i;
const RISK = /مخاطر|مخاطرة|خسارة|قد\s*تخسر|risk|loss/i;

export function checkMessage(text: string): { ok: boolean; issues: ComplianceIssue[] } {
  const issues: ComplianceIssue[] = [];
  for (const r of RULES) {
    const m = r.re.exec(text);
    if (m) issues.push({ code: r.code, severity: r.severity, message: r.message, match: m[0] });
  }
  const promoting = TRADING.exec(text);
  if (promoting && !RISK.test(text))
    issues.push({
      code: "no_risk_warning",
      severity: "warn",
      message:
        "الرسالة عن التداول بلا تنبيه مخاطر. أضف مثلاً: «التداول ينطوي على مخاطر وقد تخسر رأس مالك».",
      match: promoting[0],
    });
  return { ok: !issues.some((i) => i.severity === "block"), issues };
}
