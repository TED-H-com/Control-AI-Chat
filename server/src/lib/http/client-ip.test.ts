import assert from 'node:assert/strict';
import test from 'node:test';
import { verifiedClientAddress } from './client-ip.js';

const secret='a'.repeat(64);

test('verified client address accepts only a valid assertion authenticated by the proxy',()=>{
  assert.equal(verifiedClientAddress({peer:'172.20.0.3',forwarded:'203.0.113.8',suppliedSecret:secret,trustedProxySecret:secret}),'203.0.113.8');
  assert.equal(verifiedClientAddress({peer:'172.20.0.3',forwarded:'203.0.113.8',suppliedSecret:'wrong',trustedProxySecret:secret}),'172.20.0.3');
  assert.equal(verifiedClientAddress({peer:'172.20.0.3',forwarded:'203.0.113.8'}),'172.20.0.3');
});

test('verified client address rejects malformed forwarded values and normalizes mapped peers',()=>{
  assert.equal(verifiedClientAddress({peer:'::ffff:127.0.0.1',forwarded:'203.0.113.8, 198.51.100.2',suppliedSecret:secret,trustedProxySecret:secret}),'127.0.0.1');
  assert.equal(verifiedClientAddress({peer:'not-an-address',forwarded:'2001:db8::7',suppliedSecret:secret,trustedProxySecret:secret}),'2001:db8::7');
  assert.equal(verifiedClientAddress({peer:'not-an-address'}),'unknown');
});
