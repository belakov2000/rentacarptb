import type { Config } from "@netlify/functions";
import { json, requireAdmin } from "../../server/auth.js";
import { FIXTURE, GHL_VERSION, OPPORTUNITY, runContactTest, runOpportunityTest, StepError } from "../../server/ghl.js";
import { deployContext } from "../../server/stores.js";

// Тестове на връзката с HighLevel (GHL) – само в Deploy Preview (средата идва от Netlify на сървъра); иначе 404.
// GET  /api/admin/ghl-test[/opportunity] – само състояние (без заявки към HighLevel и без запис)
// POST /api/admin/ghl-test               – upsert на синтетичния контакт с Do Not Disturb за всички канали
// POST /api/admin/ghl-test/opportunity   – синтетична сделка за вече съществуващия синтетичен контакт
// Тялото на заявката не се чете – всички данни са фиксирани на сървъра (server/ghl.ts).
export default async (req: Request) => {
  if (deployContext() !== "deploy-preview") return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  const admin = await requireAdmin(req);
  if (admin instanceof Response) return admin;

  const token = process.env.GHL_PRIVATE_INTEGRATION_TOKEN || "";
  const locationId = process.env.GHL_LOCATION_ID || "";
  const configured = !!token && /^[A-Za-z0-9_-]{1,64}$/.test(locationId);
  if (req.method === "GET") {
    return json({
      context: "deploy-preview", configured, apiVersion: GHL_VERSION,
      fixture: { name: FIXTURE.name, email: FIXTURE.email },
      opportunity: { name: OPPORTUNITY.name, pipeline: OPPORTUNITY.pipeline, stage: OPPORTUNITY.stage, status: OPPORTUNITY.status, monetaryValue: OPPORTUNITY.monetaryValue, fields: Object.fromEntries(OPPORTUNITY.fields.map((f) => [f.name, f.value])) },
    });
  }
  if (!configured) return json({ ok: false, error: "not_configured" }, 503);

  const test = new URL(req.url).pathname.endsWith("/opportunity") ? "opportunity" : "contact";
  try {
    const result = test === "opportunity" ? await runOpportunityTest(token, locationId) : await runContactTest(token, locationId);
    console.log(`GHL ${test} test ok`, JSON.stringify({ created: result.created }));
    return json({ ok: true, ...result });
  } catch (e) {
    const err = e instanceof StepError ? { step: e.step, error: e.code, upstreamStatus: e.upstream, ...(e.field ? { field: e.field } : {}) } : { step: "internal", error: "internal", upstreamStatus: null };
    console.error(`GHL ${test} test failed`, JSON.stringify(err));
    return json({ ok: false, ...err }, 502);
  }
};

export const config: Config = {
  path: ["/api/admin/ghl-test", "/api/admin/ghl-test/opportunity"],
  method: ["GET", "POST"],
};
