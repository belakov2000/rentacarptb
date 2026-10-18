// node --experimental-strip-types --test tests/places.test.ts
// Проверени обекти без стандартен адрес (server/geocode.ts → matchPoi): Летище София – Терминал 1 и 2 поотделно, Летище Пловдив.
// Регресия: „Летище София Терминал 2“ се четеше като улица в гр. Пловдив с номер 2 и се отказваше. Без външни заявки.
import assert from "node:assert/strict";
import { test } from "node:test";
import { matchPoi, parseAddr, pickPlace, POIS } from "../server/geocode.ts";
import { CENTRAL_TRAP, DUNAV_10 } from "./fixtures/nominatim.ts";

const id = (a: string) => { const r = matchPoi(a); return r && typeof r === "object" ? r.id : r; };

test("Терминал 1 и Терминал 2 на Летище София – кирилица, латиница, съкращения, три езика", () => {
  for (const a of ["Летище София Терминал 2", "летище София, терминал 2", "Летище „Васил Левски“ София, Т2", "Letishte Sofia Terminal 2", "Sofia Airport, Terminal 2", "Sofia Airport T2", "Flughafen Sofia, Terminal 2", "Aéroport de Sofia, terminal 2", "SOF Airport T 2"])
    assert.equal(id(a), "sof-t2", a);
  for (const a of ["Летище София, Терминал 1", "Sofia Airport, Terminal 1", "Flughafen Sofia, Terminal 1", "Letishte Sofiya T1"])
    assert.equal(id(a), "sof-t1", a);
  // Терминалите не са взаимозаменяеми – различни точки (~1 км)
  assert.notDeepEqual([POIS["sof-t1"].lat, POIS["sof-t1"].lon], [POIS["sof-t2"].lat, POIS["sof-t2"].lon]);
});

test("неясен терминал → избор (не първият резултат)", () => {
  for (const a of ["Летище София", "Sofia Airport", "Flughafen Sofia", "Летище София Терминал 1 или 2", "Летище София, Терминал 3", "Летище София Т2, изход 5"])
    assert.equal(id(a), "terminal", a);
  assert.equal(id("Летище Пловдив или Летище София"), "ambiguous");
});

test("Летище Пловдив", () => {
  for (const a of ["Летище Пловдив", "Plovdiv Airport", "Flughafen Plowdiw", "Летище Крумово"]) assert.equal(id(a), "pdv", a);
});

test("обикновените адреси не са обекти и остават със строгата проверка", () => {
  for (const a of ["ул. Летище 5, Пловдив", "гр. София, ул. Летище 1", "гр. Пловдив, ул. Гладстон 10", "гр. Пловдив, пл. Централен 1", "гр. Пловдив, бул. Дунав 10", "Терминал 2"])
    assert.equal(id(a), null, a);
  assert.equal(pickPlace("гр. Пловдив, пл. Централен 1", CENTRAL_TRAP), "ambiguous"); // Бяла река
  assert.equal((pickPlace("гр. Пловдив, бул. Дунав 10", DUNAV_10) as any).precision, "street"); // непотвърден номер
});

test("причина за отказа преди поправката: парсерът на адреси чете „Терминал 2“ като номер 2 в гр. Пловдив", () => {
  const p = parseAddr("Летище София Терминал 2");
  assert.deepEqual([p.towns, p.number], [["plovdiv"], "2"]); // затова обектите се разпознават преди търсенето на адрес
  assert.equal(id("Летище София Терминал 2"), "sof-t2");
});

// ===== Адрес, избран от предложенията на Google (checkGooglePlace) =====
import { checkGooglePlace, type GPlace } from "../server/geocode.ts";
const gp = (types: string[], lat: number, lon: number, country = "BG", extra: GPlace["addressComponents"] = []): GPlace => ({
  types, location: { latitude: lat, longitude: lon }, formattedAddress: "", addressComponents: [{ longText: "x", shortText: country, types: ["country", "political"] }, ...extra],
});
test("Google: конкретен адрес / обект в България се приема с координатите на избраното място (без проверка на номера в OpenStreetMap)", () => {
  assert.deepEqual(checkGooglePlace(gp(["street_address", "geocode"], 42.1431, 24.7494), "ул. „Гладстон“ 10, Пловдив"), { lat: 42.1431, lon: 24.7494 });
  assert.deepEqual(checkGooglePlace(gp(["premise"], 42.011, 24.877), "ул. Цар Иван Асен II 1, Асеновград"), { lat: 42.011, lon: 24.877 });
  assert.deepEqual(checkGooglePlace(gp(["restaurant", "point_of_interest", "establishment"], 42.6965, 23.3215), "Ресторант, София"), { lat: 42.6965, lon: 23.3215 });
  assert.deepEqual(checkGooglePlace(gp(["geocode"], 42.7, 23.3, "BG", [{ longText: "5", shortText: "5", types: ["street_number"] }]), "ул. X 5"), { lat: 42.7, lon: 23.3 });
});
test("Google: само улица, населено място, квартал или област → уточнение (не центърът на града)", () => {
  for (const t of [["route", "geocode"], ["locality", "political"], ["sublocality", "political"], ["neighborhood", "political"], ["administrative_area_level_1", "political"], ["postal_code"]])
    assert.equal(checkGooglePlace(gp(t, 42.69, 23.32), "x"), "imprecise", t.join());
  assert.equal(checkGooglePlace({ types: ["street_address"], addressComponents: [{ shortText: "BG", types: ["country"] }] }, "x"), "imprecise"); // без координати
});
test("Google: извън България или без държава → отказ", () => {
  assert.equal(checkGooglePlace(gp(["street_address"], 40.64, 22.94, "GR"), "Солун"), "abroad");
  assert.equal(checkGooglePlace({ types: ["street_address"], location: { latitude: 42, longitude: 24 } }, "x"), "abroad");
  assert.equal(checkGooglePlace(null, "x"), "abroad");
});
test("Google: летищата – точката пред терминала; Летище София без терминал → избор; Т1 и Т2 не са взаимозаменяеми", () => {
  assert.equal(checkGooglePlace(gp(["airport", "establishment"], 42.6952, 23.4062), "Летище София, бул. „Христофор Колумб“, София"), "terminal");
  const t2 = checkGooglePlace(gp(["airport", "establishment"], 42.6884, 23.4146), "Терминал 2, Летище София, 1540 София, България") as any;
  assert.equal(t2.poi.id, "sof-t2");
  assert.deepEqual([t2.lat, t2.lon], [POIS["sof-t2"].lat, POIS["sof-t2"].lon]);
  assert.equal((checkGooglePlace(gp(["airport"], 42.6884, 23.4146), "Terminal 1, Sofia Airport") as any).poi.id, "sof-t1");
  assert.equal((checkGooglePlace(gp(["airport", "establishment"], 42.0679, 24.8508), "Летище Пловдив, Крумово") as any).poi.id, "pdv");
  // Обект на летището, който не е самото летище (напр. паркинг) – точката на обекта
  assert.deepEqual(checkGooglePlace(gp(["parking", "establishment"], 42.688, 23.414), "Паркинг P2"), { lat: 42.688, lon: 23.414 });
});
