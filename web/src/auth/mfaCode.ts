const totpPattern=/^\d{6}$/u;
const recoveryPattern=/^[A-Z0-9]{5}-[A-Z0-9]{5}$/u;
const compactRecoveryPattern=/^[A-Z0-9]{10}$/u;

/** Normalize pasted MFA input to the exact value accepted by the login service. */
export function normalizeMfaCode(value:string):string{
  const compact=value.replace(/\s/gu,'').toUpperCase();
  return compactRecoveryPattern.test(compact)?`${compact.slice(0,5)}-${compact.slice(5)}`:compact;
}

/** Return a submission-safe TOTP or recovery code, or null while the input is incomplete/invalid. */
export function mfaCodeForSubmission(value:string):string|null{
  const normalized=normalizeMfaCode(value);
  return totpPattern.test(normalized)||recoveryPattern.test(normalized)?normalized:null;
}
