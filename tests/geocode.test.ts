// node --experimental-strip-types --test tests/geocode.test.ts
// Регресия: „гр. Пловдив, пл. Централен 1“ се изчисляваше като 49,8 км × 0,70 € до пл. Централен в с. Бяла река
// (общ. Първомай) – „Пловдив“ съвпада и с името на областта, а първият резултат на Nominatim се приемаше без проверка.
// Проверяват се правилата в server/geocode.ts с реални отговори на Nominatim (tests/fixtures/nominatim.ts). Без външни заявки.
import assert from "node:assert/strict";
import { test } from "node:test";
import { endPrecision, fold, parseAddr, pickPlace, queriesFor } from "../server/geocode.ts";
import { BOTEV_82, CENTRAL_TRAP, DUNAV_10, KNYAZ_42, nom } from "./fixtures/nominatim.ts";

const plovdiv = (road: string, house_number?: string, extra: Record<string, string> = {}) =>
  nom(42.15, 24.75, house_number ? "building" : "road", house_number ? 30 : 26, road, { ...(house_number ? { house_number } : {}), road, city: "Пловдив", state: "Пловдив", ...extra });

test("пл. Централен 1 в гр. Пловдив: не се избира с. Бяла река (обл. Пловдив), а се иска уточнение", () => {
  for (const a of ["гр. Пловдив, пл. Централен 1", "пл. Централен 1, Пловдив", "площад Централен 1", "Plovdiv, pl. Tsentralen 1", "гр. Пловдив, обл. Пловдив, пл. Централен 1"])
    assert.equal(pickPlace(a, CENTRAL_TRAP), "ambiguous", a);
  // Бяла река е приета само когато клиентът сам посочи селото
  const p = pickPlace("с. Бяла река, пл. Централен 1", CENTRAL_TRAP);
  assert.ok(p && p !== "ambiguous" && p.lat === 42.058466 && p.precision === "street");
  // Районът „Централен“ на гр. Пловдив не е улица „Централен“
  assert.equal(pickPlace("гр. Пловдив, пл. Централен 1", [CENTRAL_TRAP[1]]), "ambiguous");
});

test("коректен адрес до номер, нееднозначен адрес и липсващ резултат", () => {
  assert.deepEqual(pickPlace("ул. Княз Александър I 42, Пловдив", KNYAZ_42), { lat: 42.1447618, lon: 24.7493222, name: KNYAZ_42[0].display_name, precision: "house" });
  const b = pickPlace("бул. Христо Ботев 82, Пловдив", BOTEV_82);
  assert.ok(b && b !== "ambiguous" && b.precision === "house");
  // Улица със същото име само в друго населено място
  assert.equal(pickPlace("гр. Пловдив, ул. Гладстон 10", [nom(42.07744, 24.66421, "road", 26, "Гладстон", { road: "Гладстон", village: "Първенец", municipality: "Родопи", state: "Пловдив" })]), "ambiguous");
  // Друга улица в същия град
  assert.equal(pickPlace("гр. Пловдив, ул. Гладстон 10", [plovdiv("ул. Райко Даскалов", "10")]), "ambiguous");
  // Резултат без подробности за адреса не може да бъде проверен
  assert.equal(pickPlace("гр. Пловдив, ул. Гладстон 10", [{ lat: "42.15", lon: "24.75", display_name: "ул. Гладстон 10, Пловдив" }]), "ambiguous");
  assert.equal(pickPlace("гр. Пловдив, ул. Няма 5", []), null);
});

test("номер на сградата: само улицата не е точно намерен адрес", () => {
  // бул. Дунав 10: в OpenStreetMap има само отсечки от булеварда – точност „street“, не „house“
  const d = pickPlace("гр. Пловдив, бул. Дунав 10", DUNAV_10);
  assert.ok(d && d !== "ambiguous");
  assert.equal(d.precision, "street");
  assert.deepEqual([d.lat, d.lon], [42.1618718, 24.7336781]);
  // Друг номер на същата улица не е въведеният
  const other = pickPlace("ул. Гладстон 10, Пловдив", [plovdiv("ул. Гладстон", "12")]);
  assert.ok(other && other !== "ambiguous" && other.precision === "street");
  // При няколко резултата се предпочита сградата с въведения номер
  const best = pickPlace("ул. Гладстон 10, Пловдив", [plovdiv("ул. Гладстон"), { ...plovdiv("ул. Гладстон", "10"), lat: "42.143" }]);
  assert.ok(best && best !== "ambiguous" && best.precision === "house" && best.lat === 42.143);
  // Буква и диапазон в номера; блок / вход / етаж / апартамент не пречат
  for (const [a, hn] of [["ул. Гладстон 10А, ет. 3, ап. 5", "10а"], ["ул. Гладстон № 12", "10-12"], ["ул. Гладстон 7, вх. Б", "7"]]) {
    const p = pickPlace(a, [plovdiv("ул. Гладстон", hn)]);
    assert.ok(p && p !== "ambiguous" && p.precision === "house", a);
  }
  // Без въведен номер – улицата (приблизително)
  const s = pickPlace("ул. Гладстон, Пловдив", [plovdiv("ул. Гладстон", "1")]);
  assert.ok(s && s !== "ambiguous" && s.precision === "street");
});

