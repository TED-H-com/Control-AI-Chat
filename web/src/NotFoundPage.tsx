import { useDocumentTitle } from './documentTitle.js';
import { useI18n, type Translate } from './i18n/index.js';
import { Seal } from './ui/Seal.js';

export function NotFoundContent({area,t}:{area:'app'|'admin';t:Translate}){
  const destination=area==='admin'?'/admin':'/chat';
  return <main className="ui-route-not-found">
    <section aria-labelledby="ui-not-found-title">
      <Seal size={40}/>
      <p>404</p>
      <h1 id="ui-not-found-title">{t('common.notFound.title')}</h1>
      <span>{t('common.notFound.body')}</span>
      <a href={destination}>{area==='admin'?t('common.notFound.backToAdmin'):t('common.notFound.backToChat')}</a>
    </section>
  </main>;
}

export function NotFoundPage({area}:{area:'app'|'admin'}){
  const {t}=useI18n();
  const title=t('common.notFound.title');
  useDocumentTitle(title);
  return <NotFoundContent area={area} t={t}/>;
}
