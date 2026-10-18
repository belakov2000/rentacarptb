import { boolean, check, date, doublePrecision, index, integer, jsonb, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
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
  // Решение по заявката (потвърждаване / отказ): кой го е взел (имейл на администратора или „owner-link“) и вътрешна бележка.
  // decisionNote не се изпраща на клиента (съобщението до клиента е в note). Празно – по-стари решения отпреди тези полета.
  decidedBy: text("decided_by").notNull().default(""),
  decisionNote: text("decision_note").notNull().default(""),
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
  // Реално връщане (приключване на наема) – отбелязва се от администратора само след отбелязано предаване.
  // Договорените дати (startDate/endDate) остават непроменени; заетостта на автомобила свършва при returnedAt + буфера.
  returnedAt: timestamp("returned_at"),
  returnedBy: text("returned_by").notNull().default(""),
  returnNote: text("return_note").notNull().default(""),
  // Кога администраторът е въвел предаването / връщането (handedOverAt / returnedAt са моментите на самите събития –
  // могат да са в миналото при въвеждане след факта). null – записи отпреди тези колони (въведени в момента на събитието).
  handoverRecordedAt: timestamp("handover_recorded_at"),
  returnRecordedAt: timestamp("return_recorded_at"),
  // Клиентски профил – връзката се създава само изрично от администратора (не се обединява автоматично по име/телефон/имейл)
  customerId: integer("customer_id").references(() => customers.id),
  // Снимки на документите от формата: [{ label, id }] – ключове в хранилището documents. null – по-стари заявки (линковете са само в имейла).
  documents: jsonb(),
  // Сървърна цена (server/pricing.ts, server/quote.ts). Статус „server“ – новите резервации: цената е от сървърната оферта
  // и е записана в total / totalCents и договора; price_check е снимката на разбивката (без адресите).
  // match | mismatch | incomplete | error – резервации от етапа „наблюдение“ (сравнение със сумата от браузъра, не са променяни).
  // null – резервации отпреди проверката (не се преизчисляват).
  priceCheck: jsonb("price_check"),
  priceCheckStatus: text("price_check_status"),
  priceCheckedAt: timestamp("price_checked_at"),
  // ===== Двуетапна заявка (кратка форма → първо одобрение → документи → второ одобрение) =====
  // stage: null – стара резервация (едно одобрение, документите са в заявката); request – очаква първо одобрение;
  // docs – одобрена, очакват се документите; review – получени документи, очакват проверка; done – окончателно потвърдена
  stage: text(),
  marketingConsent: boolean("marketing_consent").notNull().default(false),
  chains: boolean().notNull().default(false),
  secondDriver: boolean("second_driver").notNull().default(false),
  // Заявителят и водачите поотделно: { requesterDrives, drivers: [{ role: "main" | "second", name }] } – без данните на документите
  drivers: jsonb(),
  firstApprovedAt: timestamp("first_approved_at"),
  firstApprovedBy: text("first_approved_by"),
  docsInvitedAt: timestamp("docs_invited_at"),
  docsReminderAt: timestamp("docs_reminder_at"),
  docsSubmittedAt: timestamp("docs_submitted_at"),
  // RENTY10: изпратен (валиден 24 ч от изпращането) и използван – само за тази резервация
  couponSentAt: timestamp("coupon_sent_at"),
  couponUsedAt: timestamp("coupon_used_at"),
}, (t) => [
  uniqueIndex("bookings_request_key_idx").on(t.requestKey),
  index("bookings_car_dates_idx").on(t.carId, t.startDate, t.endDate),
  index("bookings_status_idx").on(t.status),
  index("bookings_created_idx").on(t.createdAt),
  index("bookings_utm_idx").on(t.utmCampaign, t.utmContent),
  index("bookings_customer_idx").on(t.customerId),
]);

// Клиентски профили. Създават се ръчно от администратора от конкретна резервация; други резервации се свързват
// само с изрично действие („Свържи“). Номерата и снимките на документите не се пазят тук.
export const customers = pgTable("customers", {
  id: serial().primaryKey(),
  name: text().notNull(),
  email: text().notNull().default(""),
  phone: text().notNull().default(""),
  note: text().notNull().default(""),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedBy: text("updated_by").notNull().default(""),
  updatedAt: timestamp("updated_at"),
});

