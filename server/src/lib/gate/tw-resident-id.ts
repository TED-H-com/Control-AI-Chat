import { twIdentityChecksumValid,twLetterCode } from './tw-national-id.js';

const SECOND_LETTER:Readonly<Record<string,number>>={A:0,B:1,C:2,D:3};
export function twResidentIdValid(value:string):boolean {const normalized=value.toUpperCase();if(/^[A-Z][89]\d{8}$/.test(normalized))return twIdentityChecksumValid(normalized,[8,9]);if(!/^[A-Z][A-D]\d{8}$/.test(normalized))return false;const first=normalized[0]!,second=SECOND_LETTER[normalized[1]!]!,digits=Array.from(normalized.slice(2),Number),code=twLetterCode(first);if(code===undefined)return false;
  // This old-format weighting follows common practice; no official publication of the rule was found.
  let sum=Math.floor(code/10)+(code%10)*9+second*8;for(let index=0;index<7;index++)sum+=digits[index]!*(7-index);return (sum+digits[7]!)%10===0}
