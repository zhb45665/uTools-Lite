import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** Write and flush a sibling temporary file before replacing the target.
 * Exclusive creation never replaces an existing vault, even if another writer won.
 */
export async function writeAtomic(target: string, content: string, exclusive = false): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = path.join(path.dirname(target), `.utools-${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temp, "wx", 0o600);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (exclusive) await fs.link(temp, target);
    else await fs.rename(temp, target);
  } finally {
    await fs.unlink(temp).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== "ENOENT") console.error("[atomic-file] temporary file cleanup failed", e.code);
    });
  }
}