// Удължавания на наема – история на старите и новите дати и суми (само добавяне).
// calc: auto – по договорената дневна цена от договора × добавени цели дни; manual – сума, въведена и потвърдена от администратора.
export const bookingExtensions = pgTable(
  "booking_extensions",
  {
    id: serial().primaryKey(),
    bookingId: text("booking_id").notNull().references(() => bookings.id),
    oldEndDate: date("old_end_date").notNull(),
    oldEndTime: text("old_end_time").notNull(),
    newEndDate: date("new_end_date").notNull(),
    newEndTime: text("new_end_time").notNull(),
    oldTotalCents: integer("old_total_cents"),
    newTotalCents: integer("new_total_cents"),
    addedCents: integer("added_cents").notNull(),
    dailyCents: integer("daily_cents"),
    addedDays: integer("added_days"),
    calc: text().notNull(), // auto | manual
    contractVersion: integer("contract_version"),
    notify: boolean().notNull().default(false),
    note: text().notNull().default(""),
    idempotencyKey: text("idempotency_key").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("booking_extensions_key_idx").on(t.idempotencyKey), index("booking_extensions_booking_idx").on(t.bookingId)],
);

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
  // Срокове за следващ технически преглед, застраховка и обслужване (по избор) – предупреждения в панела
  inspectionDue: date("inspection_due"),
  insuranceDue: date("insurance_due"),
  serviceDue: date("service_due"),
  updatedBy: text("updated_by").notNull().default(""),
  updatedAt: timestamp("updated_at"),
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
    reason: text().notNull().default(""), // свободен текст (бележка)
    kind: text().notNull().default("other"), // service (сервиз) | personal (лична употреба) | other
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    cancelledAt: timestamp("cancelled_at"),
    cancelledBy: text("cancelled_by").notNull().default(""),
    idempotencyKey: text("idempotency_key"),
  },
  (t) => [index("car_blocks_car_idx").on(t.carId, t.startDate, t.endDate), uniqueIndex("car_blocks_key_idx").on(t.idempotencyKey)],
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
    // Подписване: unknown – няма записани данни (всички версии отпреди тази колона); awaiting – генерирана, очаква подписване.
    // Липсата на записано доказателство не означава, че документът не е подписан.
    signStatus: text("sign_status").notNull().default("unknown"),
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

// Ценови оферти от сървъра (/api/quote, server/quote.ts). Клиентът вижда сървърната разбивка и сумата преди подаването,
// а /api/bookings приема само валидна, неизтекла и неизползвана оферта за същите данни. Офертата НЕ блокира наличност.
// id е SHA-256 на тайния ключ от браузъра (самият ключ не се пази). Адресите не се пазят – само техен хеш в inputHash
// и км / тарифа / източник на маршрута в legs. bookingId се записва в транзакцията на резервацията – една оферта, една резервация.
export const priceQuotes = pgTable(
  "price_quotes",
  {
    id: text().primaryKey(),
    inputHash: text("input_hash").notNull(),
    // Входните данни без адресите: автомобил, дати, часове, брой столчета, държави
    input: jsonb().notNull(),
    // { del?: { km, rate, source }, ret?: { km, rate, source } } – изчислени на сървъра
    legs: jsonb().notNull(),
    version: text().notNull(),
    days: integer().notNull(),
    lines: jsonb().notNull(),
    totalCents: integer("total_cents").notNull(),
    depositCents: integer("deposit_cents").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    bookingId: text("booking_id"),
    usedAt: timestamp("used_at"),
  },
  (t) => [
    index("price_quotes_expires_idx").on(t.expiresAt),
    uniqueIndex("price_quotes_booking_idx").on(t.bookingId),
    check("price_quotes_total_check", sql`${t.totalCents} >= 0`),
  ],
);

// Технически броячи за ограниченията на публичните заявки /api/quote и /api/route (server/limits.ts).
// key: вид + хеш на IP адреса или на случайния ключ на браузъра (без IP адреси и без лични данни).
// Броячът се нулира при следващата заявка след expires_at. Не е бизнес информация и не влиза в резервните копия.
export const apiLimits = pgTable(
  "api_limits",
  {
    key: text().primaryKey(),
    count: integer().notNull().default(0),
    expiresAt: timestamp("expires_at").notNull(),
  },
  (t) => [index("api_limits_expires_idx").on(t.expiresAt)],
);

// Кеш на изчислените разстояния (server/route.ts → cachedRoute). key – хеш на нормализирания адрес; адресът не се пази.
// status: pending – търсенето е заето от една заявка (останалите чакат резултата, вместо да питат доставчика отново);
// ok – км, тарифа, зона и източник; fail – кратко запомнена грешка (reason). Не влиза в резервните копия.
export const routeCache = pgTable(
  "route_cache",
  {
    key: text().primaryKey(),
    status: text().notNull(),
    km: doublePrecision(),
    rate: doublePrecision(),
    local: boolean(),
    source: text(),
    // Точност на намереното място: house (номерът е намерен) | street (само улицата – приблизително) | place (населеното място)
    precision: text(),
    reason: text(),
    claimToken: text("claim_token"),
    claimedAt: timestamp("claimed_at").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
  },
  (t) => [index("route_cache_expires_idx").on(t.expiresAt)],
);
