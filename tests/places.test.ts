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
