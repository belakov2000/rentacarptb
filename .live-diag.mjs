import { build } from "esbuild";
await build({ entryPoints: ["server/route.ts"], bundle: true, platform: "node", format: "esm", outfile: "/tmp/diag/route.mjs", logLevel: "error",
  plugins: [{ name: "nodb", setup(b) { b.onResolve({ filter: /db\/index\.js$/ }, () => ({ path: "nodb", namespace: "nodb" })); b.onLoad({ filter: /.*/, namespace: "nodb" }, () => ({ contents: "export const db = {};" })); } }] });
const { routeTo } = await import("/tmp/diag/route.mjs");
const orig = globalThis.fetch;
globalThis.fetch = async (u, i) => { const s = String(u); if (s.includes("nominatim")) await new Promise(r => setTimeout(r, 1100)); const r = await orig(u, i);
  if (s.includes("nominatim/") || s.includes("nominatim.openstreetmap.org/search")) { const j = await r.clone().json().catch(()=>[]); const p = new URL(s).searchParams; console.log("   geocode q=", p.get("q"), "→", (Array.isArray(j)?j:[]).slice(0,3).map(x => `${(+x.lat).toFixed(5)},${(+x.lon).toFixed(5)} ${x.addresstype} [${x.display_name.split(",").slice(0,4).join(",")}]`).join(" | ") || "[]"); }
  if (s.includes("osrm")) console.log("   osrm", s.split("driving/")[1].split("?")[0]);
  return r; };
for (const a of process.argv.slice(2)) { console.log(a); console.log("  =>", JSON.stringify(await routeTo(a))); }
