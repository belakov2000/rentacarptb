import { readFile } from "node:fs/promises";
import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import QRCode from "qrcode";
import {
  localStamp,
  lineTotal,
  money,
  type Snapshot,
  type Sale,
} from "./fiscal.js";

export async function fiscalPdf(sale: Sale, invoice: boolean) {
  const s = sale.snapshot as Snapshot;
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(
    await readFile("server/fiscal-assets/DejaVuSans.ttf"),
    { subset: true },
  );
  let page = doc.addPage([595, 842]),
    y = 792;
  const row = (value: string, size = 11) => {
    let current = "";
    const write = () => {
      if (y < 55) {
        page = doc.addPage([595, 842]);
        y = 792;
      }
      page.drawText(current, {
        x: 42,
        y,
        size,
        font,
        color: rgb(0.08, 0.12, 0.18),
      });
      y -= size + 6;
      current = "";
    };
    for (const word of value.replace(/[\r\n\t]/g, " ").split(/\s+/)) {
      if (current && font.widthOfTextAtSize(current + " " + word, size) > 510)
        write();
      for (const char of word) {
        if (font.widthOfTextAtSize(current + char, size) > 510) write();
        current += char;
      }
      current += " ";
    }
    write();
  };
  const stamp = localStamp(
    invoice ? sale.invoiceIssuedAt || sale.issuedAt : sale.issuedAt,
  );
  const number = invoice ? sale.invoice : sale.receipt;
  row(
    (invoice ? "Фактура" : "Документ за регистриране на продажба") +
      " № " +
      number,
    19,
  );
  row("Издаден на " + stamp + " • EUR");
  row(s.supplier.name, 14);
  row(
    "ЕИК " +
      s.supplier.eik +
      " • " +
      s.supplier.address +
      " • " +
      s.supplier.contact,
  );
  if (invoice) {
    row("Получател", 14);
    for (const line of s.buyer.split("\n")) row(line);
  }
  row("Поръчка " + s.order + " от " + s.orderDate);
  row(
    (s.advance ? "Дата на авансово плащане: " : "Дата на плащане: ") +
      s.eventDate,
  );
  if (invoice && !s.advance)
    row("Дата на данъчното събитие: " + (s.serviceDate || s.eventDate));
  if (s.rrn) row("Референция на трансакцията (RRN): " + s.rrn);
  y -= 8;
  for (const i of s.items) {
    row((s.advance ? "Аванс — " : "") + i.name);
    row(
      i.qty +
        " × " +
        money(i.unit) +
        " €" +
        (i.discount ? "   Отстъпка " + money(i.discount) + " €" : "") +
        "   Общо " +
        money(lineTotal(i)) +
        " €   Група " +
        s.vatGroup,
      10,
    );
  }
  row("Обща стойност: " + money(s.amount) + " EUR", 15);
  row(s.vatReason);
  row(
    "Начин на плащане: " +
      ({
        vpos: "онлайн с карта",
        cash: "в брой",
        bank: "банков превод",
        card: "карта",
        other: "друг",
      }[s.method] || s.method),
  );
  if (!invoice) {
    if (!s.rrn) throw new Error("Няма банкова референция");
    const qr = [
      s.shop,
      "",
      s.order,
      s.rrn,
      stamp.slice(0, 10),
      stamp.slice(11),
      money(s.amount),
    ].join("*");
    const png = await doc.embedPng(
      await QRCode.toBuffer(qr, {
        margin: 4,
        width: 320,
        errorCorrectionLevel: "M",
      }),
    );
    if (y < 167) {
      page = doc.addPage([595, 842]);
      y = 792;
    }
    y -= 105;
    page.drawImage(png, { x: 42, y, width: 100, height: 100 });
    y -= 18;
    row("Електронен магазин № " + s.shop);
  }
  return doc.save();
}
