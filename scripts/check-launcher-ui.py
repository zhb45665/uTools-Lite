"""Browser regression checks with a mock Electron bridge; no personal data is read.

Build the renderer, then run this file from the project root.
Requires Python Playwright and its Chromium browser. Screenshots go to dist/ui-check.
"""
from pathlib import Path
from functools import partial
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from threading import Thread
from playwright.sync_api import sync_playwright, expect

MOCK = r"""
(() => {
  const plugins = [['notes','随手笔记',['note','笔记']],['calc-paper','计算稿纸',['paper','计算']],['amount','金额大写',['金额','大写']],['password','密码本',['密码','密码本']]].map(([id,name,keywords]) => ({id,name,keywords,hasDetail:true,builtin:true,status:'idle'}));
  const events = {};
  window.testCalls = [];
  window.testEvents = events;
  window.resolveSearch = {};
  const subscribe = name => cb => { events[name] = cb; return () => { delete events[name]; }; };
  window.launcher = {
    appInfo: async () => ({everythingAvailable:false,fileIndex:{count:18240,complete:true,running:false,capped:false}}),
    listPlugins: async () => plugins,
    search: q => new Promise((resolve,reject) => { window.resolveSearch[q] = {resolve,reject}; }),
    hide: async () => { window.testCalls.push('hide'); },
    launch: async item => { window.testCalls.push(item); return {ok:true,copied:item.type === 'command' ? item.payload : undefined}; },
    selectPlugin: async item => { window.testCalls.push(item); return {openedDetail:{pluginId:item.pluginId,pluginName:item.title,detail:'detail.html'}}; },
    detailReady: async () => ({}), detailClose: async () => ({}),
    installPluginPick: async () => ({ok:false}),
    rescanPlugins: async () => plugins,
    permissionReply: async (id, granted) => { window.testCalls.push({permission:id,granted}); },
    onShow: subscribe('show'), onToast: subscribe('toast'), onDetailExit: subscribe('exit'),
    onPermissionRequest: subscribe('permission'), onFileIndexProgress: subscribe('index')
  };
})();
"""

def reply(page, q, label=None, count=1, kind='file'):
    page.evaluate("""({q,label,count,kind}) => resolveSearch[q].resolve({query:q,commands:kind==='command'?[{id:'calc',title:'2+2 = 4',type:'command',payload:'4'}]:[],plugins:[],apps:[],files:kind==='file'?Array.from({length:count},(_,i)=>({id:'file:'+i,title:label+' '+i,type:'file',payload:'C:/example/'+i,subtitle:'文档 / 项目资料'})):[]})""", dict(q=q,label=label or q,count=count,kind=kind))

def pending(page, q):
    page.wait_for_function('q => !!window.resolveSearch[q]', arg=q)

server = ThreadingHTTPServer(('127.0.0.1', 0), partial(SimpleHTTPRequestHandler, directory='dist/renderer'))
Thread(target=server.serve_forever, daemon=True).start()
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width':720,'height':460}, device_scale_factor=1)
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.add_init_script(MOCK)
    page.goto(f'http://127.0.0.1:{server.server_port}')
    page.wait_for_load_state('networkidle')
    expect(page.get_by_role('heading', name='随时唤起，即刻开始')).to_be_visible()
    out = Path('dist/ui-check')
    out.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(out/'home-light.png'))
    assert page.locator('.results').evaluate('(el) => el.scrollHeight <= el.clientHeight'), page.locator('.results').evaluate('(el) => ({height:el.clientHeight, content:el.scrollHeight, hint:el.querySelector(".hint").getBoundingClientRect().height})')
    page.emulate_media(color_scheme='dark')
    page.screenshot(path=str(out/'home-dark.png'))
    page.emulate_media(color_scheme='light')
    search = page.get_by_role('combobox')

    # A slow old response must not overwrite a newer result.
    search.fill('old'); pending(page,'old')
    search.fill('报告'); pending(page,'报告')
    reply(page,'报告',count=20)
    expect(page.get_by_role('option')).to_have_count(20)
    reply(page,'old')
    expect(page.get_by_role('option').first).to_contain_text('报告')
    page.screenshot(path=str(out/'search-light.png'))
    for _ in range(15): search.press('ArrowDown')
    expect(page.locator('#result-15')).to_have_attribute('aria-selected','true')
    assert page.locator('#result-15').evaluate('(el) => {const r=el.getBoundingClientRect(),p=el.closest(".results").getBoundingClientRect();return r.top>=p.top && r.bottom<=p.bottom;}')

    # Clearing input and reopening invalidate pending requests.
    search.fill('pending'); pending(page,'pending')
    search.fill(''); reply(page,'pending')
    expect(page.get_by_role('option')).to_have_count(0)

    # Starting Chinese IME composition also invalidates an earlier query.
    search.fill('before-ime'); pending(page,'before-ime')
    search.dispatch_event('compositionstart')
    reply(page,'before-ime')
    expect(page.get_by_role('option')).to_have_count(0)
    search.fill('中文')
    search.dispatch_event('compositionend')
    pending(page,'中文'); reply(page,'中文')
    expect(page.get_by_role('option').first).to_contain_text('中文')
    search.fill('reopen'); pending(page,'reopen')
    page.evaluate('testEvents.show()'); reply(page,'reopen')
    expect(search).to_have_value('')
    expect(page.get_by_role('option')).to_have_count(0)

    # Rejection recovers loading; the next query still works.
    search.fill('error'); pending(page,'error')
    page.evaluate("resolveSearch.error.reject(new Error('test failure'))")
    expect(page.locator('.toast')).to_contain_text('搜索失败')
    expect(page.locator('.spinner')).to_have_count(0)
    search.fill('2+2'); pending(page,'2+2'); reply(page,'2+2',kind='command')
    page.get_by_role('button',name='复制结果').click()
    expect(page.locator('.copied-toast')).to_contain_text('已复制：4')
    search.press('Escape')
    assert page.evaluate("testCalls.includes('hide')")

    page.evaluate('testEvents.show()')
    page.get_by_role('button',name='管理',exact=True).click()
    page.get_by_role('button',name='安装插件（文件夹 / zip）…').click()
    assert '安装完成' not in page.locator('body').inner_text()
    page.get_by_role('button',name='收起',exact=True).click()
    page.get_by_role('button',name='随手笔记 note 笔记').click()
    expect(page.get_by_title('随手笔记',exact=True)).to_be_visible()
    page.get_by_role('button',name='返回搜索 · Esc').click()
    expect(search).to_be_visible()

    # A normal Enter must not also grant a newly displayed permission.
    page.evaluate("testEvents.permission({requestId:7,pluginName:'随手笔记',target:'C:/Documents',purpose:'读取文件'})")
    search.press('Enter')
    assert not page.evaluate('testCalls.some(c => c.permission === 7)')
    page.get_by_role('button',name='拒绝 (Esc)').click()
    assert page.evaluate('testCalls.some(c => c.permission === 7 && c.granted === false)')
    assert not errors, errors
    browser.close()
    server.shutdown()
    server.server_close()
    print('PASS: light/dark rendering, stale search, clear/reopen, error recovery, scroll, copy, Esc, install cancellation, plugin entry, permission Enter isolation')
