export type ToneKey='default'|'concise'|'detailed'|'formal'|'friendly';
export type RoleKey='default'|'coach'|'creative'|'critic'|'debate'|'support';

const ROLES:Readonly<Partial<Record<RoleKey,string>>>={
  coach:'Act as a supportive coach and mentor. Ask clarifying questions when useful, encourage the user, and guide them toward their own solutions with constructive, actionable feedback.',
  creative:"Act as a creative partner. Offer imaginative ideas and alternatives, build on the user's suggestions, and explore possibilities while staying relevant to the goal.",
  critic:"Act as a critical reviewer. Rigorously evaluate the user's work or ideas, identify weaknesses, risks, and gaps, and give specific, honest, constructive criticism.",
  debate:"Act as a debate partner. Respectfully challenge the user's assumptions, present counterarguments and alternative viewpoints, and stress-test the user's reasoning.",
  support:"Respond with empathy and emotional support. Acknowledge the user's feelings, reply with warmth and patience, and offer encouragement — while being clear you are not a substitute for professional help.",
};

const PERSONAS:Readonly<Partial<Record<ToneKey,string>>>={
  concise:'Respond concisely. Lead with the answer, keep it brief and well-structured, and omit unnecessary preamble.',
  detailed:'Respond thoroughly. Explain your reasoning, note important caveats and edge cases, and organize longer answers with clear structure.',
  formal:'Adopt a formal, professional register suitable for executive and compliance audiences. Avoid slang and casual phrasing.',
  friendly:'Adopt a warm, approachable tone. Use plain language and a supportive, encouraging style while staying accurate.',
};

export function personaPrompt(tone:ToneKey|string|null|undefined):string|null{
  return tone==='default'||tone==null?null:PERSONAS[tone as ToneKey]??null;
}

export function rolePrompt(role:RoleKey|string|null|undefined):string|null{
  return role==='default'||role==null?null:ROLES[role as RoleKey]??null;
}

export function composePersona(role:RoleKey|string|null|undefined,tone:ToneKey|string|null|undefined):string|null{
  const parts=[rolePrompt(role),personaPrompt(tone)].filter((part):part is string=>part!==null);
  return parts.length?parts.join('\n\n'):null;
}
