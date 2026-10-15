export function detectLanguage(text: string): string | null {
  const sample=Array.from(text.slice(0,10_000)); if(sample.length<20) return null;
  const han=sample.filter(c=>/[\u3400-\u9fff]/u.test(c)).length;
  const latin=sample.filter(c=>/[A-Za-z]/.test(c)).length;
  if(han/sample.length>.15) return 'zh';
  if(latin/sample.length>.35) return 'en';
  return null;
}

