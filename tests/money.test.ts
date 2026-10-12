// node --experimental-strip-types --test tests/
import assert from "node:assert/strict";
import { test } from "node:test";
import { euros, parseTotalCents, totalReviewOf } from "../db/money.ts";

test("сумите от сайта се превръщат в евроцентове", () => {
  // Всички формати, които има в базата към 12.10.2026
  const cases: [string, number][] = [
    ["50 €", 5000], ["120 €", 12000], ["140 €", 14000], ["175 €", 17500], ["196 €", 19600], ["242,10 €", 24210],
    ["261 €", 26100], ["265,76 €", 26576], ["266,46 €", 26646], ["287,04 €", 28704], ["287,46 €", 28746],
    ["296 €", 29600], ["540 €", 54000], ["829,47 €", 82947],
  ];
  for (const [t, c] of cases) assert.equal(parseTotalCents(t), c, t);
});

test("нееднозначните суми не се отгатват, а се отбелязват за проверка", () => {
  for (const t of ["250 € (без доставка)", "1.200 €", "12,5 €", "€ 50", "50", "-50 €", "1234567 €"]) {
    assert.equal(parseTotalCents(t), null, t);
    assert.equal(totalReviewOf(t), "unparsed", t);
  }
  assert.equal(totalReviewOf(""), "empty");
  assert.equal(totalReviewOf("261 €"), "");
});

test("обратно форматиране без плаваща запетая в сметките", () => {
  assert.equal(euros(82947), "829,47 €");
  assert.equal(euros(5000), "50,00 €");
  assert.equal([24210, 26576, 28704].reduce((a, b) => a + b, 0), 79490);
});
