import type { ChatCapabilities } from './api.js';

/** The provider screen needs read access to open and write access to change credentials. */
export function canConfigureProviders(capabilities:Pick<ChatCapabilities,'permissions'>|null):boolean {
  return Boolean(capabilities
    && capabilities.permissions.includes('model:read')
    && capabilities.permissions.includes('model:write'));
}
