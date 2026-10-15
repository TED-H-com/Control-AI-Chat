import type {ReactNode} from 'react';
import {chatFailureCanRetry,chatFailureText} from './failures.js';
import type {ChatTranslate} from './i18n.js';
import type {ChatFailure,ChatRunRequest} from './types.js';

export function RunFailureNotice({failure,retry,support,onRetry,t}:{failure:ChatFailure;retry:ChatRunRequest|null;support?:ReactNode;onRetry:(request:ChatRunRequest)=>void;t:ChatTranslate}){
  const blocked=failure.kind==='run'&&failure.error.code==='GATE_BLOCKED';
  return <section className="ui-receipt ui-receipt--crimson" data-receipt-kind={blocked?'withheld':'failure'} data-receipt-row="response" role="alert"><div className="ui-receipt__title"><strong>{blocked?t('chat.gate.response.withheld.title'):t('chat.failure.title')}</strong></div><p>{blocked?t('chat.gate.response.withheld.body'):chatFailureText(failure,t)}</p>{blocked&&<p>{t('chat.gate.response.withheld.next')}</p>}{!blocked&&support}{!blocked&&chatFailureCanRetry(failure)&&<button type="button" className="ui-button ui-secondary" disabled={retry===null} onClick={()=>{if(retry)onRetry(retry);}}>{t('common.retry')}</button>}</section>;
}
