import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Register the additional admin views before the shell checks the session.
export async function onPostBuild({ constants }) {
  const page = join(constants.PUBLISH_DIR, "admin/index.html");
  const source = await readFile(page, "utf8");
  const scripts = ["fiscal", "manual-contracts"]
    .map(name => '<script src="/admin/' + name + '.js"></script>')
    .filter(script => !source.includes(script));
  if (!scripts.length) return;
  const start = "// ===== Начало =====";
  if (!source.includes(start)) throw new Error("Admin entry point missing");
  await writeFile(
    page,
    source.replace(start, "</script>\n" + scripts.join("\n") + "\n<script>\n" + start),
  );
}
