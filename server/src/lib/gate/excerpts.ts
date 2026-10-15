import type { TextSpan } from './types.js';
import { sliceCodePoints } from './normalize.js';
export function safeExcerpt(text:string,span:TextSpan,label:string,suffix=''):string {const before=sliceCodePoints(text,{start:Math.max(0,span.start-24),end:span.start}),after=sliceCodePoints(text,{start:span.end,end:span.end+24});return `${before}[${label}${suffix}]${after}`.replace(/[\r\n\t]+/g,' ').slice(0,160) }
export function maskedLastFour(text:string):string {let digits='';for(let index=text.length-1;index>=0&&digits.length<4;index--){const code=text.charCodeAt(index);if(code>=48&&code<=57)digits=text[index]+digits}return digits}
