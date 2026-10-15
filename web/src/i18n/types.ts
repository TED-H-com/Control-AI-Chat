export const locales = ['en', 'zh-TW', 'ja'] as const;
export type Locale = (typeof locales)[number];

export type PluralMessage = Readonly<{ one?: string; other: string; zero?: string }>;
export type Message = string | PluralMessage;
export type CatalogueShape<T> = { readonly [K in keyof T]: T[K] extends string | PluralMessage ? Message : CatalogueShape<T[K]> };

type Join<A extends string, B extends string> = `${A}.${B}`;
export type MessageKey<T> = { [K in keyof T & string]: T[K] extends Message ? K : T[K] extends object ? Join<K, MessageKey<T[K]>> : never }[keyof T & string];
type AtPath<T, P extends string> = P extends `${infer H}.${infer R}` ? H extends keyof T ? AtPath<T[H], R> : never : P extends keyof T ? T[P] : never;
type TextOf<T> = T extends string ? T : T extends PluralMessage ? T[keyof T] & string : never;
type Vars<S extends string> = S extends `${string}{${infer V}}${infer R}` ? V | Vars<R> : never;
export type InterpolationFor<T, K extends MessageKey<T>> = { [P in Vars<TextOf<AtPath<T, K>>>]: string | number | Date } & (AtPath<T,K> extends PluralMessage ? {count:number} : object);
export type TranslationArgs<T,K extends MessageKey<T>> = [Vars<TextOf<AtPath<T,K>>>] extends [never] ? [] : [InterpolationFor<T,K>];

export function isLocale(value: unknown): value is Locale { return typeof value === 'string' && (locales as readonly string[]).includes(value); }
