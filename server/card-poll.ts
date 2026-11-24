import { store } from "./stores.js";

const activityKey = "card-activity-until";
const activityWindowMs = 20 * 60_000;

// Only a timestamp is stored. The payments table remains authoritative.
export async function noteCardActivity(now = new Date()) {
  try {
    await store("scheduler", { strong: true }).set(activityKey, String(now.getTime() + activityWindowMs));
  } catch {
    console.warn("Card activity hint unavailable; the scheduled reconciliation will recover it.");
  }
}

export async function shouldPollCards(now = new Date()) {
  // Reconcile even if a hint was lost. Mail jobs already need SQL at these times.
  if (now.getUTCMinutes() % 15 < 5) return true;
  try {
    const until = await store("scheduler", { strong: true }).get(activityKey, { type: "text" });
    if (until === null) return false;
    const expiry = Number(until);
    return !Number.isFinite(expiry) || expiry >= now.getTime();
  } catch {
    return true;
  }
}
