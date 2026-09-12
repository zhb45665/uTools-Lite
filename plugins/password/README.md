# 密码本：服务器与普通账号

从首页点击密码本，或搜索“密码 / 服务器”进入。新建记录默认采用服务器格式，普通网站账号可选择“普通账号”。

- 服务器可记录主机、端口、SSH / 远程桌面协议、认证方式、项目分组和环境。
- 主机栏只填写 IP 或域名；端口单独填写。SSH 默认 22，远程桌面默认 3389，支持自定义端口和 IPv6。
- SSH 密钥认证只保存本机密钥路径，不读取私钥文件。复制的连接命令适用于 Windows PowerShell，不含密码。
- 一条记录对应一组登录凭据，同一台服务器的不同账号可以“复制为新记录”。
- 支持收藏及类型、环境、分组筛选。搜索覆盖名称、地址、账号、端口、分组和环境，不搜索密码。
- 新建密码留空，按需生成。密码默认隐藏，复制密码后 30 秒清理剪贴板；如果剪贴板已被其他内容覆盖，则不清理。
- 闲置 5 分钟自动锁定，键盘输入和点击会更新活动时间。关闭面板后后台仍可保持解锁至超时。

## 旧数据和备份

旧记录始终按普通账号读取，不自动推断服务器地址。旧主密码仍可使用；新建密码本要求主密码至少 8 位。

记录继续保存于原来的 `plugin-data/password/vault.json`，内容采用 AES-256-GCM 加密。首次修改旧版记录时，会升级加密内容中的记录结构，并保留 `vault.legacy-v1.json`。每次保存前会保留上一版加密文件 `vault.previous.json`。

通过“加密备份”选择外部保存位置。备份中不包含明文凭据，恢复时需要备份对应的主密码。恢复会替换当前记录，恢复前文件另存为 `vault.before-restore-时间戳.json`。

如发生读取错误或文件损坏，程序不会将它当成首次使用并覆盖创建。请保留原文件，通过“恢复备份”选择可用的加密副本。自动副本仍在同一台机器上，不能替代外部备份。

## 回归检查

所有测试使用模拟凭据，不读取已安装程序的数据。在项目根目录运行：

```text
npm run build:node
node scripts/check-password.cjs
node scripts/check-atomic-file.cjs
python scripts/check-password-ui.py
npm run build:renderer
node_modules/.bin/electron.cmd scripts/check-password-electron.cjs
node_modules/.bin/electron.cmd scripts/check-plugins-isolated.cjs
```

页面检查需要 Python Playwright 和 Chromium。截图与隔离测试目录位于 `dist`；重新构建时会清理。暂未提供表格批量导入、私钥正文存储或自动登录。
