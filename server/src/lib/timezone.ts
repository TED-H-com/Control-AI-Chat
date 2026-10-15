export class TimeZoneValidationError extends RangeError {
  constructor(readonly field:string) { super(`${field} must be a valid IANA time zone`); }
}

let supportedTimeZones:Set<string>|undefined;
// Remember a name only when the input is already that resolved name and validation has passed.
const rememberedTimeZones=new Map<string,string>();

function supportedTimeZoneSet():Set<string> {
  if(!supportedTimeZones) supportedTimeZones=new Set(Intl.supportedValuesOf('timeZone'));
  return supportedTimeZones;
}

/** Canonicalizes aliases and case variants, then rejects offsets and non-IANA names. */
export function canonicalTimeZone(value:unknown,field='timezone'):string {
  if(typeof value!=='string'||value.length===0)throw new TimeZoneValidationError(field);
  const remembered=rememberedTimeZones.get(value);
  if(remembered!==undefined)return remembered;
  let canonical:string;
  try { canonical=new Intl.DateTimeFormat('en',{timeZone:value}).resolvedOptions().timeZone; }
  catch { throw new TimeZoneValidationError(field); }
  if(canonical!=='UTC'&&!supportedTimeZoneSet().has(canonical))throw new TimeZoneValidationError(field);
  if(value===canonical)rememberedTimeZones.set(value,canonical);
  return canonical;
}
