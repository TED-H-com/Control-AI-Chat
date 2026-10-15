const DAY_MS=24*60*60*1_000;
const MINUTE_MS=60_000;
const ISO_DATE=/^(\d{4})-(\d{2})-(\d{2})$/u;
const LOCAL_DATE_TIME=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u;
const FORMATTERS=new Map<string,Intl.DateTimeFormat>();

function formatter(timeZone:string):Intl.DateTimeFormat {
  let value=FORMATTERS.get(timeZone);
  if(!value){value=new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});FORMATTERS.set(timeZone,value)}
  return value;
}

function partsAt(instantMs:number,timeZone:string):Record<string,string> {
  return Object.fromEntries(formatter(timeZone).formatToParts(instantMs).map(part=>[part.type,part.value]));
}

function isoParts(instantMs:number,timeZone:string):string {
  const values=partsAt(instantMs,timeZone);
  return `${values.year}-${values.month}-${values.day}`;
}

export function zonedDate(instantMs:number,timeZone:string):string {
  return isoParts(instantMs,timeZone);
}

export function zonedDayStart(date:string,timeZone:string):number {
  const match=ISO_DATE.exec(date);
  if(!match)throw new RangeError('date must use YYYY-MM-DD');
  const nominal=Date.UTC(Number(match[1]),Number(match[2])-1,Number(match[3]));
  if(new Date(nominal).toISOString().slice(0,10)!==date)throw new RangeError('date must be valid');
  formatter(timeZone);
  let low=nominal-2*DAY_MS,high=nominal+2*DAY_MS;
  while(low<high){const middle=low+Math.floor((high-low)/2);if(isoParts(middle,timeZone)<date)low=middle+1;else high=middle}
  if(isoParts(low,timeZone)!==date)throw new RangeError(`date does not exist in ${timeZone}`);
  return low;
}

export function nextIsoDate(date:string):string {
  const match=ISO_DATE.exec(date);
  if(!match)throw new RangeError('date must use YYYY-MM-DD');
  const nominal=Date.UTC(Number(match[1]),Number(match[2])-1,Number(match[3]));
  if(new Date(nominal).toISOString().slice(0,10)!==date)throw new RangeError('date must be valid');
  return new Date(nominal+DAY_MS).toISOString().slice(0,10);
}

function localDateTimeAt(instantMs:number,timeZone:string):string {
  const parts=partsAt(instantMs,timeZone);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

function offsetAt(instantMs:number,timeZone:string):number {
  const parts=partsAt(instantMs,timeZone);
  return Date.UTC(Number(parts.year),Number(parts.month)-1,Number(parts.day),Number(parts.hour),Number(parts.minute),Number(parts.second))-instantMs;
}

export function zonedDateTime(instant:unknown,timeZone:string):string {
  const parsed=typeof instant==='number'?instant:typeof instant==='string'?Date.parse(instant):NaN;
  return Number.isFinite(parsed)?localDateTimeAt(parsed,timeZone):'';
}

/** Converts a datetime-local value without consulting the browser's own zone. */
export function zonedDateTimeInstant(value:string,timeZone:string):number {
  const match=LOCAL_DATE_TIME.exec(value);
  if(!match)throw new RangeError('date and time must use YYYY-MM-DDTHH:mm');
  const nominal=Date.UTC(Number(match[1]),Number(match[2])-1,Number(match[3]),Number(match[4]),Number(match[5]));
  if(new Date(nominal).toISOString().slice(0,16)!==value)throw new RangeError('date and time must be valid');
  const before=nominal-DAY_MS,after=nominal+DAY_MS,offsets=new Set<number>([offsetAt(before,timeZone),offsetAt(nominal,timeZone),offsetAt(after,timeZone)]);
  let guess=nominal;
  for(let iteration=0;iteration<6;iteration++){
    const offset=offsetAt(guess,timeZone),next=nominal-offset;offsets.add(offset);
    if(next===guess)break;
    guess=next;
  }
  const matches=[...offsets].map(offset=>nominal-offset).filter(instant=>localDateTimeAt(instant,timeZone)===value).sort((left,right)=>left-right);
  if(matches.length>0)return matches[0]!;

  const beforeOffset=offsetAt(before,timeZone),afterOffset=offsetAt(after,timeZone);
  if(afterOffset>beforeOffset){
    let low=Math.floor(before/MINUTE_MS),high=Math.ceil(after/MINUTE_MS);
    while(low+1<high){const middle=low+Math.floor((high-low)/2);if(offsetAt(middle*MINUTE_MS,timeZone)===beforeOffset)low=middle;else high=middle}
    const transition=high*MINUTE_MS,gapStart=transition+beforeOffset,gapEnd=transition+afterOffset;
    if(nominal>=gapStart&&nominal<gapEnd)return transition;
  }
  throw new RangeError(`date and time does not exist in ${timeZone}`);
}
