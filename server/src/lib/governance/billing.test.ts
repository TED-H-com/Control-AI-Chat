import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateUsageBilling } from './billing.js';

test('the provider cost is recorded as billed by the provider and the customer is never charged',()=>{
  const billing=calculateUsageBilling({providerCostMicrousd:1_000_000,credentialSource:'byok',baselineCostMicrousd:1_500_000});
  assert.equal(billing.providerCostMicrousd,1_000_000);
  assert.equal(billing.customerChargeMicrousd,0);
  assert.equal(billing.usageMarkupBasisPoints,null);
  assert.equal(billing.savingsMicrousd,500_000);
});

test('no credential source attracts a markup',()=>{
  for(const credentialSource of ['byok','platform'] as const)
    assert.equal(calculateUsageBilling({providerCostMicrousd:7_777,credentialSource}).customerChargeMicrousd,0);
});
