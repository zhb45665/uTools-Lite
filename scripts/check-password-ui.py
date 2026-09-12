"""Exercise the real password page + real service against memory-only test records.
Run from repository root: python scripts/check-password-ui.py
Screenshots: dist/password-check. Never reads installed credentials.
"""
import subprocess
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

BRIDGE = r"""(() => {
  const listeners = [];
  window.uTools = {
    getDetailContext: async () => ({item:{data:{action:'vault',entryId:'server'}}}),
    onMainMessage: cb => { listeners.push(cb); return () => {}; },
    sendMainMessage: async msg => {
      const response = await fetch('/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(msg)});
      if(!response.ok) throw new Error('Test host error');
      const messages = await response.json();
      for(const message of messages) for(const cb of listeners) cb(message);
    }
  };
})();"""

proc = subprocess.Popen(['node','scripts/password-harness.cjs'], stdout=subprocess.PIPE,
                        text=True, encoding='utf-8', creationflags=subprocess.CREATE_NO_WINDOW)
try:
    port = int(proc.stdout.readline().strip())
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width':1000,'height':650})
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.add_init_script(BRIDGE)
        page.goto(f'http://127.0.0.1:{port}')
        page.wait_for_load_state('networkidle')
        expect(page.locator('#unlockbtn')).to_be_enabled()
        page.locator('#master').fill('Test-master-2026')
        page.locator('#unlockbtn').click()
        expect(page.locator('#workspace')).to_be_visible()
        expect(page.locator('#detail h2')).to_have_text('商城生产主机')
        expect(page.locator('#detail .secret')).to_have_attribute('type','password')
        assert 'Demo-only-server' not in page.locator('body').inner_text()
        assert page.locator('body').evaluate('(e)=>e.scrollWidth<=innerWidth')
        out = Path('dist/password-check'); out.mkdir(parents=True,exist_ok=True)
        page.screenshot(path=str(out/'server-light.png'))
        page.emulate_media(color_scheme='dark')
        page.screenshot(path=str(out/'server-dark.png'))
        page.emulate_media(color_scheme='light')

        page.get_by_role('button',name='复制地址',exact=True).click()
        expect(page.locator('#status')).to_have_text('已复制')
        assert page.evaluate("fetch('/test-state').then(r=>r.json()).then(s=>s.clipboard)") == '192.0.2.10'
        page.get_by_role('button',name='复制 SSH 命令',exact=True).click()
        expect(page.locator('#status')).to_contain_text('PowerShell SSH 命令')
        command = page.evaluate("fetch('/test-state').then(r=>r.json()).then(s=>s.clipboard)")
        assert '2222' in command and 'deploy' in command and 'Demo-only' not in command
        page.get_by_role('button',name='复制密码',exact=True).click()
        expect(page.locator('#status')).to_contain_text('密码已复制')
        page.get_by_role('button',name='☆ 收藏',exact=True).click()
        expect(page.get_by_role('button',name='★ 已收藏',exact=True)).to_be_visible()
        page.locator('#favorites').check()
        expect(page.locator('.entry')).to_have_count(1)
        page.locator('#favorites').uncheck()
        page.locator('#env-filter').select_option('production')
        expect(page.locator('.entry')).to_have_count(1)
        page.locator('#env-filter').select_option('')
        page.locator('#filter').fill('192.0.2.10 生产')
        expect(page.locator('.entry')).to_have_count(1)
        page.locator('#filter').fill('')

        # A duplicated credential is not written until explicit save.
        page.get_by_role('button',name='复制为新记录',exact=True).click()
        expect(page.locator('#f-title')).to_have_value('商城生产主机（副本）')
        expect(page.locator('#f-pass')).to_have_attribute('type','password')
        page.locator('#f-title').fill('商城部署账号')
        page.locator('#f-user').fill('release')
        page.locator('#f-auth').select_option('key')
        page.locator('#f-key').fill(r'C:\Users\demo\.ssh\id_ed25519')
        page.screenshot(path=str(out/'editor.png'))
        page.locator('#f-save').click()
        expect(page.locator('#editor')).to_be_hidden()
        expect(page.locator('#detail h2')).to_have_text('商城部署账号')
        expect(page.locator('.entry')).to_have_count(3)
        page.get_by_role('button',name='删除',exact=True).click()
        expect(page.locator('#confirm-dialog')).to_be_visible()
        page.locator('#confirm-yes').click()
        expect(page.locator('#status')).to_contain_text('已删除凭据')
        expect(page.locator('.entry')).to_have_count(2)

        # Old accounts preserve fields; switching to server never guesses the address.
        page.locator('.entry[data-id="legacy"]').click()
        page.get_by_role('button',name='编辑',exact=True).click()
        expect(page.locator('#f-type')).to_have_value('account')
        expect(page.locator('#f-url')).to_have_value('https://example.com')
        expect(page.locator('#f-note')).to_have_value('旧备注\n第二行')
        page.locator('#f-type').select_option('server')
        expect(page.locator('#f-host')).to_have_value('')
        page.locator('#f-cancel').click()
        page.locator('#confirm-yes').click()
        expect(page.locator('#editor')).to_be_hidden()
        page.locator('#newbtn').click()
        expect(page.locator('#f-pass')).to_have_value('')
        expect(page.locator('#f-port')).to_have_value('22')
        page.locator('#f-protocol').select_option('rdp')
        expect(page.locator('#f-port')).to_have_value('3389')
        page.locator('#f-title').fill('测试 Windows 主机')
        page.locator('#f-host').fill('name:2222')
        page.locator('#f-save').click()
        expect(page.locator('#f-err')).to_contain_text('端口请单独填写')
        page.locator('#f-host').fill('192.0.2.20')
        page.locator('#f-note').fill('first line\nsecond line')
        page.locator('#f-save').click()
        expect(page.locator('#detail h2')).to_have_text('测试 Windows 主机')

        # Export encrypted data; bad restore credentials do not replace the vault.
        page.locator('#backup').click()
        expect(page.locator('#status')).to_contain_text('加密备份已保存')
        exported = page.evaluate("fetch('/test-state').then(r=>r.json()).then(s=>s.encrypted)")
        assert 'Demo-only' not in exported and '商城' not in exported
        assert json.loads(exported)['version'] == 1
        page.locator('#restore-open').click()
        page.locator('#restore-file').click()
        expect(page.locator('#restore-name')).to_have_text('test-backup.json')
        page.locator('#restore-master').fill('wrong-master')
        page.locator('#restore-confirm').check()
        page.locator('#restore-submit').click()
        expect(page.locator('#restore-error')).to_contain_text('主密码错误')
        page.locator('#restore-master').fill('Test-master-2026')
        page.locator('#restore-submit').click()
        expect(page.locator('#restore-dialog')).to_be_hidden()
        expect(page.locator('.entry')).to_have_count(2)

        # Lock from an open editor clears DOM values and doesn't break the next unlock.
        page.locator('.entry[data-id="server"]').click()
        page.get_by_role('button',name='编辑',exact=True).click()
        expect(page.locator('#f-pass')).to_have_value('Demo-only-server')
        page.locator('#lockbtn').click()
        expect(page.locator('#lockbox')).to_be_visible()
        expect(page.locator('#f-pass')).to_have_value('')
        expect(page.locator('#detail')).to_be_empty()
        expect(page.locator('#list')).to_be_empty()
        page.locator('#master').fill('Test-master-2026')
        page.locator('#unlockbtn').click()
        expect(page.locator('#workspace')).to_be_visible()
        page.locator('.entry[data-id="server"]').click()
        expect(page.locator('#detail')).to_be_visible()
        expect(page.locator('#detail .secret')).to_have_attribute('type','password')
        page.set_viewport_size({'width':720,'height':410})
        assert page.locator('body').evaluate('(e)=>e.scrollWidth<=innerWidth')
        page.screenshot(path=str(out/'compact.png'))
        assert not errors, errors
        browser.close()
        print('PASS: real service/page CRUD, legacy migration, masks, filters, clipboard, key/RDP fields, backup/restore, lock cleanup, responsive layout')
finally:
    proc.terminate()
    proc.wait(timeout=10)
