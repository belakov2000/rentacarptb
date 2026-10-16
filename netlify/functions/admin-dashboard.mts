import type { Config } from "@netlify/functions";
import { json, requireAdmin } from "../../server/auth.js";
import { dashboard } from "../../server/admin-lists.js";

// GET /api/admin/dashboard – началното табло: чакащи, получавания и връщания днес (българско време), текущи наеми,
// просрочени връщания, потвърдени без отбелязано предаване, неприключени депозити, имейли за внимание и срокове на автомобилите.
// Правилата са общи с филтрите в „Резервации“ (server/admin-lists.ts) – всеки показател отваря същите записи.
export default async (req: Request) => {
  const admin = await requireAdmin(req);
  if (admin instanceof Response) return admin;
  return json(await dashboard());
};

export const config: Config = { path: "/api/admin/dashboard", method: ["GET"] };
