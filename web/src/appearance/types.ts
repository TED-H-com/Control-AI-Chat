export const COLOR_MODE_PREFERENCES=['light','dark','system'] as const;
export type ColorModePreference=(typeof COLOR_MODE_PREFERENCES)[number];
export type ResolvedColorMode=Exclude<ColorModePreference,'system'>;
export const DENSITIES=['comfortable','compact'] as const;
export type Density=(typeof DENSITIES)[number];
export interface AppearancePreference{readonly mode:ColorModePreference;readonly density:Density}
export interface AppearanceContextValue extends AppearancePreference{readonly resolvedMode:ResolvedColorMode;readonly setMode:(mode:ColorModePreference)=>Promise<void>;readonly setDensity:(density:Density)=>Promise<void>;readonly isSaving:boolean;readonly saveError:'network'|'unauthorized'|'invalid_preference'|null}
