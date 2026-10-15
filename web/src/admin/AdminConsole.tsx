import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { runtimeTranslation, useI18n } from '../i18n/index.js';
import { getCapabilities } from './api.js';
import { canAccess, canWrite, SCREENS, type GroupKey, type ScreenKey } from './catalog.js';
import { ErrorPanel, Loading } from './components.js';
import { GenericScreen } from './GenericScreen.js';
import { Overview } from './Overview.js';
import { PolicyEditor } from './PolicyEditor.js';
import { CustomTerms } from './CustomTerms.js';
import { Compliance } from './Compliance.js';
import { Violations } from './Violations.js';
import { Retention } from './Retention.js';
import type { AdminCapabilities, AdminPermission } from './types.js';
import './admin.css';
import { useDeployment } from '../deployment.js';
import { writeAdminHistory, type AdminQueryNavigationOptions } from './filtering.js';
import { useMobileDrawer } from '../accessibility/mobileDrawer.js';
import { resolveAdminScreen } from './routes.js';
import { NotFoundPage } from '../NotFoundPage.js';
import { useDocumentTitle } from '../documentTitle.js';
import { PRODUCT_NAME } from '@shared/brand.js';
import { TopBar } from '../ui/TopBar.js';
import { LanguageSwitcher } from '../i18n/LanguageSwitcher.js';

interface NavGroup {
  readonly key: Exclude<GroupKey,'overview'>;
  readonly screens: readonly ScreenKey[];
}

const NAV_GROUPS: readonly NavGroup[] = [
  {key:'protection',screens:['policies','custom-terms','compliance','detectors']},
  {key:'review',screens:['violations']},
  {key:'records',screens:['audit','analytics','assets']},
  {key:'organization',screens:['users','groups','roles']},
  {key:'models',screens:['models','assistants','providers','budgets']},
  {key:'settings',screens:['retention','settings']},
];

function currentScreen(){
  return resolveAdminScreen(location.pathname,SCREENS);
}

