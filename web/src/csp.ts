import type {Plugin} from 'vite';

export const CONTENT_SECURITY_POLICY="default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: blob:; font-src 'self'; object-src 'none'; base-uri 'self'";

export const productionCspPlugin:Plugin={
 name:'production-csp',
 transformIndexHtml:{
  order:'post',
  handler:(html,context)=>context.bundle?html.replace('    <script src="/bootstrap.js"></script>',`    <meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}" />\n    <script src="/bootstrap.js"></script>`):html,
 },
};
