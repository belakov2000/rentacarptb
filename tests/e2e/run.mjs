// Браузърна проверка на целия път с истинската сървърна логика, на настолен компютър и на телефон:
//   npm install --no-save embedded-postgres@17.5.0-beta.15 playwright-core@1 && npx playwright-core install chromium
//   node tests/e2e/run.mjs                      – целият път (tests/e2e/flow.mjs)
//   node tests/e2e/run.mjs tests/browser/x.mjs  – друг браузърен тест срещу същия локален сървър
// Стартира временен PostgreSQL и локален сървър (tests/e2e/server.ts), после tests/e2e/flow.mjs. Не се свързва с Netlify,
// Brevo, Meta или реални данни – външните заявки от сървъра са спрени, а от браузъра – прихванати.
import { build } from "esbuild";
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const dir = resolve("tests/e2e"), integ = resolve("tests/integration");
mkdirSync(resolve(dir, ".out"), { recursive: true });
await build({
  entryPoints: [resolve(dir, "server.ts")], bundle: true, platform: "node", format: "esm", outfile: resolve(dir, ".out/server.mjs"), target: "node22",
  external: ["pg", "pg-native"], logLevel: "warning",
  banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
  plugins: [{ name: "stubs", setup(b) {
    b.onResolve({ filter: /^(\.\.\/)+db\/index\.js$/ }, () => ({ path: resolve(integ, "stubs/db.ts") }));
    b.onResolve({ filter: /^@netlify\/blobs$/ }, () => ({ path: resolve(integ, "stubs/blobs.ts") }));
  } }],
});
const { default: EmbeddedPostgres } = await import("embedded-postgres");
const dataDir = resolve(dir, ".out/pgdata");
rmSync(dataDir, { recursive: true, force: true });
const pgs = new EmbeddedPostgres({ databaseDir: dataDir, user: "postgres", password: "test", port: 54331, persistent: false, onLog: () => {} });
await pgs.initialise();
await pgs.start();
const port = 8899;
const env = { ...process.env, TEST_DATABASE_URL: "postgres://postgres:test@localhost:54331/postgres", E2E_PORT: String(port) };
const srv = spawn(process.execPath, [resolve(dir, ".out/server.mjs")], { env, stdio: ["ignore", "pipe", "inherit"] });
await new Promise((ok, bad) => { srv.stdout.on("data", (d) => { if (String(d).includes("READY")) ok(); }); srv.on("exit", (c) => bad(new Error("server exited " + c))); });
let code = 0;
const scripts = process.argv.slice(2).length ? process.argv.slice(2).map((s) => resolve(s)) : [resolve(dir, "flow.mjs")];
try {
  for (const s of scripts) {
    console.log(`\n=== ${s.replace(resolve(".") + "/", "")} ===`);
    try { execFileSync(process.execPath, [s, `http://localhost:${port}`], { stdio: "inherit" }); } catch { code = 1; console.log("НЕУСПЕХ: " + s); }
  }
} finally { srv.kill(); await pgs.stop(); }
process.exit(code);
