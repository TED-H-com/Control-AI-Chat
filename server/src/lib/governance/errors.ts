export type GovernanceErrorCode = 'unauthorized'|'forbidden'|'resource_not_found'|'tenant_inactive'|'account_inactive'|'model_not_allowed'|'provider_not_allowed'|'no_models_available'|'budget_hard_cap_exceeded'|'budget_output_too_small'|'request_rate_limited'|'concurrent_stream_limit'|'idempotency_conflict'|'ledger_invariant_violation'|'pricing_overflow'|'reconciliation_required';

export class GovernanceError extends Error {
  constructor(readonly code:GovernanceErrorCode, message:string, readonly details:Readonly<Record<string,string|number|boolean|null>> = {}) { super(message); this.name = 'GovernanceError'; }
}
