// Errors that are safe to print. Everything the handoff code shows a user goes
// through here, so a stray exception can never echo a cookie or the bridge token.
const SAFE = Symbol('huashuHandoffSafe');
const CONTROL = /[\u0000-\u001f\u007f]/g;

export function safeError(message, code = 'HANDOFF') {
  const error = new Error(String(message).replace(CONTROL, ' ').slice(0, 400));
  error.code = code;
  Object.defineProperty(error, SAFE, { value: true });
  return error;
}

export const isSafe = (error) => !!error?.[SAFE];

/** Keep our own errors, replace anything else with a generic one. */
export function sanitize(error, fallback = 'Session handoff failed') {
  return isSafe(error) ? error : safeError(fallback);
}
