const LETTER_VALUES:Readonly<Record<string,number>>={A:1,B:2,C:3,D:4,E:5,F:6,G:7,H:8,J:1,K:2,L:3,M:4,N:5,P:7,R:9,S:2,T:3,U:4,V:5,W:6,X:7,Y:8,Z:9};
const WEIGHTS=[8,7,6,5,4,3,2,10,0,9,8,7,6,5,4,3,2] as const;

export function vinValid(vin:string):boolean {const normalized=vin.toUpperCase();if(!/^[A-HJ-NPR-Z0-9]{17}$/.test(normalized))return false;let sum=0;for(let index=0;index<normalized.length;index++){const character=normalized[index]!,value=/\d/.test(character)?Number(character):LETTER_VALUES[character];if(value===undefined)return false;sum+=value*WEIGHTS[index]!}const remainder=sum%11,expected=remainder===10?'X':String(remainder);return normalized[8]===expected}
