import { eq, like } from "drizzle-orm";
import { db } from "../db/index.js";
import { bookingEvents, settings } from "../db/schema.js";

// Настройки, които се променят от админ панела (Настройки и автоматизации) и се четат от сървъра – един източник:
// таблицата settings. Липсващ ред = стойностите по подразбиране (същите като преди настройките).
//
// reminders – автоматичните напомняния до клиента с потвърдена резервация (функцията customer-emails):
//   pickup24   – първо напомняне преди получаване (по подразбиране 24 ч.)
//   handover   – инструкции за предаването преди получаване (по подразбиране 3 ч.)
//   return24   – първо напомняне преди връщане (по подразбиране 24 ч.)
//   returnSoon – второ напомняне преди връщане (по подразбиране 3 ч.)
// Молбата за отзив (2 ч. след края) не се настройва.
export type ReminderKey = "pickup24" | "handover" | "return24" | "returnSoon";
export type Reminder = { enabled: boolean; hours: number };
export type Reminders = Record<ReminderKey, Reminder>;
export const REMINDER_KEYS: ReminderKey[] = ["pickup24", "handover", "return24", "returnSoon"];
export const REMINDER_DEFAULTS: Reminders = {
  pickup24: { enabled: true, hours: 24 },
  handover: { enabled: true, hours: 3 },
  return24: { enabled: true, hours: 24 },
  returnSoon: { enabled: true, hours: 3 },
};
// Допустими часове: първото напомняне 12–72 ч., второто 1–6 ч. (второто е в деня на получаването / връщането)
export const REMINDER_LIMITS: Record<ReminderKey, [number, number]> = { pickup24: [12, 72], handover: [1, 6], return24: [12, 72], returnSoon: [1, 6] };

function normalize(v: unknown): Reminders {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, any>;
  const out = {} as Reminders;
  for (const k of REMINDER_KEYS) {
    const [lo, hi] = REMINDER_LIMITS[k];
    const h = Number(o[k]?.hours);
    out[k] = {
      enabled: typeof o[k]?.enabled === "boolean" ? o[k].enabled : REMINDER_DEFAULTS[k].enabled,
      hours: Number.isInteger(h) && h >= lo && h <= hi ? h : REMINDER_DEFAULTS[k].hours,
    };
  }
  return out;
}

export async function getReminders(q: Pick<typeof db, "select"> = db) {
  const [r] = await q.select().from(settings).where(eq(settings.key, "reminders"));
  return { value: normalize(r?.value), updatedBy: r?.updatedBy ?? "", updatedAt: r?.updatedAt ?? null, saved: !!r };
}

// Строга проверка на входа от панела – невалидна стойност се отказва (не се поправя мълчаливо)
export function parseReminders(v: unknown): Reminders | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, any>;
  const out = {} as Reminders;
  for (const k of REMINDER_KEYS) {
    const [lo, hi] = REMINDER_LIMITS[k];
    const h = Number(o[k]?.hours);
    if (typeof o[k]?.enabled !== "boolean" || !Number.isInteger(h) || h < lo || h > hi) return null;
    out[k] = { enabled: o[k].enabled, hours: h };
  }
  return out;
}

export async function saveReminders(value: Reminders, actor: string) {
  return db.transaction(async (tx) => {
    const [cur] = await tx.select().from(settings).where(eq(settings.key, "reminders")).for("update");
    const before = normalize(cur?.value);
    await tx
      .insert(settings)
      .values({ key: "reminders", value, updatedBy: actor, updatedAt: new Date() })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedBy: actor, updatedAt: new Date() } });
    await tx.insert(bookingEvents).values({ bookingId: null, actor, action: "settings.reminders", details: { before, after: value } });
    return value;
  });
}

// Последно изпълнение на автоматичните задачи (customer-emails, email-retry) – за панела
export async function recordJob(name: string, info: Record<string, unknown> = {}) {
  const value = { at: new Date().toISOString(), ...info };
  await db
    .insert(settings)
    .values({ key: "job:" + name, value, updatedBy: "system", updatedAt: new Date() })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedBy: "system", updatedAt: new Date() } })
    .catch((e) => console.error("Job status not recorded", (e as Error)?.message));
}
export const jobStatus = () => db.select({ key: settings.key, value: settings.value }).from(settings).where(like(settings.key, "job:%"));
