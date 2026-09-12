/* Test-only host: real credential service and encryption, in-memory files/clipboard. */
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createRequire } = require('node:module');
const servicePath = path.resolve(__dirname, '../plugins/password/service.js');
function harness(initial = {}) {
  const files = new Map(Object.entries(initial)), timers = new Map(), search = new Map();
  const waiters = new Map(), events = [];
  let receive, sequence = 0, timerSeq = 0, clipboard = '', exported = null;
  const state = { failWrite: null, failRead: null, beforeRead: null, beforeWrite: null, pick: null };
  const host = {
    async readFile(file) {
      if (state.beforeRead) await state.beforeRead(file);
      if (state.failRead === file) throw new Error('EACCES: simulated read failure');
      if (!files.has(file)) throw new Error('ENOENT: not found');
      return files.get(file);
    },
    async writeFileAtomic(file, content, exclusive) {
      if (state.beforeWrite) await state.beforeWrite(file);
      if (state.failWrite === file) throw new Error('EIO: simulated write failure');
      if (exclusive && files.has(file)) throw new Error('EEXIST');
      files.set(file, content);
    },
    async copyText(text) { clipboard = text; },
    async getClipboardText() { return clipboard; },
    async saveEncryptedBackup(text) { exported = text; return { saved: true }; },
    async pickEncryptedBackup() { return state.pick || { canceled: true }; },
    sendMainMessage(msg) {
      const copy = JSON.parse(JSON.stringify(msg)); events.push(copy);
      if (copy.type === 'res') { const resolve = waiters.get(copy.requestId); waiters.delete(copy.requestId); resolve?.(copy); }
    },
    onMainMessage(fn) { receive = fn; }, onInput() {},
    onInputSearch(kw, fn) { search.set(kw, fn); }, onExit() {}, log() {},
  };
  vm.runInNewContext(fs.readFileSync(servicePath, 'utf8'), {
    require: createRequire(servicePath), main: host,
    setTimeout(fn, ms) { const id = ++timerSeq; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
  }, { filename: servicePath });
  return {
    files, timers, events, state, host,
    get clipboard() { return clipboard; }, get exported() { return exported; },
    request(type, payload = {}) {
      const requestId = ++sequence;
      return new Promise(resolve => { waiters.set(requestId, resolve); receive({ ...payload, type, requestId }); });
    },
    async expire(ms) { for (const [id,t] of [...timers]) if (t.ms === ms) { timers.delete(id); t.fn(); } await new Promise(setImmediate); },
    search(query) { return new Promise(resolve => search.get('服务器')('服务器', query, resolve)); },
  };
}
module.exports = { harness };

// Local UI test server. Binds loopback on an ephemeral port; no personal data.
if (require.main === module) {
  const http = require('node:http');
  const vault = require('../plugins/password/vault.js');
  const mockEntries = [
    {id:'legacy', title:'旧版网站账号',username:'demo@example.com',password:'Demo-only-legacy',url:'https://example.com',note:'旧备注\n第二行'},
    {id:'server',type:'server',title:'商城生产主机',username:'deploy',password:'Demo-only-server',host:'192.0.2.10',port:'2222',protocol:'ssh',environment:'production',group:'商城项目',note:'通过跳板机连接\n部署目录 /srv/shop'},
  ];
  const encrypted = JSON.stringify(vault.encryptVault('Test-master-2026', {version:2,entries:mockEntries}));
  const h = harness({'vault.json': encrypted});
  h.state.pick = {encrypted,name:'test-backup.json'};
  const root = path.resolve(__dirname, '../plugins/password');
  const server = http.createServer(async (req,res) => {
    try {
      if (req.url === '/rpc' && req.method === 'POST') {
        let body=''; for await (const chunk of req) { body += chunk; if(body.length>12000000) throw Error('too large'); }
        const msg = JSON.parse(body), start = h.events.length;
        const result = await h.request(msg.type, msg);
        res.setHeader('Content-Type','application/json');
        res.end(JSON.stringify([...h.events.slice(start).filter(e=>e.type==='locked'), {...result,requestId:msg.requestId}])); return;
      }
      if (req.url === '/test-state') { res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({clipboard:h.clipboard,encrypted:h.exported})); return; }
      const name = req.url === '/' ? 'detail.html' : req.url.slice(1);
      if (!['detail.html','detail.css','detail.js','records.js','pwdgen.js'].includes(name)) { res.writeHead(404).end(); return; }
      res.setHeader('Content-Type', name.endsWith('.html')?'text/html; charset=utf-8':name.endsWith('.css')?'text/css':'text/javascript');
      res.end(fs.readFileSync(path.join(root,name)));
    } catch { res.writeHead(500).end('test server error'); }
  });
  server.listen(0,'127.0.0.1',()=>console.log(server.address().port));
}
