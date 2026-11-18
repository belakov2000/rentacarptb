async function fiscal() {
  const v = $("#view"),
    current = new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Europe/Sofia",
      year: "numeric",
      month: "2-digit",
    }).format(new Date());
  const selected = qs().get("month") || current;
  const path = "/api/admin/fiscal?month=" + encodeURIComponent(selected);
  v.innerHTML = loading();
  try {
    const d = await api(path);
    const bookingLink = (id) =>
      '<a href="/admin/bookings/' +
      encodeURIComponent(id) +
      '">' +
      esc(id.slice(0, 6).toUpperCase()) +
      "</a>";
    const docLink = (x, kind, label) =>
      '<a href="/api/admin/fiscal?payment=' +
      encodeURIComponent(x.id) +
      "&amp;kind=" +
      kind +
      '">' +
      esc(label) +
      "</a>";
    const problems = d.issues
      .map(
        (i) =>
          "<li>" +
          (i.booking ? bookingLink(i.booking) + " · " : "") +
          esc(i.message) +
          (i.payment && i.message.startsWith("Въведи действителния")
            ? '<form class="row" data-external="' +
              esc(i.payment) +
              '"><label>№ на документ <input name="doc" pattern="[0-9]{1,10}" maxlength="10" required></label><label>Дата на документа <input type="date" name="date" required></label><button class="btn">Запази</button></form>'
            : "") +
          "</li>",
      )
      .join("");
    const documents = d.documents
      .map(
        (x) =>
          "<tr><td>" +
          esc(x.date) +
          "</td><td>" +
          bookingLink(x.order) +
          "</td><td>" +
          (x.invoice ? docLink(x, "invoice", x.invoice) : "—") +
          "</td><td>" +
          (x.missingRrn
            ? '<form data-rrn="' +
              esc(x.id) +
              '"><label>Потвърдена от банката RRN <input name="rrn" pattern="[0-9]{12}" required></label><button class="btn">Запази</button></form>'
            : x.receipt
              ? docLink(x, "receipt", x.receipt)
              : "—") +
          "</td></tr>",
      )
      .join("");
    v.innerHTML =
      '<div class="panel"><form id="fiscalMonth"><label for="fy">Отчетен месец</label><input type="month" id="fy" value="' +
      esc(selected) +
      '" required> <button class="btn">Покажи</button></form>' +
      "<p>Приключени продажби в отчета: " +
      d.orders.length +
      " · " +
      (d.orders.reduce((n, x) => n + x.amount, 0) / 100).toFixed(2) +
      " €<br>Възстановявания: " +
      d.refunds.length +
      " · " +
      (d.refunds.reduce((n, x) => n + x.amount, 0) / 100).toFixed(2) +
      " €</p>" +
      (problems
        ? "<h3>За проверка преди изтегляне</h3><ul>" + problems + "</ul>"
        : d.orders.length
          ? '<a class="btn" href="' +
            esc(path) +
            '&amp;format=xml">Изтегли XML за счетоводството</a>'
          : "Няма приключени продажби или възстановявания за този месец.") +
      (d.refunds.length
        ? "<h3>Възстановявания</h3><ul>" +
          d.refunds
            .map(
              (r) =>
                "<li>" +
                esc(r.date) +
                " · " +
                bookingLink(r.order) +
                " · " +
                (r.amount / 100).toFixed(2) +
                " €</li>",
            )
            .join("") +
          "</ul>"
        : "") +
      "</div>" +
      '<div class="panel scroll"><h3>Документи, издадени през месеца</h3>' +
      (documents
        ? "<table><thead><tr><th>Дата</th><th>Резервация</th><th>Фактура</th><th>Документ за картово плащане</th></tr></thead><tbody>" +
          documents +
          "</tbody></table>"
        : "Няма издадени документи.") +
      "</div>";
    $("#fiscalMonth").onsubmit = (e) => {
      e.preventDefault();
      history.pushState(
        null,
        "",
        "/admin/fiscal?month=" + encodeURIComponent($("#fy").value),
      );
      fiscal();
    };
    v.querySelectorAll("form[data-external], form[data-rrn]").forEach(
      (form) =>
        (form.onsubmit = async (e) => {
          e.preventDefault();
          const button = form.querySelector("button");
          button.disabled = true;
          try {
            await api("/api/admin/fiscal", {
              method: "POST",
              body: JSON.stringify({
                payment: form.dataset.external || form.dataset.rrn,
                ...Object.fromEntries(new FormData(form)),
              }),
            });
            await fiscal();
          } catch (err) {
            button.disabled = false;
            window.alert(err.message);
          }
        }),
    );
  } catch (e) {
    if (e.message !== "unauthorized") v.innerHTML = failed(e);
  }
}

// Loaded after the shared admin shell and before its authenticated first render.
SECTIONS.splice(SECTIONS.findIndex(([id]) => id === "reports") + 1, 0, [
  "fiscal",
  "Отчет за НАП и фактури",
]);
VIEWS.fiscal = fiscal;
