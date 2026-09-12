/**
 * 密码本加密存储（只在插件沙箱里跑，页面不接触密钥与密文）
 *
 *  主密码 --scrypt--> 32 字节密钥 --AES-256-GCM--> 密文 + 认证标签
 *
 *  · 明文永不落盘，磁盘上只有 { kdf, iv, tag, data } 的密文包
 *  · GCM 认证标签同时保证机密性与完整性：主密码错 / 文件被改都会抛错
 *  · 主密码本身不保存、不传回页面之外的任何地方
 */
const crypto = require("node:crypto");

const VERSION = 1;
/** scrypt 参数：约 16MB 内存、~50-100ms，够挡住离线暴力破解 */
const KDF = { N: 16384, r: 8, p: 1, keylen: 32 };
const SALT_BYTES = 16;
const IV_BYTES = 12;

function deriveKey(master, salt, kdf) {
 const k = kdf || KDF;
 return crypto.scryptSync(String(master), salt, k.keylen || KDF.keylen, {
  N: k.N || KDF.N,
  r: k.r || KDF.r,
  p: k.p || KDF.p,
 });
}

/** obj -> 可安全落盘的密文包 */
function encryptVault(master, obj) {
 const salt = crypto.randomBytes(SALT_BYTES);
 const iv = crypto.randomBytes(IV_BYTES);
 const key = deriveKey(master, salt);
 const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
 const plaintext = Buffer.from(JSON.stringify(obj ?? {}), "utf8");
 const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
 const tag = cipher.getAuthTag();
 return {
  version: VERSION,
  kdf: { ...KDF, salt: salt.toString("base64") },
  iv: iv.toString("base64"),
  tag: tag.toString("base64"),
  data: data.toString("base64"),
 };
}

/**
 * 密文包 -> obj。主密码错误或数据被篡改都会抛错
 * （GCM 认证失败，绝不返回半截明文）。
 */
function decryptVault(master, blob) {
 if (!blob || typeof blob !== "object") throw new Error("保险库文件损坏");
 const salt = Buffer.from(String(blob.kdf && blob.kdf.salt), "base64");
 const iv = Buffer.from(String(blob.iv), "base64");
 const tag = Buffer.from(String(blob.tag), "base64");
 const data = Buffer.from(String(blob.data), "base64");
 if (!salt.length || !iv.length || !tag.length)
  throw new Error("保险库文件损坏");
 const key = deriveKey(master, salt, blob.kdf);
 const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
 decipher.setAuthTag(tag);
 const plain = Buffer.concat([decipher.update(data), decipher.final()]);
 let parsed;
 try {
  parsed = JSON.parse(plain.toString("utf8"));
 } catch {
  throw new Error("保险库内容已损坏（无法解析）");
 }
 if (!parsed || typeof parsed !== "object")
  throw new Error("保险库内容格式不对");
 return parsed;
}

module.exports = { VERSION, KDF, encryptVault, decryptVault, deriveKey };
