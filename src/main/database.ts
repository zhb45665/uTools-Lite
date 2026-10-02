import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import initSqlJs, { type Database } from "sql.js";

let db: Database | null = null;
let dbFile = "";
const norm = (v: string) => {
  const n = v.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!n || n.split("/").includes("..")) throw new Error("invalid plugin data path");
  return n;
};
function need(): Database { if (!db) throw new Error("database is not initialized"); return db; }
function run(sql: string, p: unknown[] = []) { need().run(sql, p as any[]); }
function rows<T>(sql: string, p: unknown[] = []): T[] {
  const s = need().prepare(sql), out: T[] = [];
  try { s.bind(p as any[]); while (s.step()) out.push(s.getAsObject() as T); } finally { s.free(); }
  return out;
}
function one<T>(sql: string, p: unknown[] = []): T | null { return rows<T>(sql, p)[0] ?? null; }
function save() {
  const tmp = `${dbFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, Buffer.from(need().export()), { mode: 0o600 });
  const previous = `${dbFile}.previous`;
  if (fs.existsSync(dbFile)) fs.copyFileSync(dbFile, previous);
  try { fs.renameSync(tmp, dbFile); } catch { fs.copyFileSync(tmp, dbFile); fs.unlinkSync(tmp); }
}
function tx(fn: () => void) {
  run("BEGIN");
  try { fn(); run("COMMIT"); save(); } catch (e) { try { run("ROLLBACK"); } catch {} throw e; }
}
function importLegacyFiles() {
  if (one("SELECT value FROM app_meta WHERE key=?", ["plugin_files_imported"])) return;
  const root = path.join(app.getPath("userData"), "plugin-data");
  tx(() => {
    if (fs.existsSync(root)) for (const plugin of fs.readdirSync(root, { withFileTypes: true })) {
      if (!plugin.isDirectory()) continue;
      const base = path.join(root, plugin.name);
      const walk = (dir: string) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full); else if (e.isFile()) run("INSERT OR IGNORE INTO plugin_files VALUES(?,?,?,?)", [plugin.name, norm(path.relative(base, full)), fs.readFileSync(full, "utf8"), fs.statSync(full).mtimeMs]);
      }};
      walk(base);
    }
    run("INSERT INTO app_meta VALUES(?,?)", ["plugin_files_imported", String(Date.now())]);
  });
}
export async function initDatabase() {
  if (db) return;
  const dir = path.join(app.getPath("userData"), "data"); fs.mkdirSync(dir, { recursive: true });
  dbFile = path.join(dir, "utools-lite.db");
  const SQL = await initSqlJs({ locateFile: () => require.resolve("sql.js/dist/sql-wasm.wasm") });
  db = fs.existsSync(dbFile) ? new SQL.Database(fs.readFileSync(dbFile)) : new SQL.Database();
  db.exec("PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS app_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS app_state(namespace TEXT NOT NULL,key TEXT NOT NULL,value_json TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(namespace,key)); CREATE TABLE IF NOT EXISTS plugin_files(plugin_id TEXT NOT NULL,path TEXT NOT NULL,content TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(plugin_id,path));");
  save(); importLegacyFiles();
}
export function readState<T>(ns: string, key: string): T | null { const r = one<{value_json:string}>("SELECT value_json FROM app_state WHERE namespace=? AND key=?", [ns,key]); return r ? JSON.parse(r.value_json) : null; }
export function writeState(ns: string, key: string, value: unknown) { tx(() => run("INSERT INTO app_state VALUES(?,?,?,?) ON CONFLICT(namespace,key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at", [ns,key,JSON.stringify(value),Date.now()])); }
export function readPluginFile(id: string, file: string): string { const r=one<{content:string}>("SELECT content FROM plugin_files WHERE plugin_id=? AND path=?",[id,norm(file)]); if(!r){const e=new Error(`ENOENT: ${file}`) as NodeJS.ErrnoException;e.code="ENOENT";throw e;}return r.content; }
export function writePluginFile(id:string,file:string,content:string,exclusive=false){const f=norm(file);tx(()=>run(exclusive?"INSERT INTO plugin_files VALUES(?,?,?,?)":"INSERT INTO plugin_files VALUES(?,?,?,?) ON CONFLICT(plugin_id,path) DO UPDATE SET content=excluded.content,updated_at=excluded.updated_at",[id,f,content,Date.now()]));}
export function deletePluginFile(id:string,file:string){const f=norm(file);if(!one("SELECT 1 FROM plugin_files WHERE plugin_id=? AND path=?",[id,f]))throw new Error(`ENOENT: ${file}`);tx(()=>run("DELETE FROM plugin_files WHERE plugin_id=? AND path=?",[id,f]));}
export function listPluginFiles(id:string,dir:string){const prefix=dir&&dir!=="."?norm(dir).replace(/\/$/,"")+"/":"";const map=new Map<string,{name:string;dir:boolean;size:number}>();for(const r of rows<{path:string;size:number}>("SELECT path,length(content) size FROM plugin_files WHERE plugin_id=? AND path LIKE ?",[id,`${prefix}%`])){const [name,...tail]=r.path.slice(prefix.length).split("/");if(name)map.set(name,{name,dir:!!tail.length,size:tail.length?0:Number(r.size)});}return [...map.values()].sort((a,b)=>a.dir===b.dir?a.name.localeCompare(b.name):a.dir?-1:1);}
export const pluginFileCount=()=>Number(one<{n:number}>("SELECT count(*) n FROM plugin_files")?.n??0);
export const databaseIntegrity=()=>String(one<{integrity_check:string}>("PRAGMA integrity_check")?.integrity_check??"unknown");
export function databasePath(){need();return dbFile;}
