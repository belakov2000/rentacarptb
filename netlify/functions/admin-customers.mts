import type { Config, Context } from "@netlify/functions";
import { and, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { bookingEvents, bookings, customers, payments } from "../../db/schema.js";
import { json, requireAdmin } from "../../server/auth.js";
import { summarize } from "../../server/payments.js";
import { LIST, searchWhere } from "../../server/admin-lists.js";

// Клиенти в админ панела. Профилът се създава само изрично от администратора от конкретна резервация, а други резервации
// се свързват с него само с действие „Свържи“ – никога автоматично по име, телефон или имейл (различни хора може да имат
// еднакви имена или общ телефон / имейл). Възможните съвпадения се показват отделно, без да се свързват.
// В списъците няма номера и снимки на документи.
// GET  /api/admin/customers?q=&page=     – профили (име, телефон, имейл) и резервации без профил, които съвпадат с търсенето
// GET  /api/admin/customers/:id          – профил, свързани резервации с реално получените суми за наема, възможни съвпадения
// POST /api/admin/customers { fromBooking } – нов профил с данните от резервацията (и връзка с нея)
// POST /api/admin/customers/:id { action: link | unlink, bookingId } | { action: update, name?, email?, phone?, note? }
const ID_RE = /^[a-f0-9]{32}$/;
const PAGE = 50;
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const esc = (q: string) => `%${q.replace(/[%_\\]/g, (m) => "\\" + m)}%`;
const digits = (s: string) => s.replace(/\D/g, "");

async function netByBooking(ids: string[]) {
  const list = ids.length ? await db.select().from(payments).where(inArray(payments.bookingId, ids)) : [];
  return new Map(ids.map((id) => [id, summarize(list.filter((p) => p.bookingId === id))]));
}

async function profile(id: number) {
  const [c] = await db.select().from(customers).where(eq(customers.id, id));
  if (!c) return null;
  const linked = await db.select(LIST).from(bookings).where(eq(bookings.customerId, id)).orderBy(desc(bookings.createdAt));
  const sums = await netByBooking(linked.map((b) => b.id));
  // Възможни съвпадения: резервации без профил с еднакъв имейл, телефон или име – само за проверка от администратора
  const ph = digits(c.phone);
  const conds = [
    // lower() от двете страни в базата – еднакво сравнение и за кирилица, независимо от локала
    ...(c.email ? [sql`lower(${bookings.email}) = lower(${c.email})`] : []),
    ...(ph.length >= 6 ? [sql`regexp_replace(${bookings.phone}, '\\D', '', 'g') = ${ph}`] : []),
    sql`lower(${bookings.name}) = lower(${c.name})`,
  ];
  const matches = await db.select(LIST).from(bookings).where(and(isNull(bookings.customerId), or(...conds))).orderBy(desc(bookings.createdAt)).limit(50);
  const why = (b: (typeof matches)[number]) => [
    ...(c.email && b.email.toLowerCase() === c.email.toLowerCase() ? ["email"] : []),
    ...(ph.length >= 6 && digits(b.phone) === ph ? ["phone"] : []),
    ...(b.name.toLowerCase() === c.name.toLowerCase() ? ["name"] : []),
  ];
  const events = await db.select().from(bookingEvents).where(and(sql`${bookingEvents.action} like 'customer.%'`, sql`${bookingEvents.details}->>'customer' = ${String(id)}`)).orderBy(desc(bookingEvents.at)).limit(100);
  const bookingsOut = linked.map((b) => ({ ...b, rentalNetCents: sums.get(b.id)!.rentalNet, securityHeldCents: sums.get(b.id)!.securityHeld }));
  return {
    customer: c, bookings: bookingsOut, totalRentalNetCents: bookingsOut.reduce((a, b) => a + b.rentalNetCents, 0),
    matches: matches.map((b) => ({ ...b, match: why(b) })), events,
  };
}

export default async (req: Request, context: Context) => {
  const admin = await requireAdmin(req);
  if (admin instanceof Response) return admin;
  const url = new URL(req.url);
  const idRaw = context.params?.id || url.pathname.split("/")[4] || "";
  if (!idRaw) {
    if (req.method === "GET") {
      const q = str(url.searchParams.get("q"), 100);
      const page = Math.max(1, Math.min(1000, Number(url.searchParams.get("page")) || 1));
      const like = esc(q), d = digits(q);
      const where = q ? or(ilike(customers.name, like), ilike(customers.email, like), d.length >= 3 ? sql`regexp_replace(${customers.phone}, '\\D', '', 'g') like ${"%" + d + "%"}` : ilike(customers.phone, like)) : undefined;
      const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(customers).where(where);
      const list = await db
        .select({ id: customers.id, name: customers.name, email: customers.email, phone: customers.phone, createdAt: customers.createdAt, bookings: sql<number>`(select count(*)::int from bookings b where b.customer_id = "customers"."id")` })
        .from(customers).where(where).orderBy(desc(customers.createdAt)).limit(PAGE).offset((page - 1) * PAGE);
      // Резервации без профил (по търсенето или последните) – от тях се създава профил
      const s = searchWhere(q);
      const unlinked = await db.select(LIST).from(bookings).where(and(isNull(bookings.customerId), ...(s ? [s] : []))).orderBy(desc(bookings.createdAt)).limit(PAGE);
      return json({ customers: list, total: n, page, pageSize: PAGE, unlinked });
    }
    const body = await req.json().catch(() => null);
    const bid = str(body?.fromBooking, 40);
    if (!ID_RE.test(bid)) return json({ error: "not_found" }, 404);
    const r = await db.transaction(async (tx) => {
      const [b] = await tx.select().from(bookings).where(eq(bookings.id, bid)).for("update");
      if (!b) return { error: "not_found" as const };
      if (b.customerId) return { error: "linked" as const, customerId: b.customerId };
      const [c] = await tx.insert(customers).values({ name: b.name, email: b.email, phone: b.phone, createdBy: admin.email }).returning();
      await tx.update(bookings).set({ customerId: c.id }).where(and(eq(bookings.id, bid), isNull(bookings.customerId)));
      await tx.insert(bookingEvents).values({ bookingId: bid, actor: admin.email, action: "customer.create", details: { customer: String(c.id) } });
      return { id: c.id };
    });
    if ("error" in r) return json(r, r.error === "not_found" ? 404 : 409);
    return json({ ok: true, ...(await profile(r.id)) }, 201);
  }
  const id = Number(idRaw);
  if (!Number.isInteger(id) || id < 1) return json({ error: "not_found" }, 404);
  if (req.method === "GET") {
    const p = await profile(id);
    return p ? json(p) : json({ error: "not_found" }, 404);
  }
  const body = await req.json().catch(() => null);
  const action = body?.action;
  if (action === "link" || action === "unlink") {
    const bid = str(body?.bookingId, 40);
    if (!ID_RE.test(bid)) return json({ error: "not_found" }, 404);
    const r = await db.transaction(async (tx) => {
      const [c] = await tx.select({ id: customers.id }).from(customers).where(eq(customers.id, id));
      if (!c) return { error: "not_found" as const };
      const [u] = await tx.update(bookings).set({ customerId: action === "link" ? id : null })
        .where(and(eq(bookings.id, bid), action === "link" ? isNull(bookings.customerId) : eq(bookings.customerId, id))).returning({ id: bookings.id });
      if (!u) return { error: action === "link" ? ("linked_other" as const) : ("state" as const) };
      await tx.insert(bookingEvents).values({ bookingId: bid, actor: admin.email, action: `customer.${action}`, details: { customer: String(id) } });
      return { ok: true };
    });
    if ("error" in r) return json({ error: r.error }, r.error === "not_found" ? 404 : 409);
    return json({ ok: true, ...(await profile(id)) });
  }
  if (action === "update") {
    const set: Record<string, string> = {};
    if (body.name !== undefined) set.name = str(body.name, 120);
    if (body.email !== undefined) set.email = str(body.email, 200);
    if (body.phone !== undefined) set.phone = str(body.phone, 40);
    if (body.note !== undefined) set.note = str(body.note, 2000);
    if (set.name === "" || (set.email && !/^\S+@\S+\.\S+$/.test(set.email))) return json({ error: "invalid" }, 400);
    const r = await db.transaction(async (tx) => {
      const [cur] = await tx.select().from(customers).where(eq(customers.id, id)).for("update");
      if (!cur) return null;
      const changed = Object.keys(set).filter((k) => (cur as any)[k] !== set[k]);
      if (!changed.length) return cur;
      const [u] = await tx.update(customers).set({ ...set, updatedBy: admin.email, updatedAt: new Date() }).where(eq(customers.id, id)).returning();
      await tx.insert(bookingEvents).values({ bookingId: null, actor: admin.email, action: "customer.update", details: { customer: String(id), changed } });
      return u;
    });
    if (!r) return json({ error: "not_found" }, 404);
    return json({ ok: true, ...(await profile(id)) });
  }
  return json({ error: "action" }, 400);
};

export const config: Config = {
  path: ["/api/admin/customers", "/api/admin/customers/:id"],
  method: ["GET", "POST"],
};
