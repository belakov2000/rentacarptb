import { check, date, index, integer, jsonb, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// Резервации от сайта. Тук пазим само данните, нужни за потвърждението –
// документите на клиента се изпращат само в имейла до фирмата.
export const bookings = pgTable("bookings", {
  id: text().primaryKey(),
  viewToken: text("view_token").notNull(),
  adminToken: text("admin_token").notNull(),
  status: text().notNull().default("pending"), // pending | confirmed | rejected | cancelled (отменена след потвърждение) | no_show (клиентът не се яви)
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
  // Общата сума в евроцентове, изчислена от текста total (той остава непроменен).
  // total_review != "" – сумата не може да се преобразува еднозначно и трябва да се провери от администратора.
  totalCents: integer("total_cents"),
  totalReview: text("total_review").notNull().default(""),
  adminNote: text("admin_note").notNull().default(""),
  updatedAt: timestamp("updated_at"),
  // Ключ от формата: повторно или едновременно изпращане на същата заявка не създава втора резервация
  requestKey: text("request_key"),
  // Действително предаване на автомобила (отбелязва се от собственика). След него отмяна и неявяване не са възможни.
  handedOverAt: timestamp("handed_over_at"),
  handedOverBy: text("handed_over_by").notNull().default(""),
  // Отмяна / неявяване на потвърдена резервация: кога, кой (имейл на администратора или „owner-link“), причина и вътрешна бележка
  // closeReason: customer (клиентът се отказа) | owner (отмяна от собственика) | other | no_show. closeNote не се изпраща на клиента.
  closedAt: timestamp("closed_at"),
  closedBy: text("closed_by").notNull().default(""),
  closeReason: text("close_reason").notNull().default(""),
  closeNote: text("close_note").notNull().default(""),
  // Рекламен източник (UTM) от браузъра на клиента – последното посещение с валидни UTM параметри в рамките на 30 дни,
  // записано само при съгласие за маркетингови бисквитки (server/attribution.ts). Всички полета са от едно и също посещение;
  // utmAt е моментът на това посещение. Празно (null) – няма записан източник (по-стари заявки, директно посещение или без съгласие).
  utmSource: text("utm_source"),
  utmMedium: text("utm_medium"),
  utmCampaign: text("utm_campaign"),
  utmContent: text("utm_content"),
  utmTerm: text("utm_term"),
  utmAt: timestamp("utm_at"),
}, (t) => [
  uniqueIndex("bookings_request_key_idx").on(t.requestKey),
  index("bookings_car_dates_idx").on(t.carId, t.startDate, t.endDate),
  index("bookings_status_idx").on(t.status),
  index("bookings_created_idx").on(t.createdAt),
  index("bookings_utm_idx").on(t.utmCampaign, t.utmContent),
]);

// ===== Административен модул =====
// Всички суми са цели числа в евроцентове (напр. 829,47 € → 82947).

// Плащания по резервации. Възстановяването е отделен запис с refundOf към оригиналното плащане – нищо не се изтрива.
export const payments = pgTable(
  "payments",
  {
    id: text().primaryKey(),
    bookingId: text("booking_id").notNull().references(() => bookings.id),
    amountCents: integer("amount_cents").notNull(), // винаги положително; посоката се определя от kind
    currency: text().notNull().default("EUR"),
    method: text().notNull(), // cash | bank | card | other
    kind: text().notNull(), // deposit | partial | final | extra | refund | security (гаранционен депозит – не е приход)
    status: text().notNull().default("expected"), // expected | received | failed | refunded
    paidAt: timestamp("paid_at"),
    txnId: text("txn_id").notNull().default(""),
    note: text().notNull().default(""),
    refundOf: text("refund_of"),
    // Ключ от формата в браузъра – повторно изпращане на същата форма не създава второ плащане
    idempotencyKey: text("idempotency_key").notNull(),
    createdBy: text("created_by").notNull(),
    updatedBy: text("updated_by").notNull().default(""),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("payments_idempotency_key_idx").on(t.idempotencyKey),
    index("payments_booking_idx").on(t.bookingId),
    index("payments_paid_at_idx").on(t.paidAt),
  ],
);

// История на промените по резервациите и на административните действия (само добавяне)
export const bookingEvents = pgTable(
  "booking_events",
  {
    id: serial().primaryKey(),
    bookingId: text("booking_id"),
    at: timestamp().defaultNow().notNull(),
    actor: text().notNull(), // имейл на администратора, "customer" или "system"
    action: text().notNull(),
    details: jsonb().notNull().default({}),
  },
  (t) => [index("booking_events_booking_idx").on(t.bookingId, t.at)],
);

// Автопарк (ключовете съвпадат с тези на сайта и на договора)
export const cars = pgTable("cars", {
  id: text().primaryKey(),
  brand: text().notNull(),
  model: text().notNull(),
  reg: text().notNull().default(""),
  dailyCents: integer("daily_cents"), // базова дневна цена (1–15 дни) – само за справка, цените на сайта са в index.html
  status: text().notNull().default("active"), // active | inactive
  sort: integer().notNull().default(0),
  note: text().notNull().default(""),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Временно недостъпни периоди (ремонт, обслужване); отменените остават в историята
export const carBlocks = pgTable(
  "car_blocks",
  {
    id: serial().primaryKey(),
    carId: text("car_id").notNull().references(() => cars.id),
    startDate: date("start_date").notNull(),
    startTime: text("start_time").notNull().default("00:00"),
    endDate: date("end_date").notNull(),
    endTime: text("end_time").notNull().default("23:59"),
    reason: text().notNull().default(""),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    cancelledAt: timestamp("cancelled_at"),
  },
  (t) => [index("car_blocks_car_idx").on(t.carId, t.startDate, t.endDate)],
);

// Разходи, въведени от администратора
export const expenses = pgTable(
  "expenses",
  {
    id: serial().primaryKey(),
    carId: text("car_id").references(() => cars.id),
    date: date().notNull(),
    category: text().notNull(), // repair | insurance | service | fuel | tax | other
    amountCents: integer("amount_cents").notNull(),
    note: text().notNull().default(""),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    deletedAt: timestamp("deleted_at"),
  },
  (t) => [index("expenses_date_idx").on(t.date)],
);

// Действителен рекламен разход, въведен ръчно от администратора (не планираният бюджет).
// Един запис = сума в евроцентове за кампания (utm_campaign) и вариант (utm_content) за периода [periodStart, periodEnd] включително.
// Изтриването е логическо (deletedAt) – записите остават в историята.
// Ограничения в базата (миграция add_ad_spend_constraints):
//  • idempotencyKey – уникален: повторно изпращане на същата форма не създава втори запис;
//  • ad_spend_no_overlap (EXCLUDE … WHERE deleted_at IS NULL) – за една кампания и вариант няма два активни записа
//    със застъпващи се периоди, включително при едновременни заявки;
//  • корекция = в една транзакция старият запис се закрива (deletedAt, deletedBy) и се добавя нов с replacesId към него.
export const adSpend = pgTable(
  "ad_spend",
  {
    id: serial().primaryKey(),
    campaign: text().notNull(),
    content: text().notNull().default(""),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    amountCents: integer("amount_cents").notNull(),
    currency: text().notNull().default("EUR"),
    note: text().notNull().default(""),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    deletedAt: timestamp("deleted_at"),
    deletedBy: text("deleted_by").notNull().default(""),
    // Ключ от формата в админ панела (null само за записи отпреди ограничението)
    idempotencyKey: text("idempotency_key"),
    // Корекция: номерът на заменения запис
    replacesId: integer("replaces_id"),
  },
  (t) => [
    index("ad_spend_campaign_idx").on(t.campaign, t.content, t.periodStart),
    uniqueIndex("ad_spend_idempotency_key_idx").on(t.idempotencyKey),
    check("ad_spend_amount_check", sql`${t.amountCents} >= 0`),
    check("ad_spend_period_check", sql`${t.periodStart} <= ${t.periodEnd}`),
  ],
);

// Лог на изпратените имейли; dedupeKey не позволява едно и също писмо да бъде изпратено два пъти.
// recipient е маскиран (напр. „te***@example.com“), а error не съдържа ключове и тайни връзки.
export const emailLog = pgTable(
  "email_log",
  {
    id: serial().primaryKey(),
    at: timestamp().defaultNow().notNull(),
    kind: text().notNull(),
    bookingId: text("booking_id"),
    recipient: text().notNull(),
    subject: text().notNull().default(""),
    status: text().notNull(), // sending | sent | failed
    error: text().notNull().default(""),
    dedupeKey: text("dedupe_key"),
    // Повторни опити: queued → sending → sent | failed (failed се опитва отново до MAX_ATTEMPTS пъти)
    attempts: integer().notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at"),
    sentAt: timestamp("sent_at"),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("email_log_dedupe_idx").on(t.dedupeKey),
    index("email_log_at_idx").on(t.at),
    index("email_log_retry_idx").on(t.status, t.nextAttemptAt),
  ],
);

// Версии на договорите – всяка версия е отделен файл в Blobs (contracts), старите не се презаписват
export const contractVersions = pgTable(
  "contract_versions",
  {
    id: serial().primaryKey(),
    bookingId: text("booking_id").notNull().references(() => bookings.id),
    version: integer().notNull(),
    blobKey: text("blob_key").notNull(),
    fileName: text("file_name").notNull(),
    reason: text().notNull().default(""),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("contract_versions_booking_version_idx").on(t.bookingId, t.version)],
);

// Настройки (буфер между наемите, известия, отчети)
export const settings = pgTable("settings", {
  key: text().primaryKey(),
  value: jsonb().notNull(),
  updatedBy: text("updated_by").notNull().default("system"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
