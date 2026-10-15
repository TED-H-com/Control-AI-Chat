import { isLocale, type Locale } from './types.js';
export const localeStorageKey='app.locale.v1';
export function localeFromPath(pathname:string):Locale|null { const segment=pathname.split('/').filter(Boolean)[0]; return isLocale(segment)?segment:null; }
export function matchLocale(tags:readonly string[]):Locale { for(const raw of tags){const tag=raw.toLowerCase();if(tag==='en'||tag.startsWith('en-'))return 'en';if(tag==='zh'||tag.startsWith('zh-'))return 'zh-TW';if(tag==='ja'||tag.startsWith('ja-'))return 'ja';}return 'en'; }
export function detectLocale(pathname=location.pathname):Locale { const routed=localeFromPath(pathname);if(routed)return routed;try{const stored=localStorage.getItem(localeStorageKey);if(isLocale(stored))return stored;}catch{}return matchLocale(navigator.languages?.length?navigator.languages:[navigator.language]); }
export function applyLocale(locale:Locale):void { document.documentElement.lang=locale;document.documentElement.dataset.locale=locale; }
