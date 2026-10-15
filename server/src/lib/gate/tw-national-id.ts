const LETTER_CODES:Readonly<Record<string,number>>={A:10,B:11,C:12,D:13,E:14,F:15,G:16,H:17,I:34,J:18,K:19,L:20,M:21,N:22,O:35,P:23,Q:24,R:25,S:26,T:27,U:28,V:29,W:32,X:30,Y:31,Z:33};

export function twLetterCode(letter:string):number|undefined{return LETTER_CODES[letter.toUpperCase()]}
export function twIdentityChecksumValid(value:string,secondDigits:readonly number[]):boolean {const normalized=value.toUpperCase(),code=twLetterCode(normalized[0]??'');if(code===undefined)return false;const digits=Array.from(normalized.slice(1),Number);if(digits.length!==9||digits.some(Number.isNaN))return false;let sum=Math.floor(code/10)+(code%10)*9;for(let index=0;index<8;index++)sum+=digits[index]!*(8-index);sum+=digits[8]!;return secondDigits.includes(digits[0]!)&&sum%10===0}
export function twNationalIdValid(value:string):boolean {return /^[A-Z][12]\d{8}$/i.test(value)&&twIdentityChecksumValid(value,[1,2])}
