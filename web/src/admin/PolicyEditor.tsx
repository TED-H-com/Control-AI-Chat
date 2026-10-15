import { useEffect, useId, useRef, useState } from 'react';
import type { GateAction, GateDirection } from '@shared/api';
import { runtimeTranslation, useI18n, type Translate } from '../i18n/index.js';
import { adminGet, createAdminWrite } from './api.js';
import { Drawer, Empty, ErrorPanel, Loading, PageHead, Status, valueText } from './components.js';
import {errorText} from '../error-message.js';
import type {
  AdminPage,
  AdminPermission,
  DetectorRecord,
  GateRuleRecord,
  PolicyRecord,
  PolicyTestResult,
} from './types.js';

interface ScopeTarget {id:string;name?:string;displayName?:string;email?:string}

export const POLICY_ACTIONS:readonly GateAction[]=['allow','flag','redact','mask','warn','block','require_approval'];
const severities:GateRuleRecord['severity'][]=['low','medium','high','critical'];
type PolicyDirection=Exclude<GateDirection,'file'>;
export const POLICY_DIRECTIONS:readonly PolicyDirection[]=['outbound','inbound'];
export const POLICY_SCOPES:readonly GateRuleRecord['scope_type'][]=['tenant','group','user','model'];

export interface RuleDraft {
  id:string|null;
  version:number|null;
  policyId:string;
  policyName:string;
  detectorId:string;
  detectorKey:string;
  detectorKind:DetectorRecord['detectorKind'];
  direction:PolicyDirection;
  action:GateAction;
  severity:GateRuleRecord['severity'];
  config:Record<string,unknown>;
  enabled:boolean;
  priority:number;
  scopeType:GateRuleRecord['scope_type'];
  scopeId:string|null;
}

function parseConfig(value:string):Record<string,unknown> {
  try {
    const parsed=JSON.parse(value) as unknown;
    return parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed as Record<string,unknown>:{};
  } catch {
    return {};
  }
}

export function fromRule(row:GateRuleRecord):RuleDraft|null {
  if(row.direction==='file')return null;
  return {
    id:row.id,
    version:row.updated_at,
    policyId:row.policy_id,
    policyName:row.policy_name,
    detectorId:row.detector_id,
    detectorKey:row.detector_key,
    detectorKind:row.detector_kind,
    direction:row.direction,
    action:row.action,
    severity:row.severity,
    config:parseConfig(row.config_json),
    enabled:row.enabled===1,
    priority:row.priority,
    scopeType:row.scope_type,
    scopeId:row.scope_id,
  };
}

export function policyRuleMutationBody(draft:RuleDraft) {
  return {
    policyId:draft.policyId,
    detectorId:draft.detectorId,
    scopeType:draft.scopeType,
    scopeId:draft.scopeId,
    direction:draft.direction,
    action:draft.action,
    severity:draft.severity,
    config:draft.config,
    enabled:draft.enabled,
    priority:draft.priority,
  };
}

export function enabledDetectors(items:readonly DetectorRecord[]):DetectorRecord[] {
  return items.filter(item=>item.enabled);
}

export function policyRuleDrawerTitle(draft:Pick<RuleDraft,'id'|'detectorKey'>,t:Translate):string {
  return draft.id?t('admin.policy.edit',{name:runtimeTranslation(t,'admin.enums',draft.detectorKey)}):t('admin.policy.addRule');
}

export function PolicyRuleRow({rule,prioritiesVary,t,onOpen}:{rule:GateRuleRecord;prioritiesVary:boolean;t:Translate;onOpen?:()=>void}) {
  return <tr tabIndex={0} onClick={onOpen} onKeyDown={event=>{if(onOpen&&(event.key==='Enter'||event.key===' ')){event.preventDefault();onOpen()}}}>
    <td>{runtimeTranslation(t,'admin.enums',rule.direction)}</td>
    <td><Status value={rule.action}/></td>
    <td><strong>{runtimeTranslation(t,'admin.enums',rule.detector_key)}</strong></td>
    {prioritiesVary&&<td className="ui-numeric">{rule.priority}</td>}
  </tr>;
}

