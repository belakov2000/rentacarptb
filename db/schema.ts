import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

// Резервации от сайта. Тук пазим само данните, нужни за потвърждението –
// документите на клиента се изпращат само в имейла до фирмата.
export const bookings = pgTable("bookings", {
  id: text().primaryKey(),
  viewToken: text("view_token").notNull(),
  adminToken: text("admin_token").notNull(),
  status: text().notNull().default("pending"), // pending | confirmed | rejected
  name: text().notNull(),
  email: text().notNull(),
  phone: text().notNull(),
  lang: text().notNull().default("bg"),
  car: text().notNull(),
  pickup: text().notNull(),
  dropoff: text().notNull(),
  total: text().notNull().default(""),
  note: text().notNull().default(""),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  decidedAt: timestamp("decided_at"),
});
