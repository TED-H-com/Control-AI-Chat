/** Conservative local estimate shared by budgeting, context assembly, and provider fallbacks. */
export function estimateUtf8Tokens(text:string):number {
  return Math.ceil(Buffer.byteLength(text,'utf8')/3);
}

export function estimateRequiredInputTokens(text:string):number {
  return Math.max(1,estimateUtf8Tokens(text));
}
