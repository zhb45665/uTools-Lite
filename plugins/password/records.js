/* Shared credential schema. Older records remain ordinary accounts. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.Credentials = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const SCHEMA_VERSION = 2;
  const protocols = { ssh: "SSH", rdp: "远程桌面", other: "其他" };
  const environments = { "": "未指定", production: "生产", testing: "测试", development: "开发" };
  const text = value => String(value == null ? "" : value).trim();
  function normalize(raw) {
    const e = raw && typeof raw === "object" ? raw : {};
    return {
      id: text(e.id), type: e.type === "server" ? "server" : "account",
      title: text(e.title), username: text(e.username), password: String(e.password ?? ""),
      url: text(e.url), note: text(e.note), group: text(e.group),
      environment: Object.hasOwn(environments, e.environment) ? e.environment : "",
      protocol: Object.hasOwn(protocols, e.protocol) ? e.protocol : "ssh",
      host: text(e.host), port: text(e.port), auth: e.auth === "key" ? "key" : "password",
      keyPath: text(e.keyPath), favorite: e.favorite === true,
      createdAt: Number(e.createdAt) || 0, updatedAt: Number(e.updatedAt) || 0,
    };
  }
  function validate(e) {
    if (!e.title) throw new Error("请填写名称");
    if (e.type === "server") {
      if (!e.host) throw new Error("请填写主机 IP 或域名");
      if (/[\s/@\\?#]/.test(e.host) || e.host.startsWith("-") || e.host.includes("://"))
        throw new Error("主机只填写 IP 或域名，端口请单独填写");
      if (e.host.includes(":") && !/^[\[\]a-fA-F0-9:.%a-zA-Z_-]+$/.test(e.host))
        throw new Error("主机地址格式不正确");
      if (!/^\d+$/.test(e.port) || Number(e.port) < 1 || Number(e.port) > 65535)
        throw new Error("端口应为 1–65535 的整数");
      if (e.auth === "key" && (e.protocol !== "ssh" || !e.keyPath))
        throw new Error("SSH 密钥认证需要填写本机密钥文件路径");
    }
  }
  function decode(data) {
    if (!data || ![1, SCHEMA_VERSION].includes(data.version) || !Array.isArray(data.entries))
      throw new Error("密码本格式不受支持，请保留原文件");
    const ids = new Set();
    return data.entries.map(raw => {
      if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || !raw.id || ids.has(raw.id))
        throw new Error("密码本记录损坏或 ID 重复，请从备份恢复");
      ids.add(raw.id);
      return normalize(raw);
    });
  }
  function address(e) {
    if (e.type !== "server") return e.url || "未填写网址";
    const host = e.host.includes(":") && !e.host.startsWith("[") ? `[${e.host}]` : e.host;
    return `${e.username ? e.username + "@" : ""}${host}${e.port ? ":" + e.port : ""}`;
  }
  function matches(e, query) {
    const haystack = [e.title, e.username, e.url, e.host, e.port, e.group, environments[e.environment], protocols[e.protocol]].join(" ").toLowerCase();
    return text(query).toLowerCase().split(/\s+/).every(word => haystack.includes(word));
  }
  // PowerShell single-quoted arguments prevent command substitution and preserve spaces.
  function quote(value) { return "'" + String(value).replace(/'/g, "''") + "'"; }
  function sshCommand(e) {
    validate(e);
    if (e.type !== "server" || e.protocol !== "ssh") throw new Error("仅 SSH 记录支持复制连接命令");
    const args = ["ssh", "-p", String(Number(e.port))];
    if (e.auth === "key") args.push("-i", quote(e.keyPath));
    if (e.username) args.push("-l", quote(e.username));
    args.push(quote(e.host.replace(/^\[|\]$/g, "")));
    return args.join(" ");
  }
  return { SCHEMA_VERSION, protocols, environments, normalize, validate, decode, address, matches, sshCommand };
});
