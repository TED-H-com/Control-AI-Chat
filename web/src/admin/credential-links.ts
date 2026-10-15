import type {CredentialLinkResponse,DeliveredCredentialLink} from '@shared/api';

export type CredentialDialogAction={type:'open';value:DeliveredCredentialLink}|{type:'close'};
export function credentialDialogReducer(_state:DeliveredCredentialLink|null,action:CredentialDialogAction):DeliveredCredentialLink|null{return action.type==='open'?action.value:null}
export function credentialLinkOutcome(value:CredentialLinkResponse|undefined):'link'|'reissue'|'none' {return value&&'reissueRequired'in value?'reissue':value&&'url'in value?'link':'none'}
export function isDeliveredCredentialLink(value:CredentialLinkResponse|undefined):value is DeliveredCredentialLink{return credentialLinkOutcome(value)==='link'}
