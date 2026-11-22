// Standalone office contracts share the authenticated admin shell and its router.
(() => {
  const base = "/api/admin/manual-contracts";
  const path = "/admin/manual-contracts";
  const slots = {
    "id-front": "Документ за самоличност – лице",
    "id-back": "Документ за самоличност – гръб",
    "licence-front": "Шофьорска книжка – лице",
    "licence-back": "Шофьорска книжка – гръб",
  };

  function input(key, label, value, type = "text", options = "") {
    return `<div><label for="mc-${key}">${label}</label><input id="mc-${key}" name="${key}" type="${type}" value="${esc(value ?? "")}" ${options}></div>`;
  }

  function select(key, label, value, choices, required = false) {
    const options = choices.map(([val, title]) =>
      `<option value="${esc(val)}" ${val === value ? "selected" : ""}>${esc(title)}</option>`
    ).join("");
    return `<div><label for="mc-${key}">${label}</label><select id="mc-${key}" name="${key}" ${required ? "required" : ""}>${options}</select></div>`;
  }

  function rentalLeg(key, title, leg) {
    return `<h4>${title}</h4><div class="grid">
      ${input(key + "Addr", "Адрес (празно за офиса)", leg?.addr, "text", 'maxlength="200"')}
      ${input(key + "Km", "Километри", leg?.km, "number", 'min="0" max="9999" step="0.01"')}
      ${select(key + "Rate", "Тарифа за километър", String(leg?.rate ?? 1), [["1", "1,00 €"], ["0.7", "0,70 €"]])}</div>`;
  }

  function abroadRow(country = {}) {
    const row = document.createElement("div");
    row.className = "grid";
    row.dataset.countryRow = "";
    row.innerHTML = `<label>Държава<input name="countryName" value="${esc(country.name)}" maxlength="60" required></label>
      <label>Такса (€)<input name="countryFee" type="number" step="0.01" min="0" max="999999" value="${esc(country.fee ?? "")}" required></label>
      <div class="bar"><button class="btn ghost" type="button">Премахни държавата</button></div>`;
    row.querySelector("button").onclick = () => {
      row.dispatchEvent(new Event("input", { bubbles: true }));
      row.remove();
    };
    return row;
  }

  function formContent(data, cars) {
    const pickup = rentalLeg("del", "Предаване на автомобила", data.del);
    const dropoff = rentalLeg("ret", "Връщане на автомобила", data.ret);
    return `<form id="mc-form" autocomplete="off">
      <div class="panel"><h3>Автомобил и наем</h3><div class="grid">
        ${select("carId", "Автомобил", data.carId || "", [["", "Избери автомобил"], ...cars.map(c => [c.id, [c.brand, c.model, c.reg].filter(Boolean).join(" ")])], true)}
        ${input("rent", "Цена на наема за целия период (€)", data.rent, "number", 'min="0" max="999999.99" step="0.01" required')}
      </div><div class="grid">
        ${input("d1", "Дата на получаване", data.d1, "date", "required")}
        ${input("t1", "Час на получаване", data.t1, "time", "required")}
        ${input("d2", "Дата на връщане", data.d2, "date", "required")}
        ${input("t2", "Час на връщане", data.t2, "time", "required")}
      </div></div>
      <div class="panel"><h3>Наемател</h3><div class="grid">
        ${input("name", "Пълно име по документ", data.name, "text", 'maxlength="160" required')}
        ${input("citizen", "Гражданство", data.citizen, "text", 'maxlength="80"')}
        ${input("egn", "ЕГН / личен номер", data.egn, "text", 'maxlength="20"')}
      </div><div class="grid">
        ${select("idt", "Документ за самоличност", data.idt || "id", [["id", "Лична карта"], ["pass", "Паспорт"]])}
        ${input("idn", "Номер на документа", data.idn, "text", 'maxlength="40"')}
        ${input("idd", "Дата на издаване", data.idd, "date")}
        ${input("idp", "Издаващ орган", data.idp, "text", 'maxlength="120"')}
      </div><h4>Адрес по документ</h4><div class="grid">
        ${input("region", "Област", data.region, "text", 'maxlength="80"')}
        ${input("municipality", "Община", data.municipality, "text", 'maxlength="80"')}
        ${select("placeType", "Вид населено място", data.placeType || "", [["", "—"], ["city", "Град"], ["village", "Село"]])}
        ${input("city", "Населено място", data.city, "text", 'maxlength="80"')}
        ${input("addr", "Улица, номер, блок, апартамент", data.addr, "text", 'maxlength="200"')}
      </div><h4>Шофьорска книжка</h4><div class="grid">
        ${input("dln", "Номер на книжката", data.dln, "text", 'maxlength="40"')}
        ${input("dld", "Дата на издаване", data.dld, "date")}
        ${input("dlp", "Издаващ орган", data.dlp, "text", 'maxlength="120"')}
      </div></div>
      <details class="panel"${data.del || data.ret || data.seatN || data.abroad?.length ? " open" : ""}><summary>Доставка, детски столчета и пътуване в чужбина</summary>
        ${pickup}${dropoff}<h4>Детски столчета</h4><div class="grid">
        ${input("seatN", "Брой столчета", data.seatN || "", "number", 'min="0" max="5" step="1"')}
        ${input("seatDay", "Обща цена за столчетата на ден (€)", data.seatDay || "", "number", 'min="0" max="999999" step="0.01"')}
        </div><h4>Пътуване в чужбина</h4><div id="mc-countries"></div>
        <button type="button" class="btn ghost" id="mc-add-country">Добави държава</button>
      </details>
      <div class="panel"><label for="mc-appendix">Допълнителни условия за този договор (по един абзац на ред)</label><textarea id="mc-appendix" name="appendix" rows="3">${esc((data.appendix || []).join("\n"))}</textarea></div>
      <div id="mc-message" role="status"></div>
      <button type="submit" class="btn acc">Запази договора</button>
    </form>`;
  }

  function readForm(form, oldData) {
    const fields = new FormData(form);
    const text = key => String(fields.get(key) ?? "").trim();
    const number = key => text(key) === "" ? null : Number(text(key));
    const data = { ...oldData };
    for (const key of ["carId","name","citizen","egn","idt","idn","idd","idp","region","municipality","placeType","city","addr","dln","dld","dlp","d1","t1","d2","t2"]) {
      data[key] = text(key);
    }
    data.appendix = text("appendix").split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    data.rent = number("rent");
    for (const key of ["del", "ret"]) {
      data[key] = text(key + "Addr") ? { addr: text(key + "Addr"), km: number(key + "Km"), rate: number(key + "Rate") } : null;
    }
    data.seatN = number("seatN") ?? 0;
    data.seatDay = data.seatN ? number("seatDay") : null;
    delete data.days;
    delete data.seat;
    data.abroad = Array.from(form.querySelectorAll("[data-country-row]"), row => ({
      name: row.querySelector('[name="countryName"]').value.trim(),
      fee: Number(row.querySelector('[name="countryFee"]').value),
    }));
    return data;
  }

  const errorText = e => e.status === 409
    ? "Договорът е променен в друг прозорец. Отвори запазения договор отново, преди да приложиш промените си."
    : `Неуспешен запис (${e.message}).`;

  function notice(el, text, isError) {
    el.className = isError ? "msg err" : "msg ok";
    el.textContent = text;
  }

  async function jpeg(file) {
    if (file.size > 25 * 1024 * 1024) throw new Error("Избери снимка под 25 MB.");
    const img = new Image();
    const url = URL.createObjectURL(file);
    try {
      img.src = url;
      await img.decode();
      const factor = Math.min(1, 1800 / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.naturalWidth * factor));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * factor));
      const context = canvas.getContext("2d");
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(img, 0, 0, canvas.width, canvas.height);
      return await new Promise((resolve, reject) => canvas.toBlob(
        blob => blob ? resolve(blob) : reject(new Error("Снимката не може да се подготви.")), "image/jpeg", 0.82));
    } catch {
      throw new Error("Снимката не може да се прочете. Избери JPEG, PNG или WebP.");
    } finally { URL.revokeObjectURL(url); }
  }

  function renderPhotos(container, record) {
    container.replaceChildren();
    if (!record?.id) return;
    const saved = new Map((record.documents || []).map(doc => [doc.slot, doc.etag]));
    if (!record.photoUploadsEnabled && !saved.size) return;
    const panel = document.createElement("div");
    panel.className = "panel";
    panel.innerHTML = '<h3>Снимки на документи</h3><div class="grid"></div>';
    const grid = panel.querySelector(".grid");
    for (const [slot, label] of Object.entries(slots)) {
      if (!record.photoUploadsEnabled && !saved.has(slot)) continue;
      const url = `${base}/${encodeURIComponent(record.id)}/document/${slot}`;
      const box = document.createElement("div");
      const existing = saved.has(slot);
      box.innerHTML = `<h4>${label}</h4><a target="_blank" rel="noopener" href="${url}" ${existing ? "" : "hidden"}>Отвори снимката</a>`;
      if (record.photoUploadsEnabled) {
        box.insertAdjacentHTML("beforeend", `<form><label for="mc-${slot}">${existing ? "Нова снимка" : "Снимка по желание"}</label>
          <input id="mc-${slot}" type="file" accept="image/jpeg,image/png,image/webp" required>
          <button class="btn ghost">${existing ? "Замени снимката" : "Запази снимката"}</button><div role="status"></div></form>`);
        const form = box.querySelector("form");
        form.onsubmit = async e => {
          e.preventDefault();
          const inp = form.querySelector("input"), button = form.querySelector("button"), status = form.querySelector('[role="status"]');
          if (!inp.files[0] || button.disabled) return;
          button.disabled = true;
          try {
            const body = await jpeg(inp.files[0]);
            const response = await fetch(url, { method:"POST", credentials:"same-origin", headers:{ "Content-Type":"image/jpeg", ...(saved.has(slot) ? {"If-Match":saved.get(slot)} : {}) }, body });
            if (response.status === 401) return showLogin("Сесията изтече – влезте отново.");
            if (!response.ok) throw new Error(response.status === 413 ? "Снимката е твърде голяма." : "Снимката не е записана.");
            saved.set(slot, (await response.json()).etag);
            box.querySelector("a").hidden = false;
            form.querySelector("label").textContent = "Нова снимка";
            button.textContent = "Замени снимката";
            form.reset();
            notice(status, "Снимката е записана.", false);
          } catch (err) { notice(status, err.message, true); }
          finally { button.disabled = false; }
        };
      }
      grid.append(box);
    }
    container.append(panel);
  }

  async function edit(v, id, cars) {
    let record = id ? await api(base + "/" + encodeURIComponent(id)) : null;
    const draftId = id || crypto.randomUUID();
    const data = record?.data || {};
    v.innerHTML = `<p><a href="${path}" data-go>Всички ръчни договори</a></p>
      <div class="panel"><h3>${record ? "Редакция на договор" : "Нов договор за наем"}</h3>
      <p>Договорът се пази в админ панела. Отбелязваш предаването на колата отделно в „Автомобили“.</p>
      <div id="mc-actions" class="bar"></div></div>
      ${formContent(data, cars)}<div id="mc-photos"></div>`;
    const form = v.querySelector("#mc-form");
    const countries = form.querySelector("#mc-countries");
    (data.abroad || []).forEach(country => countries.append(abroadRow(country)));
    form.querySelector("#mc-add-country").onclick = () => {
      if (countries.childElementCount >= 20) return;
      countries.append(abroadRow());
      countries.lastElementChild.querySelector("input").focus();
    };
    const actions = v.querySelector("#mc-actions");
    function outputs() {
      actions.innerHTML = record ? `<a class="btn" href="${base}/${encodeURIComponent(record.id)}/file">Изтегли Word</a>
        <a class="btn ghost" href="${base}/${encodeURIComponent(record.id)}/print" target="_blank" rel="noopener">Преглед и печат</a>` : "";
      actions.hidden = !record;
    }
    outputs();
    renderPhotos(v.querySelector("#mc-photos"), record);
    form.oninput = () => {
      // Outputs always refer to the persisted revision.
      if (record) actions.innerHTML = "<span>Запази промените, за да изтеглиш актуалния договор.</span>";
    };
    form.onsubmit = async e => {
      e.preventDefault();
      const button = form.querySelector('[type="submit"]'), status = form.querySelector("#mc-message");
      if (button.disabled) return;
      const next = readForm(form, data);
      if (next.d1 + next.t1 >= next.d2 + next.t2) return notice(status, "Връщането трябва да е след получаването на автомобила.", true);
      button.disabled = true;
      try {
        record = await api(base + "/" + encodeURIComponent(draftId), {
          method:"POST", body:JSON.stringify({revision:record?.revision ?? 0, data:next})
        });
        if (!v.isConnected) return;
        history.replaceState(null, "", path + "/" + encodeURIComponent(record.id));
        v.querySelector(".panel h3").textContent = "Редакция на договор";
        outputs();
        renderPhotos(v.querySelector("#mc-photos"), record);
        notice(status, "Договорът е запазен.", false);
        actions.scrollIntoView({block:"nearest"});
      } catch (err) {
        if (err.message !== "unauthorized") notice(status, errorText(err), true);
      } finally { button.disabled = false; }
    };
  }

  async function manualContracts() {
    const v = $("#view"), segment = location.pathname.split("/")[3];
    v.innerHTML = loading();
    try {
      const {rows, cars} = await api(base);
      if (segment) return await edit(v, segment === "new" ? null : segment, cars);
      const fleet = new Map(cars.map(c => [c.id, [c.brand,c.model,c.reg].filter(Boolean).join(" ")]));
      v.innerHTML = `<p><a class="btn acc" data-go href="${path}/new">Създай договор за наем</a></p>
        <div class="panel scroll">${rows.length ? tbl(["Наемател","Автомобил","Период","Последна промяна",""],
          rows.map(r => [esc(r.name), esc(fleet.get(r.carId) || r.carId), esc(dBG(r.d1) + " – " + dBG(r.d2)),
            esc(fmtDT(r.updatedAt)), `<a data-go href="${path}/${encodeURIComponent(r.id)}">Отвори договора</a>`])) : "<p>Няма запазени ръчни договори.</p>"}</div>`;
    } catch (err) { if (err.message !== "unauthorized") v.innerHTML = failed(err); }
  }

  SECTIONS.splice(SECTIONS.findIndex(([id]) => id === "contracts") + 1, 0, ["manual-contracts", "Ръчни договори"]);
  VIEWS["manual-contracts"] = manualContracts;
})();
