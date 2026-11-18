import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Include the fiscal view in the existing authenticated admin application.
// Register the view before the shell starts its asynchronous session check.
export async function onPostBuild({ constants }) {
  const page = join(constants.PUBLISH_DIR, "admin/index.html");
  const script = '<script src="/admin/fiscal.js"></script>';
  const source = await readFile(page, "utf8");
  if (source.includes(script)) return;
  const start = "// ===== Начало =====";
  if (!source.includes(start)) throw new Error("Admin entry point missing");
  await writeFile(
    page,
    source.replace(start, "</script>\n" + script + "\n<script>\n" + start),
  );
}
