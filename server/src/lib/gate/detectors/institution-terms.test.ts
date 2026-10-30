import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EDUCATIONAL_INSTITUTION_TERMS, MEDICAL_FACILITY_TERMS } from './institution-terms.js';

test('institution terms are exported', () => {
    assert.ok(Array.isArray(EDUCATIONAL_INSTITUTION_TERMS));
    assert.ok(Array.isArray(MEDICAL_FACILITY_TERMS));
});
