import type { MiddlewareHandler } from 'hono';

export const applicationCsp=(appOrigin=process.env.APP_ORIGIN?.trim()||'http://localhost:5173')=>`default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ${appOrigin.replace(/\/$/,'')}; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'; upgrade-insecure-requests`;

export function securityHeaders(options:{readonly contentSecurityPolicy?:string}={}):MiddlewareHandler {
  return async (c,next) => {
    await next();
    c.header('Strict-Transport-Security','max-age=31536000; includeSubDomains');
    c.header('X-Content-Type-Options','nosniff');
    c.header('X-Frame-Options','DENY');
    c.header('Referrer-Policy','strict-origin-when-cross-origin');
    c.header('Permissions-Policy','camera=(), microphone=(), geolocation=(), payment=(), browsing-topics=()');
    c.header('Cross-Origin-Opener-Policy','same-origin');
    c.header('Content-Security-Policy',options.contentSecurityPolicy??applicationCsp());
    if (c.req.path.startsWith('/api/')) c.header('Cache-Control','no-store');
  };
}
