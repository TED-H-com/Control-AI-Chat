import type { MiddlewareHandler } from 'hono';

const SAFE_METHODS = new Set(['GET','HEAD','OPTIONS']);

export interface CsrfOptions { readonly allowedOrigins:ReadonlySet<string>; }

/** Origin-based CSRF protection for cookie-authenticated browser requests. */
export function csrfProtection(options:CsrfOptions):MiddlewareHandler {
  return async (c,next) => {
    if (SAFE_METHODS.has(c.req.method)) return next();
    const origin=c.req.header('Origin');
    if (!origin || !options.allowedOrigins.has(normalizeOrigin(origin))) {
      return c.json({error:{code:'CSRF_REJECTED',message:'A trusted Origin header is required',retryable:false}},403);
    }
    await next();
  };
}

function normalizeOrigin(value:string):string {
  try { return new URL(value).origin.toLowerCase(); } catch { return ''; }
}

