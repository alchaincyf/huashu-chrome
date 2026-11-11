// What a script receives on stdin. Pick with --format.
//   json           { format, grant, profile, captured_at, userAgent, cookies[], skipped_partitioned }
//                  cookies keep Chrome's field names (expirationDate in seconds, sameSite lowercase)
//   storage-state  Playwright's storageState shape: browser.newContext({ storageState })
//   netscape       cookies.txt for curl -b, yt-dlp --cookies, wget --load-cookies
export const FORMATS = ['json', 'storage-state', 'netscape'];

const PLAYWRIGHT_SAME_SITE = { no_restriction: 'None', lax: 'Lax', strict: 'Strict', unspecified: 'Lax' };

export function formatSession(session, format = 'json') {
  if (format === 'json') {
    return JSON.stringify({ format: 'huashu-session/v1', ...session }) + '\n';
  }
  if (format === 'storage-state') {
    return JSON.stringify({
      cookies: session.cookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        expires: c.session ? -1 : c.expirationDate,
        httpOnly: c.httpOnly,
        secure: c.secure,
        sameSite: PLAYWRIGHT_SAME_SITE[c.sameSite] || 'Lax',
      })),
      origins: [],
    }) + '\n';
  }
  if (format === 'netscape') {
    const lines = ['# Netscape HTTP Cookie File', `# huashu-chrome ${session.grant} ${session.captured_at}`];
    for (const c of session.cookies) {
      // Host-only cookies have no leading dot and must not match subdomains.
      const sub = c.domain.startsWith('.') ? 'TRUE' : 'FALSE';
      const expires = c.session ? 0 : Math.floor(c.expirationDate);
      lines.push([(c.httpOnly ? '#HttpOnly_' : '') + c.domain, sub, c.path, c.secure ? 'TRUE' : 'FALSE', expires, c.name, c.value].join('\t'));
    }
    return lines.join('\n') + '\n';
  }
  throw new Error(`unknown format ${format}`);
}

/** What `run` prints without a command: metadata only, never a cookie value. */
export function summarize(session) {
  const expiries = session.cookies.filter((c) => !c.session).map((c) => c.expirationDate);
  return {
    ok: true,
    grant: session.grant,
    profile: session.profile,
    tab_id: session.tabId,
    captured_at: session.captured_at,
    cookie_count: session.cookies.length,
    session_cookie_count: session.cookies.filter((c) => c.session).length,
    earliest_cookie_expiration_at: expiries.length ? new Date(Math.min(...expiries) * 1_000).toISOString() : null,
    skipped_partitioned: session.skipped_partitioned,
  };
}