export function AdminConsole(){
  const {t}=useI18n();
  const deployment=useDeployment(),brand=deployment.brandName?.trim()||PRODUCT_NAME;
  const label=(key:string)=>runtimeTranslation(t,'admin.screens',key);
  const [caps,setCaps]=useState<AdminCapabilities|null>(null);
  const [screen,setScreen]=useState(currentScreen);
  const [params,setParams]=useState(()=>new URLSearchParams(location.search));
  const [error,setError]=useState<Error|null>(null);
  const [menu,setMenu]=useState(false);
  const menuRef=useRef<HTMLElement>(null),menuTriggerRef=useRef<HTMLButtonElement>(null),mainRef=useRef<HTMLElement>(null),focusAfterLoad=useRef(false);
  const menuActive=useMobileDrawer({open:menu,onClose:()=>setMenu(false),mediaQuery:'(max-width: 1023px)',drawerRef:menuRef,triggerRef:menuTriggerRef,backgroundRef:mainRef});
  const routeKnown=screen!==null;
  useDocumentTitle(screen?label(screen.key):t('common.notFound.title'));
  const load=useCallback(async()=>{try{setCaps(await getCapabilities());setError(null)}catch(caught){setError(caught instanceof Error?caught:new Error(t('admin.shell.permissionsError')))}},[t]);
  useEffect(()=>{if(routeKnown)void load()},[load,routeKnown]);
  useEffect(()=>{if(caps&&focusAfterLoad.current){focusAfterLoad.current=false;mainRef.current?.focus()}},[caps]);
  useEffect(()=>{const sync=()=>{setScreen(currentScreen());setParams(new URLSearchParams(location.search))};addEventListener('popstate',sync);return()=>removeEventListener('popstate',sync)},[]);
  const go=(path:string,next=new URLSearchParams(),options?:AdminQueryNavigationOptions)=>{writeAdminHistory(history,path,next,options);setScreen(currentScreen());setParams(next);setMenu(false)};
  const permitted=useMemo(()=>caps?SCREENS.filter(item=>canAccess(item,caps.permissions)):[],[caps]);
  if(!screen)return <NotFoundPage area="admin"/>;
  if(error)return <main className="ui-boot" tabIndex={-1}><ErrorPanel error={error} retry={()=>{focusAfterLoad.current=true;void load()}}/></main>;
  if(!caps)return <main className="ui-boot"><Loading/></main>;
  const screenAvailable=canAccess(screen,caps.permissions);
  if(!screenAvailable){
    const first=permitted[0];
    return <main className="ui-boot"><div className="ui-forbidden"><strong>{t('admin.shell.accessDenied')}</strong><p>{t('admin.shell.accessDeniedBody')}</p>{first&&<button className="ui-button ui-primary" onClick={()=>go(first.path)}>{t('admin.shell.goTo',{screen:label(first.key)})}</button>}</div></main>;
  }
  const overview=permitted.find(item=>item.key==='overview');
  const groups=NAV_GROUPS.flatMap(group=>{
    const screens=group.screens.flatMap(key=>{const found=permitted.find(item=>item.key===key);return found?[found]:[]});
    return screens.length?[{...group,screens}]:[];
  });
  const has=(permission:AdminPermission)=>caps.permissions.includes(permission);
  const workspaceName=caps.tenant?.name?.trim()||caps.tenantName?.trim()||caps.tenant?.slug?.trim()||caps.tenantSlug?.trim()||t('admin.shell.workspace');
  const navList=(items:typeof permitted,ariaLabelledby?:string)=><ul aria-labelledby={ariaLabelledby} aria-label={ariaLabelledby?undefined:label('overview')}>{items.map(item=><li key={item.key}><a href={item.path} aria-current={item.key===screen.key?'page':undefined} onClick={event=>{event.preventDefault();go(item.path)}}>{label(item.key)}</a></li>)}</ul>;
  return <div className="ui-admin">
    <TopBar
      surface="admin"
      contextLabel={t('admin.shell.console')}
      menuLabel={t('admin.shell.navigation')}
      onOpenNavigation={()=>setMenu(value=>!value)}
      navigationOpen={menuActive}
      navigationControls="ui-admin-navigation"
      navigationTriggerRef={menuTriggerRef}
      brandName={brand}
      brandIconUrl={deployment.brandIconUrl}
      actions={<a className="ui-button ui-ghost ui-admin-back" href="/chat">{t('admin.shell.backToChat')}</a>}
    />
    {menuActive&&<div className="ui-admin-nav-backdrop" aria-hidden="true" onClick={()=>setMenu(false)}/>}
    <aside id="ui-admin-navigation" ref={menuRef} className={menuActive?'open':''} aria-label={t('admin.shell.navigation')} role={menuActive?'dialog':undefined} aria-modal={menuActive||undefined} tabIndex={menuActive?-1:undefined}>
      <button type="button" className="ui-admin-menu-close ui-icon-button" title={t('common.close')} aria-label={t('common.close')} onClick={()=>setMenu(false)}><X size={18}/></button>
      <nav aria-label={t('admin.shell.navigation')}>
        {overview&&navList([overview])}
        {groups.map(group=>{const headingId=`ui-admin-nav-${group.key}`;return <section key={group.key}>
          <h2 id={headingId}>{runtimeTranslation(t,'admin.navGroup',group.key)}</h2>
          {navList(group.screens,headingId)}
        </section>})}
      </nav>
      <footer className="ui-workspace-context">
        <div className="ui-admin-drawer-only"><LanguageSwitcher/><a className="ui-button ui-ghost" href="/chat">{t('admin.shell.backToChat')}</a></div>
        <span>{t('admin.shell.tenant')}</span><strong title={workspaceName}>{workspaceName}</strong>
      </footer>
    </aside>
    <main ref={mainRef} tabIndex={-1}>
      {screen.key==='overview'?<Overview params={params} navigate={(next,options)=>go(screen.path,next,options)} timeZone={caps.tenantTimezone}/>
        :screen.key==='policies'?<PolicyEditor permissions={caps.permissions}/>
        :screen.key==='compliance'?<Compliance/>
        :screen.key==='custom-terms'?<CustomTerms canWrite={has('policy:write')}/>
        :screen.key==='violations'?<Violations params={params} navigate={(next,options)=>go(screen.path,next,options)} canDecide={has('approval:decide')} timeZone={caps.tenantTimezone}/>
        :screen.key==='retention'?<Retention screen={screen} params={params} navigate={(next,options)=>go(screen.path,next,options)} canManage={has('legal_hold:manage')} canOpenSettings={has('admin:settings')} onNavigateSettings={()=>go('/admin/settings')} timeZone={caps.tenantTimezone}/>
        :<GenericScreen screen={screen} params={params} navigate={(next,options)=>go(screen.path,next,options)} canWrite={canWrite(screen,caps.permissions)} assignableRoles={caps.assignableRoles} timeZone={caps.tenantTimezone}/>}
    </main>
  </div>;
}

export default AdminConsole;
