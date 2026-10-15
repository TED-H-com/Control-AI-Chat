import test from 'node:test';
import assert from 'node:assert/strict';
import { isBlockedIp,pinnedLookup, SafeFetchError, safeFetchText, stripHtml,validateProviderBaseUrl } from './safe-fetch.js';

test('pinned lookup supports single and all-result IPv4 and IPv6 calls',async()=>{
 for(const address of ['93.184.216.34','2606:2800:220:1:248:1893:25c8:1946']){
  const lookup=pinnedLookup(address);
  await new Promise<void>((resolve,reject)=>lookup('ignored',{all:true},(error,result)=>{try{assert.ifError(error);assert.deepEqual(result,[{address,family:address.includes(':')?6:4}]);resolve();}catch(cause){reject(cause);}}));
  await new Promise<void>((resolve,reject)=>lookup('ignored',{},(error,result,family)=>{try{assert.ifError(error);assert.equal(result,address);assert.equal(family,address.includes(':')?6:4);resolve();}catch(cause){reject(cause);}}));
 }
});

test('SSRF address classifier rejects private, metadata, mapped, CGNAT, unspecified, and multicast space',()=>{
  for(const address of ['127.0.0.1','::1','10.1.2.3','172.16.0.1','192.168.1.1','169.254.169.254','::ffff:169.254.169.254','0:0:0:0:0:ffff:169.254.169.254','::ffff:a9fe:a9fe','0:0:0:0:0:ffff:a9fe:a9fe','100.64.0.1','0.0.0.0','224.0.0.1'])assert.equal(isBlockedIp(address),true,address);
  assert.equal(isBlockedIp('93.184.216.34'),false);
});

test('SSRF address classifier rejects IPv6 transition and deprecated local ranges',()=>{
 for(const address of ['2002:7f00:1::','fec0::1','64:ff9b:1::1'])assert.equal(isBlockedIp(address),true,address);
 assert.equal(isBlockedIp('2002:5db8:d822::'),false);
});

test('URL validation rejects forbidden schemes, credentials, ports, and local names',async()=>{
  const cases:[string,string][]=[['file:///etc/passwd','scheme_forbidden'],['ftp://example.com','scheme_forbidden'],['gopher://example.com','scheme_forbidden'],['http://user:pass@example.com','credentials_forbidden'],['http://example.com:22','port_forbidden'],['http://printer.local','host_forbidden']];
  for(const [url,code] of cases)await assert.rejects(safeFetchText(url),error=>error instanceof SafeFetchError&&error.code===code,url);
});

test('IPv6 loopback literals are rejected as private addresses',async()=>{
  await assert.rejects(safeFetchText('http://[::1]/'),error=>error instanceof SafeFetchError&&error.code==='private_address');
});

test('provider base URLs reject loopback, metadata, and mapped metadata addresses',()=>{
  for(const url of ['https://127.0.0.1/v1','https://169.254.169.254/latest','https://[::ffff:169.254.169.254]/v1'])
    assert.throws(()=>validateProviderBaseUrl(url),error=>error instanceof SafeFetchError&&error.code==='private_address',url);
  assert.throws(()=>validateProviderBaseUrl('http://api.example.com/v1'),error=>error instanceof SafeFetchError&&error.code==='scheme_forbidden');
});

test('HTML stripping removes active and graphic blocks, tags, and decodes entities',()=>{
  assert.equal(stripHtml('<h1>A &amp; B</h1><!-- x --><script>steal()</script><style>x{}</style><svg><text>hidden</text></svg><p>&lt;ok&gt; &#39;x&#39; &#65;&nbsp;</p>'),"A & B <ok> 'x' A");
});

test('stripped generation input is normalized and capped',()=>{
  const result=stripHtml(`<p>${'x '.repeat(10_000)}</p>`);
  assert.equal(result.length,12_000);assert.doesNotMatch(result,/\s{2,}/u);
});
