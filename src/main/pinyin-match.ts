import { pinyin } from "pinyin-pro";

/**
 * Pinyin matching for Chinese names (apps + files).
 *
 * For every item we build one searchable haystack that combines the original
 * text with its full pinyin ("微信" -> "微信weixin"), so `fuzzaldrin-plus`
 * matches both the characters and the pinyin. `toPinyinInitials` produces
 * the first-letter abbreviation ("微信" -> "wx") as a second key.
 *
 * The character table is built once from pinyin-pro's built-in dictionary
 * (multi-tongue, tone-less, most common reading). Per-character lookup —
 * no word segmentation — because pinyin-pro's segmenter does not know
 * proper names / place names and would silently merge or break them.
 * Non-Chinese input is left untouched, so English names match exactly
 * as before.
 */

let charDict: Map<string, string> | null = null;

/** All CJK Unified Ideographs (basic block, covers ~99% of names). */
const cjkRange: string[] = (() => {
 const out: string[] = [];
 for (let i = 0x4e00; i <= 0x9fff; i++) out.push(String.fromCharCode(i));
 return out;
})();

function getDict(): Map<string, string> {
 if (!charDict) {
  const m = new Map<string, string>();
  for (const ch of cjkRange) {
   const r = pinyin(ch, {
    type: "array",
    segmentit: 1,
    toneType: "none",
   });
   // pinyin-pro echoes unknown chars back as-is.
   if (r.length === 1 && r[0] !== ch) m.set(ch, r[0]);
  }
  charDict = m;
 }
 return charDict;
}

function hasCjk(text: string): boolean {
 for (const ch of text) {
  if (ch >= "\u4e00" && ch <= "\u9fff") return true;
 }
 return false;
}

/**
 * Full-pinyin form of a string: every CJK char replaced by its most common
 * tone-less pinyin, concatenated without separators.
 * "微信" -> "weixin", "QQ音乐" -> "QQyinyue".
 */
export function toPinyin(text: string): string {
 const dict = getDict();
 let out = "";
 for (const ch of text) {
  out += dict.get(ch) ?? ch;
 }
 return out;
}

/**
 * First-letter abbreviation: each CJK char contributes its initial, each
 * ASCII/digit run contributes its first letter.
 * "微信" -> "wx", "QQ音乐" -> "qyl", "记事本" -> "jsb".
 */
export function toPinyinInitials(text: string): string {
 const dict = getDict();
 let out = "";
 let prevAscii = false;
 for (const ch of text) {
  const ascii =
   (ch >= "a" && ch <= "z") ||
   (ch >= "A" && ch <= "Z") ||
   (ch >= "0" && ch <= "9");
  if (ascii) {
   if (!prevAscii) out += ch.toLowerCase();
   prevAscii = true;
   continue;
  }
  prevAscii = false;
  const r = dict.get(ch);
  if (r) out += r.charAt(0);
 }
 return out;
}

/**
 * Searchable haystack for `fuzzaldrin-plus`: original text + full pinyin
 * ("微信" -> "微信weixin"). Non-Chinese input is returned unchanged.
 */
export function pinyinHaystack(name: string): string {
 if (!hasCjk(name)) return name;
 return name + toPinyin(name);
}
