const { test } = require('node:test');
const assert = require('node:assert/strict');
const { harness } = require('./password-harness.cjs');
const vault = require('../plugins/password/vault.js');
const records = require('../plugins/password/records.js');
const key = 'Test-master-2026';
const legacy = { id:'legacy',title:'Original account',username:'demo',password:'  original secret  ',url:'ssh://legacy.example:2222',note:'Line 1\nLine 2' };
const encrypt = (entries, version=2) => JSON.stringify(vault.encryptVault(key,{version,entries}));
const server = {type:'server',title:'Production',username:'deploy',password:'Server-test-only',host:'192.0.2.10',port:'2222',protocol:'ssh',environment:'production',group:'Shop'};
async function ok(h,type,payload) { const r=await h.request(type,payload); assert.equal(r.error,undefined); return r; }

test('legacy records remain accounts; first save preserves encrypted legacy snapshot',async()=>{
  const original=encrypt([legacy],1), h=harness({'vault.json':original});
  const r=await ok(h,'unlock',{master:key});
  assert.equal(r.entries[0].type,'account'); assert.equal(r.entries[0].host,'');
  for(const field of ['username','password','url','note']) assert.equal(r.entries[0][field],legacy[field]);
  assert.equal(h.files.get('vault.json'),original);
  await ok(h,'save',{entry:server});
  assert.equal(h.files.get('vault.legacy-v1.json'),original);
  assert.equal(h.files.get('vault.previous.json'),original);
  const stored=vault.decryptVault(key,JSON.parse(h.files.get('vault.json')));
  assert.equal(stored.version,2); assert.equal(stored.entries.length,2);
  assert(!h.files.get('vault.json').includes(server.password));
});
test('failed writes leave committed memory and file unchanged; retry succeeds',async()=>{
  const original=encrypt([legacy]),h=harness({'vault.json':original}); await ok(h,'unlock',{master:key});
  h.state.failWrite='vault.json'; assert((await h.request('save',{entry:server})).error);
  assert.equal((await ok(h,'status')).entries.length,1); assert.equal(h.files.get('vault.json'),original);
  h.state.failWrite=null; assert.equal((await ok(h,'save',{entry:server})).entries.length,2);
});
test('read errors and corrupt data cannot be mistaken for an empty new vault',async()=>{
  for(const corrupted of ['{broken', '{}', '']) {
    const h=harness({'vault.json':corrupted}); assert.equal((await ok(h,'status')).hasVault,true);
    assert((await h.request('create',{master:key})).error); assert.equal(h.files.get('vault.json'),corrupted);
  }
  const h=harness(); h.state.failRead='vault.json';
  assert((await h.request('status')).error); assert((await h.request('create',{master:key})).error); assert.equal(h.files.size,0);
});
test('creation failure never leaves an unlocked vault and existing six-character masters still work',async()=>{
  const h=harness(); h.state.failWrite='vault.json'; assert((await h.request('create',{master:key})).error);
  assert.equal((await ok(h,'status')).unlocked,false);
  const old=harness({'vault.json':JSON.stringify(vault.encryptVault('123456',{version:1,entries:[legacy]}))});
  assert.equal((await ok(old,'unlock',{master:'123456'})).entries.length,1);
});
test('delete uses entryId independently of the RPC requestId; concurrent saves serialize',async()=>{
  const h=harness(); await ok(h,'create',{master:key});
  const results=await Promise.all([ok(h,'save',{entry:server}),ok(h,'save',{entry:{...server,title:'Second'}})]);
  const r=await ok(h,'delete',{entryId:results[0].entryId});
  assert.equal(r.entries.length,1); assert.equal(r.entries[0].title,'Second'); assert.equal(typeof r.requestId,'number');
});
test('external file changes block saves; lock during delayed writes does not repopulate memory',async()=>{
  const h=harness({'vault.json':encrypt([legacy])}); await ok(h,'unlock',{master:key});
  h.files.set('vault.json','external change'); assert((await h.request('save',{entry:server})).error); assert.equal(h.files.get('vault.json'),'external change');
  const h2=harness({'vault.json':encrypt([legacy])}); await ok(h2,'unlock',{master:key});
  let release,started; const reached=new Promise(r=>started=r);
  h2.state.beforeWrite=async file=>{if(file==='vault.json'){started();await new Promise(r=>release=r);}};
  const saving=h2.request('save',{entry:server}); await reached; await ok(h2,'lock'); release();
  assert((await saving).error); const status=await ok(h2,'status'); assert.equal(status.unlocked,false); assert.equal(status.entries.length,0);
});
test('backup export is encrypted; wrong restore leaves current file intact; restore keeps previous file',async()=>{
  const current=encrypt([legacy]),h=harness({'vault.json':current}); await ok(h,'unlock',{master:key});
  await ok(h,'backup'); assert.equal(h.exported,current);
  const backup=encrypt([{...server,id:'s'}]);
  assert((await h.request('restore',{encrypted:backup,master:'wrong',confirm:true})).error); assert.equal(h.files.get('vault.json'),current);
  assert((await h.request('restore',{encrypted:backup,master:key,confirm:false})).error);
  await ok(h,'restore',{encrypted:backup,master:key,confirm:true});
  assert([...h.files].some(([name,value])=>name.startsWith('vault.before-restore-')&&value===current));
  assert.equal((await ok(h,'status')).entries[0].type,'server');
});
test('copies use stored IDs; SSH commands contain no password; clipboard clear respects replacement',async()=>{
  const h=harness(); await ok(h,'create',{master:key}); const {entryId}=await ok(h,'save',{entry:server});
  await ok(h,'copy',{entryId,field:'ssh'}); assert(h.clipboard.includes('2222')); assert(!h.clipboard.includes(server.password));
  await ok(h,'copy',{entryId,field:'password'}); assert.equal(h.clipboard,server.password); await h.expire(30000); assert.equal(h.clipboard,'');
  await ok(h,'copy',{entryId,field:'password'}); await h.host.copyText('unrelated'); await h.expire(30000); assert.equal(h.clipboard,'unrelated');
  const hits=await h.search('192.0.2.10 生产'); assert.equal(hits.length,1); assert(!JSON.stringify(hits).includes(server.password));
  await h.expire(300000); assert.equal((await ok(h,'status')).unlocked,false); assert((await h.request('copy',{entryId,field:'password'})).error);
});
test('schema, port, host and crypto parameter validation',()=>{
  for(const port of ['0','65536','2.2','abc']) assert.throws(()=>records.validate(records.normalize({...server,port})));
  for(const host of ['https://example.com','name:2222','bad host','-oProxyCommand=bad']) assert.throws(()=>records.validate(records.normalize({...server,host})));
  assert.throws(()=>records.decode({version:999,entries:[]}));
  const blob=vault.encryptVault(key,{version:2,entries:[]}); blob.kdf.N=1073741824; assert.throws(()=>vault.decryptVault(key,blob));
});
