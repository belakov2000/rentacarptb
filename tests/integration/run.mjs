// Всички тестове: node tests/integration/run.mjs        (или само някои: node tests/integration/run.mjs email auth)
// Открива всички *.ts в тази папка (без harness.ts) и пуска и всички tests/*.test.ts. Връща код 1 при неуспешен тест.
// Нужен е PostgreSQL само за тестове: TEST_DATABASE_URL=postgres://…/postgres или временен сървър чрез
//   npm install --no-save embedded-postgres@17.5.0-beta.15   (стартира се и спира автоматично)
// Всеки тест създава собствена празна база с всички миграции. Хранилищата на Netlify Blobs са в паметта (или във
// временна папка), имейлите към Brevo и Netlify Identity се симулират. Не се свързва с Netlify, Brevo или продукционната база.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const dir = resolve("tests/integration");
const ALL = readdirSync(dir).filter((f) => f.endsWith(".ts") && f !== "harness.ts").map((f) => f.slice(0, -3)).sort();
const only = process.argv.slice(2);
const unknown = only.filter((n) => !ALL.includes(n));
if (unknown.length) { console.error(`Няма такива тестове: ${unknown.join(", ")}. Налични: ${ALL.join(", ")}`); process.exit(1); }
mkdirSync(resolve(dir, ".out"), { recursive: true });

export const bundle = (entry, outfile) => build({
  entryPoints: [entry], bundle: true, platform: "node", format: "esm", outfile, target: "node22",
  external: ["pg", "pg-native", "@electric-sql/pglite"], logLevel: "warning",
  banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
  plugins: [{ name: "stubs", setup(b) {
    b.onResolve({ filter: /^(\.\.\/)+db\/index\.js$/ }, () => ({ path: resolve(dir, "stubs/db.ts") }));
    b.onResolve({ filter: /^@netlify\/blobs$/ }, () => ({ path: resolve(dir, "stubs/blobs.ts") }));
  } }],
});

let server = null;
if (!process.env.TEST_DATABASE_URL && process.env.TEST_USE_PGLITE !== "1") {
  const { default: EmbeddedPostgres } = await import("embedded-postgres").catch(() => {
    console.error("Задайте TEST_DATABASE_URL или инсталирайте временен сървър: npm install --no-save embedded-postgres@17.5.0-beta.15");
    process.exit(1);
  });
  const dataDir = resolve(dir, ".out/pgdata");
  rmSync(dataDir, { recursive: true, force: true });
  server = new EmbeddedPostgres({ databaseDir: dataDir, user: "postgres", password: "test", port: 54329, persistent: false, onLog: () => {} });
  await server.initialise();
  await server.start();
  process.env.TEST_DATABASE_URL = "postgres://postgres:test@localhost:54329/postgres";
}

// scripts/restore.ts се пуска като отделен процес от backup-restore – със същите тестови хранилища
await bundle(resolve("scripts/restore.ts"), resolve(dir, ".out/restore-cli.mjs"));

let failed = false;
const summary = [];
const run = (name, args) => {
  console.log(`\n=== ${name} ===`);
  try {
    const out = execFileSync(process.execPath, args, { env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    process.stdout.write(out);
    summary.push(`${name}: ${out.trim().split("\n").filter((l) => /ОБЩО|^ℹ (pass|fail)/.test(l)).join(" ") || "OK"}`);
  } catch (e) {
    failed = true;
    process.stdout.write(String(e.stdout || ""));
    process.stdout.write(String(e.stderr || "").split("\n").filter((l) => !/^\s+at /.test(l)).slice(0, 30).join("\n"));
    summary.push(`${name}: НЕУСПЕХ ${String(e.stdout || "").trim().split("\n").filter((l) => /ОБЩО|^ℹ (pass|fail)/.test(l)).join(" ")}`);
  }
};
try {
  for (const name of only.length ? only : ALL) {
    const outfile = resolve(dir, ".out", name + ".mjs");
    await bundle(resolve(dir, name + ".ts"), outfile);
    run(name, [outfile]);
  }
  // Unit тестове: всички tests/*.test.ts
  const units = readdirSync(resolve("tests")).filter((f) => f.endsWith(".test.ts")).map((f) => "tests/" + f);
  if (!only.length) run("unit (" + units.length + " файла)", ["--experimental-strip-types", "--test", ...units]);
} finally {
  if (server) await server.stop();
}
console.log("\n" + summary.join("\n") + `\n\n${failed ? "РЕЗУЛТАТ: ИМА НЕУСПЕШНИ ТЕСТОВЕ" : "РЕЗУЛТАТ: ВСИЧКИ ТЕСТОВЕ СА УСПЕШНИ"}`);
process.exit(failed ? 1 : 0);
