const WEIGHTS=[1,2,1,2,1,2,4,1] as const;
export function twBusinessIdValid(value:string):boolean {if(!/^\d{8}$/.test(value))return false;let total=0;for(let index=0;index<8;index++){const product=Number(value[index])*WEIGHTS[index]!;total+=Math.floor(product/10)+product%10}return total%5===0||(value[6]==='7'&&(total+1)%5===0)}
