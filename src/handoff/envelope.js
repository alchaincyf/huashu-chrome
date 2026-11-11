// Decrypt and validate a handoff_session reply. The private key never leaves
// this process; the plaintext is checked field by field against the grant the
// extension reported, so a malformed or mismatched session is refused here.
import { webcrypto } from 'node:crypto';
import { safeError, isSafe } from './errors.js';

export const HANDOFF_FORMAT = 'huashu-session/v1';
export const handoffAad = (grantId) => `${HANDOFF_FORMAT}:${grantId}`;

const MAX_ENVELOPE_BYTES = 4 * 1024 * 1024;
const MAX_COOKIES = 1_000;
const COOKIE_FIELDS = new Set(['name', 'value', 'domain', 'path', 'secure', 'httpOnly', 'sameSite', 'session', 'expirationDate']);
const PAYLOAD_FIELDS = new Set(['grant', 'captured_at', 'cookies', 'skipped_partitioned', 'userAgent']);
const SAME_SITE = new Set(['no_restriction', 'lax', 'strict', 'unspecified']);
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

const invalid = () => safeError('The session from Chrome is malformed.', 'BAD_SESSION');

export async function newKeyPair(crypto = webcrypto) {
  try {
    const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey']);
    return { privateKey: pair.privateKey, publicJwk: await crypto.subtle.exportKey('jwk', pair.publicKey) };
  } catch {
    throw safeError('Could not prepare session encryption.', 'CRYPTO');
  }
}

function decodeBase64(value, maxBytes) {
  if (typeof value !== 'string' || value.length > Math.ceil(maxBytes * 4 / 3) + 4
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw invalid();
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length > maxBytes || decoded.toString('base64') !== value) throw invalid();
  return decoded;
}

function validatePublicJwk(jwk) {
  if (!jwk || typeof jwk !== 'object' || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || Object.hasOwn(jwk, 'd')
      || typeof jwk.x !== 'string' || typeof jwk.y !== 'string'
      || !/^[A-Za-z0-9_-]{43}$/.test(jwk.x) || !/^[A-Za-z0-9_-]{43}$/.test(jwk.y)) throw invalid();
}

function domainAllowed(domain, cookieDomains) {
  return cookieDomains.includes(domain.toLowerCase().replace(/^\./, ''));
}

function validCookie(c) {
  return c && typeof c === 'object' && !Array.isArray(c)
    && Object.keys(c).every((k) => COOKIE_FIELDS.has(k))
    && typeof c.name === 'string' && c.name.length >= 1 && c.name.length <= 1_024 && COOKIE_NAME.test(c.name)
    && typeof c.value === 'string' && c.value.length <= 16_384 && !CONTROL.test(c.value) && !c.value.includes(';')
    && typeof c.domain === 'string' && c.domain.length <= 253 && !CONTROL.test(c.domain)
    && typeof c.path === 'string' && c.path.startsWith('/') && c.path.length <= 1_024 && !CONTROL.test(c.path)
    && typeof c.secure === 'boolean' && typeof c.httpOnly === 'boolean'
    && typeof c.sameSite === 'string' && SAME_SITE.has(c.sameSite)
    && typeof c.session === 'boolean'
    && (c.session ? c.expirationDate === undefined : Number.isFinite(c.expirationDate));
}

/**
 * Check a decrypted payload. Cookies outside the grant's domains are an error
 * (the extension should never send them); expired ones are dropped.
 */
export function validatePayload(payload, grant, nowMs = Date.now()) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || Object.keys(payload).some((k) => !PAYLOAD_FIELDS.has(k))
      || payload.grant !== grant.id
      || typeof payload.captured_at !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(payload.captured_at)
      || !Array.isArray(payload.cookies) || payload.cookies.length > MAX_COOKIES
      || !Number.isInteger(payload.skipped_partitioned) || payload.skipped_partitioned < 0
      || (payload.userAgent !== undefined
        && (typeof payload.userAgent !== 'string' || payload.userAgent.length > 512 || CONTROL.test(payload.userAgent)))) {
    throw invalid();
  }
  for (const c of payload.cookies) {
    if (!validCookie(c)) throw invalid();
    if (!domainAllowed(c.domain, grant.cookieDomains)) {
      throw safeError(`Chrome sent a cookie outside the "${grant.id}" grant; refusing the session.`, 'BAD_SESSION');
    }
  }
  const cookies = payload.cookies.filter((c) => c.session || c.expirationDate * 1_000 > nowMs);
  if (!cookies.length) {
    throw safeError(`No ${grant.label || grant.id} login found in that Chrome profile. Sign in there, then retry.`, 'SIGNED_OUT');
  }
  return { ...payload, cookies };
}

export async function decryptEnvelope(envelope, privateKey, grant, { crypto = webcrypto, now = Date.now() } = {}) {
  try {
    if (!envelope || envelope.format !== HANDOFF_FORMAT || envelope.grant !== grant.id) throw invalid();
    validatePublicJwk(envelope.ephemeralPublicKey);
    const iv = decodeBase64(envelope.iv, 12);
    const ciphertext = decodeBase64(envelope.ciphertext, MAX_ENVELOPE_BYTES);
    if (iv.length !== 12 || ciphertext.length < 16) throw invalid();
    const subtle = crypto.subtle;
    const peer = await subtle.importKey('jwk', envelope.ephemeralPublicKey, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const key = await subtle.deriveKey({ name: 'ECDH', public: peer }, privateKey, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const clear = await subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: Buffer.from(handoffAad(grant.id), 'utf8'), tagLength: 128 },
      key, ciphertext,
    );
    const json = new TextDecoder('utf-8', { fatal: true }).decode(clear);
    return validatePayload(JSON.parse(json), grant, now);
  } catch (error) {
    if (isSafe(error)) throw error;
    throw safeError('The session from Chrome could not be decrypted.', 'BAD_SESSION');
  }
}
