import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deploymentBrand,deploymentSupport,type DeploymentSettingsRow } from './branding.js';

const row:DeploymentSettingsRow={brand_name:'Acme Manufacturing',brand_icon_file_id:'file-1',support_vendor_name:'Northwind IT',
  support_contact_email:'help@northwind.test',support_contact_phone:'+886 2 1234 5678',support_contact_url:'https://northwind.test/support',
  support_notes:'After hours, call Chen on extension 402.'};

test('the public brand payload carries nothing about who maintains the installation',()=>{
  const brand=deploymentBrand(row);
  assert.deepEqual(brand,{brandName:'Acme Manufacturing',brandIconUrl:'/api/v1/deployment/icon'});
  assert.doesNotMatch(JSON.stringify(brand),/northwind|402|1234/iu);
});

test('a signed-in employee is told who to call',()=>{
  assert.deepEqual(deploymentSupport(row),{vendorName:'Northwind IT',email:'help@northwind.test',phone:'+886 2 1234 5678',
    url:'https://northwind.test/support',notes:'After hours, call Chen on extension 402.'});
});

test('an unbranded deployment reports nothing rather than an empty card',()=>{
  assert.deepEqual(deploymentBrand(undefined),{brandName:null,brandIconUrl:null});
  assert.equal(deploymentBrand({...row,brand_icon_file_id:null}).brandIconUrl,null);
  assert.equal(deploymentSupport(undefined),null);
  assert.equal(deploymentSupport({...row,support_vendor_name:null,support_contact_email:null,support_contact_phone:null,
    support_contact_url:null,support_notes:null}),null);
});