export function PolicyEditor({permissions}:{permissions:readonly AdminPermission[]}) {
  const {locale,t}=useI18n();
  const [rules,setRules]=useState<GateRuleRecord[]>([]);
  const [detectors,setDetectors]=useState<DetectorRecord[]>([]);
  const [policies,setPolicies]=useState<PolicyRecord[]>([]);
  const [groups,setGroups]=useState<ScopeTarget[]>([]);
  const [users,setUsers]=useState<ScopeTarget[]>([]);
  const [models,setModels]=useState<ScopeTarget[]>([]);
  const [loading,setLoading]=useState(true);
  const [loaded,setLoaded]=useState(false);
  const [error,setError]=useState<Error|null>(null);
  const [draft,setDraft]=useState<RuleDraft|null>(null);
  const [dirty,setDirty]=useState(false);
  const [sample,setSample]=useState('');
  const [result,setResult]=useState<PolicyTestResult|null>(null);
  const [busy,setBusy]=useState(false);
  const [notice,setNotice]=useState('');
  const [adminWrite]=useState(createAdminWrite);
  const headingId=useId(),region=useRef<HTMLElement>(null);
  const write=permissions.includes('policy:write');
  const enumText=(value:string)=>runtimeTranslation(t,'admin.enums',value);

  const load=async()=>{
    setLoading(true);
    setError(null);
    try {
      const [rulePage,detectorPage,policyPage,groupPage,userPage,modelPage]=await Promise.all([
        adminGet<AdminPage<GateRuleRecord>>('/gate/rules'),
        adminGet<AdminPage<DetectorRecord>>('/admin/detectors'),
        adminGet<AdminPage<PolicyRecord>>('/gate/policies'),
        adminGet<AdminPage<ScopeTarget>>('/admin/groups'),
        adminGet<AdminPage<ScopeTarget>>('/admin/users'),
        adminGet<AdminPage<ScopeTarget>>('/admin/models'),
      ]);
      setRules(rulePage.items.filter(item=>item.direction!=='file'));
      setDetectors(enabledDetectors(detectorPage.items));
      setPolicies(policyPage.items.filter(item=>item.enabled===1));
      setGroups(groupPage.items);
      setUsers(userPage.items);
      setModels(modelPage.items);
      setLoaded(true);
    } catch (cause) {
      setError(cause instanceof Error?cause:new Error(t('admin.policy.loadError')));
    } finally {
      setLoading(false);
    }
  };

  useEffect(()=>void load(),[]);
  useEffect(()=>{
    if(!dirty)return;
    const warn=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue=''};
    addEventListener('beforeunload',warn);
    return()=>removeEventListener('beforeunload',warn);
  },[dirty]);

  const startNew=()=>{
    const policy=policies[0],detector=detectors[0];
    if(!policy||!detector)return;
    setDraft({
      id:null,
      version:null,
      policyId:policy.id,
      policyName:policy.name,
      detectorId:detector.id,
      detectorKey:detector.name,
      detectorKind:detector.detectorKind,
      direction:'outbound',
      action:'block',
      severity:'high',
      config:detector.config,
      enabled:true,
      priority:100,
      scopeType:'tenant',
      scopeId:null,
    });
    setSample('');
    setResult(null);
    setDirty(true);
  };

  const open=async(row:GateRuleRecord)=>{
    setBusy(true);
    setNotice('');
    try {
      const detail=await adminGet<GateRuleRecord>(`/gate/rules/${row.id}`);
      const next=fromRule(detail);
      if(!next){setNotice(t('admin.policy.openError'));return;}
      setDraft(next);
      setSample('');
      setResult(null);
      setDirty(false);
    } catch (cause) {
      setNotice(errorText(cause,t));
    } finally {
      setBusy(false);
    }
  };

  const save=async()=>{
    if(busy||!draft)return;
    setBusy(true);
    setNotice('');
    const body=policyRuleMutationBody(draft);
    try {
      const saved=draft.id
        ? await adminWrite<{item:{id:string;updated_at:number}}>(`/gate/rules/${draft.id}`,'PATCH',body,draft.version??undefined)
        : await adminWrite<{item:{id:string;updated_at:number}}>('/gate/rules','POST',body);
      setDraft(current=>current?{...current,id:saved.item.id,version:saved.item.updated_at}:current);
      setDirty(false);
      setNotice(t('admin.policy.draftSaved'));
      await load();
    } catch (cause) {
      setNotice(errorText(cause,t));
    } finally {
      setBusy(false);
    }
  };

  const test=async()=>{
    if(!draft||!sample.trim())return;
    setBusy(true);
    setNotice('');
    try {
      const response=await adminWrite<PolicyTestResult>('/gate/rules/test','POST',{
        rule:{
          detectorKind:draft.detectorKind,
          direction:draft.direction,
          action:draft.action,
          config:draft.config,
        },
        sampleText:sample,
      });
      setResult(response);
      setNotice(t('admin.policy.testComplete'));
    } catch (cause) {
      setNotice(errorText(cause,t));
    } finally {
      setBusy(false);
    }
  };

  const close=()=>{
    if(!dirty||confirm(t('admin.policy.discard')))setDraft(null);
  };

  const canCreate=write&&policies.length>0&&detectors.length>0;
  const canTest=Boolean(draft&&sample.trim()&&draft.detectorKind!=='semantic'&&draft.detectorKind!=='file');
  const prioritiesVary=new Set(rules.map(rule=>rule.priority)).size>1;
  const policyGroups=[...new Map(rules.map(rule=>[rule.policy_id,{name:rule.policy_name,rules:rules.filter(item=>item.policy_id===rule.policy_id)}])).values()];

  const content=<>
    {notice&&<p className="ui-notice" role="status">{notice}</p>}
    {rules.length===0
      ? <Empty action={canCreate?t('admin.policy.addRule'):undefined} onAction={startNew}>{t('admin.policy.empty')}</Empty>
      : <div className="ui-policy-groups">{policyGroups.map(group=><section key={group.name}><h2>{group.name}</h2><div className="ui-table-wrap"><table><thead><tr><th>{t('admin.policy.direction')}</th><th>{t('admin.fields.action')}</th><th>{t('admin.policy.detector')}</th>{prioritiesVary&&<th className="ui-numeric">{t('admin.policy.priority')}</th>}</tr></thead><tbody>{group.rules.map(rule=><PolicyRuleRow key={rule.id} rule={rule} prioritiesVary={prioritiesVary} t={t} onOpen={()=>void open(rule)}/>)}</tbody></table></div></section>)}</div>}
    {busy&&!draft&&<Loading/>}
    {draft&&<Drawer title={policyRuleDrawerTitle(draft,t)} busy={busy} onClose={close}>
      <form className="ui-editor" onSubmit={event=>{event.preventDefault();void save()}}>
        <div className="ui-rule-grid">
          <label>{t('admin.policy.name')}
            <select value={draft.policyId} disabled={Boolean(draft.id)||!write} onChange={event=>{
              const policy=policies.find(item=>item.id===event.target.value);if(!policy)return;
              setDraft({...draft,policyId:policy.id,policyName:policy.name});setDirty(true);
            }}>{policies.map(policy=><option key={policy.id} value={policy.id}>{policy.name}</option>)}</select>
          </label>
          <label>{t('admin.policy.detector')}
            <select value={draft.detectorId} disabled={Boolean(draft.id)||!write} onChange={event=>{
              const detector=detectors.find(item=>item.id===event.target.value);if(!detector)return;
              setDraft({...draft,detectorId:detector.id,detectorKey:detector.name,detectorKind:detector.detectorKind,config:detector.config});setDirty(true);
            }}>{detectors.map(detector=><option key={detector.id} value={detector.id}>{valueText(detector.name,'name',locale,t)}</option>)}</select>
          </label>
          <label>{t('admin.policy.inspect')}
            <select value={draft.direction} disabled={!write} onChange={event=>{setDraft({...draft,direction:event.target.value as PolicyDirection});setDirty(true)}}>
              {POLICY_DIRECTIONS.map(value=><option key={value} value={value}>{enumText(value)}</option>)}
            </select>
          </label>
          <label>{t('admin.fields.scopeType')}
            <select value={draft.scopeType} disabled={!write} onChange={event=>{
              const scopeType=event.target.value as GateRuleRecord['scope_type'];
              const targets=scopeType==='group'?groups:scopeType==='user'?users:scopeType==='model'?models:[];
              setDraft({...draft,scopeType,scopeId:scopeType==='tenant'?null:targets[0]?.id??null});setDirty(true);
            }}>
              <option value="tenant">{t('admin.compliance.organization')}</option>
              {POLICY_SCOPES.filter(value=>value!=='tenant').map(value=><option key={value} value={value}>{enumText(value)}</option>)}
            </select>
          </label>
          {draft.scopeType!=='tenant'&&<label>{t('admin.fields.scopeName')}
            <select value={draft.scopeId??''} disabled={!write} required onChange={event=>{setDraft({...draft,scopeId:event.target.value||null});setDirty(true)}}>
              {(draft.scopeType==='group'?groups:draft.scopeType==='user'?users:models).map(target=><option key={target.id} value={target.id}>{target.name??target.displayName??target.email??target.id}</option>)}
            </select>
          </label>}
          <label>{t('admin.policy.takeAction')}
            <select value={draft.action} disabled={!write} onChange={event=>{setDraft({...draft,action:event.target.value as GateAction});setDirty(true)}}>
              {POLICY_ACTIONS.map(value=><option key={value} value={value}>{enumText(value)}</option>)}
            </select>
          </label>
          <label>{t('admin.fields.severity')}
            <select value={draft.severity} disabled={!write} onChange={event=>{setDraft({...draft,severity:event.target.value as GateRuleRecord['severity']});setDirty(true)}}>
              {severities.map(value=><option key={value} value={value}>{enumText(value)}</option>)}
            </select>
          </label>
          {draft.action==='mask'&&<label>{t('admin.policy.maskReplacement')}
            <input type="text" maxLength={128} value={typeof draft.config.maskReplacement==='string'?draft.config.maskReplacement:''} disabled={!write} onChange={event=>{setDraft({...draft,config:{...draft.config,maskReplacement:event.target.value}});setDirty(true)}}/>
          </label>}
          <label>{t('admin.policy.priority')}
            <input type="number" min="0" max="1000000" value={draft.priority} disabled={!write} onChange={event=>{setDraft({...draft,priority:Number(event.target.value)});setDirty(true)}}/>
          </label>
        </div>
        <label className="ui-switch"><input type="checkbox" checked={draft.enabled} disabled={!write} onChange={event=>{setDraft({...draft,enabled:event.target.checked});setDirty(true)}}/> {t('admin.policy.enabled')}</label>
        <section className="ui-test">
          <h3>{t('admin.policy.testTitle')}</h3>
          <p>{t('admin.policy.testHelp')}</p>
          <label>{t('admin.policy.sample')}
            <textarea rows={6} value={sample} onChange={event=>setSample(event.target.value)} placeholder={t('admin.policy.samplePlaceholder')}/>
          </label>
          <button type="button" className="ui-button ui-secondary" disabled={!canTest} aria-disabled={busy?'true':undefined} onClick={()=>{if(!busy)void test()}}>{t('admin.policy.testDraft')}</button>
          {result&&<div className="ui-test-result" role="status">
            <strong>{t('admin.policy.result',{action:enumText(result.action)})}</strong>
            <span>{t('admin.policy.providerCalled',{elapsed:Math.round(result.timings.totalUs/1000),called:t(result.disposition==='allow_provider_call'?'admin.policy.would':'admin.policy.wouldNot')})}</span>
            <p>{t('admin.policy.matches',{count:result.matches.length})}</p>
            {result.matches.map((match,index)=><p className="ui-match" key={`${match.category}-${index}`}>{t('admin.policy.matched',{excerpt:match.safeExcerpt})}</p>)}
          </div>}
        </section>
        <footer className="ui-form-footer"><button type="button" className="ui-button ui-secondary" aria-disabled={busy?'true':undefined} onClick={()=>{if(!busy)close()}}>{t('common.cancel')}</button><button className="ui-button ui-primary" disabled={!write} aria-disabled={busy?'true':undefined}>{t('admin.policy.saveDraft')}</button></footer>
      </form>
    </Drawer>}
  </>;
  return <><PageHead headingId={headingId} title={t('admin.screens.policies')} description={t('admin.screen.policies.0')} actions={canCreate?<button className="ui-button ui-primary" onClick={startNew}>{t('admin.policy.newRule')}</button>:undefined}/><section ref={region} role="region" aria-labelledby={headingId} tabIndex={0} aria-busy={loading}>{error&&<ErrorPanel error={error} retry={()=>{region.current?.focus();void load()}}/>}{!loaded&&loading?<Loading/>:loaded?content:null}</section></>;
}
