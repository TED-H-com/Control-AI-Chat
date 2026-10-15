import type { ScreenDefinition } from './catalog.js';

function normalized(pathname:string):string{
  return pathname.length>1?pathname.replace(/\/+$/,''):pathname;
}

/** Admin screens are exact routes; record details stay in their in-screen drawers. */
export function resolveAdminScreen(pathname:string,screens:readonly ScreenDefinition[]):ScreenDefinition|null{
  const path=normalized(pathname);
  return screens.find(screen=>screen.path===path)??null;
}
