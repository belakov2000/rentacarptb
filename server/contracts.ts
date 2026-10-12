import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { bookingEvents, contractVersions } from "../db/schema.js";
import { buildContract, contractFileName, type ContractData } from "../contract/index.js";
import { store } from "./stores.js";

// Договори с версии. Текущият договор остава на същия ключ (<резервация>), за да работят старите линкове,
// а всяка версия се пази отделно (versions/<резервация>/v<N>-<случаен>.docx) и се записва в contract_versions.
// Старите версии не се презаписват и не се изтриват.
export const contracts = () => store("contracts");
export const contractDataKey = (id: string) => `${id}.json`;
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const rnd = () => crypto.randomUUID().replace(/-/g, "").slice(0, 12);

async function addVersion(bookingId: string, file: Uint8Array | ArrayBuffer, name: string, reason: string, actor: string) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const [{ n }] = await db
      .select({ n: sql<number>`coalesce(max(${contractVersions.version}), 0)::int` })
      .from(contractVersions)
      .where(eq(contractVersions.bookingId, bookingId));
    const version = n + 1;
    const blobKey = `versions/${bookingId}/v${version}-${rnd()}.docx`;
    await contracts().set(blobKey, new Blob([new Uint8Array(file as ArrayBuffer)]), { metadata: { name, version, contentType: DOCX } });
    // Уникалното ограничение (booking_id, version) не позволява две версии с един номер при едновременен запис
    const [row] = await db
      .insert(contractVersions)
      .values({ bookingId, version, blobKey, fileName: name, reason, createdBy: actor })
      .onConflictDoNothing()
      .returning();
    if (row) return row;
  }
  throw new Error("Could not allocate a contract version");
}

// Договори отпреди версиите: текущият файл се запазва като версия 1, преди да бъде заменен
async function preserveLegacy(bookingId: string) {
  const [has] = await db.select({ id: contractVersions.id }).from(contractVersions).where(eq(contractVersions.bookingId, bookingId)).limit(1);
  if (has) return;
  const cur = await contracts().getWithMetadata(bookingId, { type: "arrayBuffer" });
  if (cur) await addVersion(bookingId, cur.data, String(cur.metadata?.name || "Dogovor-naem.docx"), "Договор отпреди историята на версиите", "system");
}

export async function saveContract(bookingId: string, data: ContractData, actor: string, reason: string) {
  const file = buildContract(data);
  const name = contractFileName(data);
  await preserveLegacy(bookingId);
  const v = await addVersion(bookingId, file, name, reason, actor);
  await contracts().set(bookingId, new Blob([new Uint8Array(file)]), { metadata: { name, version: v.version } });
  await contracts().setJSON(contractDataKey(bookingId), data);
  await db.insert(bookingEvents).values({ bookingId, actor, action: "contract.version", details: { version: v.version, reason } });
  return { file, name, version: v.version };
}

export const listContractVersions = (bookingId: string) =>
  db.select().from(contractVersions).where(and(eq(contractVersions.bookingId, bookingId))).orderBy(contractVersions.version);
