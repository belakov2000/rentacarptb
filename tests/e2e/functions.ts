// Функциите, които локалният e2e сървър обслужва (същите файлове като в Deploy Preview)
export { default as auth } from "../../netlify/functions/admin-auth.mts";
export { default as adminBookings } from "../../netlify/functions/admin-bookings.mts";
export { default as adminPayments } from "../../netlify/functions/admin-payments.mts";
export { default as fleet } from "../../netlify/functions/admin-fleet.mts";
export { default as customers } from "../../netlify/functions/admin-customers.mts";
export { default as contracts } from "../../netlify/functions/admin-contracts.mts";
export { default as settings } from "../../netlify/functions/admin-settings.mts";
export { default as dashboard } from "../../netlify/functions/admin-dashboard.mts";
export { default as emails } from "../../netlify/functions/admin-emails.mts";
export { default as backups } from "../../netlify/functions/admin-backups.mts";
export { default as ads } from "../../netlify/functions/admin-ads.mts";
export { default as availability } from "../../netlify/functions/availability.mts";
export { default as documents } from "../../netlify/functions/documents.mts";
export { default as bookings } from "../../netlify/functions/bookings.mts";
export { default as quote } from "../../netlify/functions/quote.mts";
export { default as places } from "../../netlify/functions/places.mts";
export { default as customerEmails } from "../../netlify/functions/customer-emails.mts";
