const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {writeAtomic}=require('../dist/main/plugins/atomic-file');
test('real atomic writes preserve existing file on exclusive collision and clean temporary files',async()=>{
  const root=path.resolve(__dirname,'../dist/atomic-file-check'); await fs.mkdir(root,{recursive:true});
  const dir=await fs.mkdtemp(path.join(root,'case-')), target=path.join(dir,'vault.json');
  try {
    await writeAtomic(target,'first',true);
    await assert.rejects(writeAtomic(target,'replacement',true),{code:'EEXIST'});
    assert.equal(await fs.readFile(target,'utf8'),'first');
    await writeAtomic(target,'second'); assert.equal(await fs.readFile(target,'utf8'),'second');
    assert.deepEqual(await fs.readdir(dir),['vault.json']);
    await fs.mkdir(path.join(dir,'directory'));
    await assert.rejects(writeAtomic(path.join(dir,'directory'),'must fail'));
    assert(!(await fs.readdir(dir)).some(f=>f.endsWith('.tmp')));
  } finally {
    // Only our freshly allocated directory inside the project can be removed.
    assert(path.resolve(dir).startsWith(root+path.sep));
    await fs.rm(dir,{recursive:true,force:true});
  }
});
