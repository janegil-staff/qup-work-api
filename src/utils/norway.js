// /qup-work-api/src/utils/norway.js
// Norwegian number checks. Both use MOD11: multiply the digits by fixed weights,
// and the last digit must match 11 − (sum mod 11) (11 → 0, 10 → never valid).

function mod11(digits, weights) {
  const sum = weights.reduce((s, w, i) => s + w * Number(digits[i]), 0);
  const rest = 11 - (sum % 11);
  if (rest === 10) return null;
  return rest === 11 ? 0 : rest;
}

// Organisasjonsnummer: 9 digits, e.g. "923609016"
export function isValidOrgNumber(value) {
  const d = String(value ?? '').replace(/\s/g, '');
  if (!/^\d{9}$/.test(d)) return false;
  return mod11(d, [3, 2, 7, 6, 5, 4, 3, 2]) === Number(d[8]);
}

// Bank account: 11 digits, often written 1234.56.78903
export function isValidBankAccount(value) {
  const d = String(value ?? '').replace(/[\s.]/g, '');
  if (!/^\d{11}$/.test(d)) return false;
  return mod11(d, [5, 4, 3, 2, 7, 6, 5, 4, 3, 2]) === Number(d[10]);
}

export const digitsOnly = (value) => String(value ?? '').replace(/\D/g, '');