test("кирилица и латиница, съкращения, римски цифри", () => {
  const ok = (a: string, r = KNYAZ_42) => { const p = pickPlace(a, r); return p && p !== "ambiguous" ? p.precision : p; };
  for (const a of ["ул. Княз Александър I 42, Пловдив", "улица Княз Александър I 42, гр. Пловдив", "ул. Княз Александър І 42", "ul. Knyaz Aleksandar I 42, Plovdiv", "KNYAZ ALEKSANDAR I 42, PLOVDIV", "ул. „Княз Александър I“ № 42, Пловдив"])
    assert.equal(ok(a), "house", a);
  // Друга римска цифра е друга улица
  assert.equal(ok("ул. Княз Александър II 42, Пловдив"), "ambiguous");
  assert.equal(ok("ул. Цар Иван Асен II 1, Пловдив", [plovdiv("ул. Цар Иван Асен I", "1")]), "ambiguous");
  assert.equal(ok("ул. Цар Иван Асен II 1, Пловдив", [plovdiv("ул. Цар Иван Асен II", "1")]), "house");
  // бул. = булевард = blvd. = без вида на улицата
  for (const a of ["бул. Христо Ботев 82", "булевард Христо Ботев 82, Пловдив", "blvd. Hristo Botev 82, Plovdiv", "Христо Ботев 82"]) assert.equal(ok(a, BOTEV_82), "house", a);
  assert.equal(fold("Пловдив"), fold("Plovdiv"));
});

test("населеното място: изрично, без „гр.“, квартал на Пловдив, село без улици", () => {
  const ase = nom(42.0139, 24.8686, "building", 30, "", { house_number: "1", road: "ул. Цар Иван Асен II", town: "Асеновград", state: "Пловдив" });
  // Асеновград без „гр.“ – адрес в Пловдив на същата улица не се приема
  assert.equal(pickPlace("Асеновград, ул. Цар Иван Асен II 1", [plovdiv("ул. Цар Иван Асен II", "1")]), "ambiguous");
  assert.equal((pickPlace("Асеновград, ул. Цар Иван Асен II 1", [ase]) as any).precision, "house");
  // Квартал на Пловдив без „гр.“
  assert.equal((pickPlace("Кършияка, ул. Победа 5", [plovdiv("ул. Победа", "5", { suburb: "Кършияка" })]) as any).precision, "house");
  // Село без улици в OpenStreetMap – центърът на селото (точност „place“)
  const v = nom(42.0598, 24.6998, "village", 19, "Брестник", { village: "Брестник", municipality: "Родопи", state: "Пловдив" });
  assert.equal((pickPlace("с. Брестник, ул. Първа 5", [v]) as any).precision, "place");
  assert.equal((pickPlace("с. Брестник", [v]) as any).precision, "place");
  // Без населено място адресът е в гр. Пловдив (не в с. Свобода)
  assert.deepEqual(parseAddr("Свобода 73").towns, ["plovdiv"]);
  assert.equal(pickPlace("Свобода 73", [nom(43.4, 27.7, "road", 26, "Свобода", { road: "Свобода", village: "Свобода", state: "Добрич" })]), "ambiguous");
});

test("заявки към Nominatim: свободен текст, после улица + населено място (структурирано търсене)", () => {
  assert.deepEqual(queriesFor("гр. Пловдив, бул. Дунав 10", "гр. Пловдив, бул. Дунав 10"), [
    { q: "гр. Пловдив, бул. Дунав 10" }, { street: "бул. Дунав 10", city: "Пловдив" }, { q: "Дунав 10, Пловдив" },
  ]);
  assert.deepEqual(queriesFor("ж.к. Тракия, Пловдив", "ж.к. Тракия, Пловдив"), [{ q: "ж.к. Тракия, Пловдив" }]);
});

test("крайна точка от Google (обратно търсене): населено място и номер", () => {
  assert.equal(endPrecision("гр. Пловдив, пл. Централен 1", CENTRAL_TRAP[0]), null); // Бяла река – отказ
  assert.equal(endPrecision("ул. Княз Александър I 42, Пловдив", KNYAZ_42[0]), "house");
  assert.equal(endPrecision("гр. Пловдив, бул. Дунав 10", DUNAV_10[0]), "street");
  assert.equal(endPrecision("гр. Пловдив, бул. Дунав 10", null), null);
});
