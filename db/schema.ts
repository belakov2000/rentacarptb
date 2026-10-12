import { date, pgTable, text, timestamp } from "drizzle-orm/pg-core";

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
  // Ключ на автомобила и дати (включително) – по тях потвърдените резервации се показват като заети в календара
  carId: text("car_id").notNull().default(""),
  startDate: date("start_date"),
  endDate: date("end_date"),
  // Час на получаване / връщане (HH:MM, местно време) – по него се пращат напомнянията до клиента
  startTime: text("start_time").notNull().default(""),
  endTime: text("end_time").notNull().default(""),
  pickup: text().notNull(),
  dropoff: text().notNull(),
  total: text().notNull().default(""),
  note: text().notNull().default(""),
  payment: text().notNull().default(""), // bankp (банков път, физическо лице) | bank (банков път, фирма) | cash (в брой на място с касов бон)
  invoice: text().notNull().default(""), // данни за фактурата, ако клиентът я е поискал
  createdAt: timestamp("created_at").defaultNow().notNull(),
  decidedAt: timestamp("decided_at"),
  // Кога е изпратено всяко от автоматичните писма до клиента (празно – още не е)
  pickupReminderAt: timestamp("pickup_reminder_at"),
  handoverInfoAt: timestamp("handover_info_at"),
  returnReminderAt: timestamp("return_reminder_at"),
  returnSoonAt: timestamp("return_soon_at"),
  reviewRequestAt: timestamp("review_request_at"),
});
