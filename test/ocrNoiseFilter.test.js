import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dropLowConfidenceTolerant } from '../src/ocrNoiseFilter.js';

const tolerantWithConfidence = (confidence) => ({
  severity: 'tolerant', cls: 'name', line: 1,
  expected: 'ACME CORP', found: 'acme corp', reason: 'text',
  region: { x0: 0, y0: 0, x1: 10, y1: 10, confidence },
});

test('a tolerant finding below the threshold is removed', () => {
  const findings = [tolerantWithConfidence(0.1)];
  assert.deepEqual(dropLowConfidenceTolerant(findings, 0.4), []);
});

test('a tolerant finding at or above the threshold is kept, unchanged', () => {
  const f = tolerantWithConfidence(0.4);
  const result = dropLowConfidenceTolerant([f], 0.4);
  assert.deepEqual(result, [f]);
});

test('a material finding is kept regardless of confidence', () => {
  const f = {
    severity: 'material', cls: 'money', line: 2,
    expected: '₱50,000.00', found: '₱500,000.00', reason: 'digit-count',
    region: { x0: 0, y0: 0, x1: 10, y1: 10, confidence: 0.01 },
  };
  assert.deepEqual(dropLowConfidenceTolerant([f], 0.9), [f]);
});

test('a tolerant finding with no region is kept', () => {
  const f = {
    severity: 'tolerant', cls: 'name', line: 3,
    expected: 'ENVIRONMENTAL MANAGEMENT BUREAU', found: null, reason: 'text',
  };
  assert.deepEqual(dropLowConfidenceTolerant([f], 0.9), [f]);
});

test('an empty findings array returns empty', () => {
  assert.deepEqual(dropLowConfidenceTolerant([], 0.4), []);
});
