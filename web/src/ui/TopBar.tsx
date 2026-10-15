import { Menu } from 'lucide-react';
import type { ReactNode, Ref } from 'react';
import { LanguageSwitcher } from '../i18n/LanguageSwitcher.js';
import { Seal } from './Seal.js';

interface TopBarProps {
  readonly contextLabel: string;
  readonly menuLabel: string;
  readonly onOpenNavigation: () => void;
  readonly navigationOpen: boolean;
  readonly navigationControls: string;
  readonly navigationTriggerRef?: Ref<HTMLButtonElement>;
  readonly brandName: string;
  readonly brandIconUrl?: string | null;
  readonly actions?: ReactNode;
  readonly surface?: 'chat' | 'admin';
}

export function TopBar({
  contextLabel,
  menuLabel,
  onOpenNavigation,
  navigationOpen,
  navigationControls,
  navigationTriggerRef,
  brandName,
  brandIconUrl,
  actions,
  surface = 'chat',
}: TopBarProps): JSX.Element {
  return <header className={`ui-topbar ui-topbar--${surface}`}>
    <div className="ui-topbar__left">
      <button
        ref={navigationTriggerRef}
        type="button"
        className="ui-mobile-menu ui-icon-button"
        title={menuLabel}
        onClick={onOpenNavigation}
        aria-label={menuLabel}
        aria-expanded={navigationOpen}
        aria-controls={navigationControls}
      >
        <Menu size={18}/>
      </button>
      <span className="ui-topbar__brand">
        {brandIconUrl?<img src={brandIconUrl} alt="" width="28" height="28"/>:<Seal/>}
        <strong>{brandName}</strong>
      </span>
      <span className="ui-topbar__divider" aria-hidden="true"/>
      <span className="ui-topbar__title" title={contextLabel}>{contextLabel}</span>
    </div>
    <div className="ui-topbar__actions">
      <LanguageSwitcher className="ui-topbar__language"/>
      {actions}
    </div>
  </header>;
}
