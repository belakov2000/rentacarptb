// Initial request: contact details only. Document data belongs to the later stage.
export type PersonName = { first: string; middle: string; last: string };
export type Requester = PersonName & { birthDate: string; phoneCountry: string; citizen: string };
const text = (v: unknown, max = 120) => typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, max) : '';
const namePart = (s: string) => /^[\p{L}\p{M}][\p{L}\p{M} .’'\-]{0,79}$/u.test(s);
export const fullName = (p: PersonName) => [p.first, p.middle, p.last].join(' ');
export function parseName(v: any): PersonName | null {
  const p = { first: text(v?.first, 80), middle: text(v?.middle, 80), last: text(v?.last, 80) };
  return Object.values(p).every(namePart) ? p : null;
}
export function validBirthDate(s: string, today = new Date().toISOString().slice(0, 10)) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || s < '1900-01-01' || s >= today) return false;
  const d = new Date(s + 'T12:00:00Z');
  return Number.isFinite(+d) && d.toISOString().slice(0, 10) === s;
}
export function parseRequester(body: any): { requester: Requester; name: string; invoice: string; driverNames: string[] } | { error: string } {
  const p = parseName(body?.requester), dob = text(body?.requester?.birthDate, 10);
  if (!p || !validBirthDate(dob)) return { error: 'requester' };
  if (text(body.email, 200).toLowerCase() !== text(body.emailConfirmation, 200).toLowerCase()) return { error: 'email_confirmation' };
  if (!/^\+[1-9]\d{7,14}$/.test(text(body.phone, 30))) return { error: 'phone' };
  if (body.termsAccepted !== true) return { error: 'terms' };
  const driverNames: string[] = [];
  if (body?.drivers?.requesterDrives === false) {
    const n = parseName(body.drivers.main);
    if (!n) return { error: 'driver_name' };
    driverNames.push(fullName(n));
  } else driverNames.push(fullName(p));
  if (body?.extras?.secondDriver) {
    const n = parseName(body.drivers?.second);
    if (!n) return { error: 'driver_name' };
    driverNames.push(fullName(n));
  }
  let invoice = '';
  if (body.payment === 'bank') {
    const i = body.invoiceData;
    if (!i || !text(i.name) || !text(i.registration, 40) || !text(i.country, 80) || !text(i.address, 200) ||
      (i.notVatRegistered !== true && !text(i.vat, 40))) return { error: 'invoice' };
    invoice = [`Фирма: ${text(i.name)}`, `ЕИК / регистрационен номер: ${text(i.registration, 40)}`,
      i.notVatRegistered === true ? 'Фирмата не е регистрирана по ДДС' : `ДДС номер: ${text(i.vat, 40)}`,
      `Държава: ${text(i.country, 80)}`, `Адрес: ${text(i.address, 200)}`].join('\n');
  }
  return { requester: { ...p, birthDate: dob, phoneCountry: text(body.requester.phoneCountry, 2), citizen: text(body.requester.citizen, 80) }, name: fullName(p), invoice, driverNames };
}
