// The CRM shell demo. Everything runs in this page: the pages and workflows come from the kit's industry templates
// (data.js, built by demo/build.mjs), the records are made up from a fixed seed, and every change lives only in memory.
// Nothing is fetched, saved or sent.
(function () {
  "use strict";
  const DATA = window.KIT_DEMO_DATA;
  const app = document.getElementById("app");
  if (!DATA || !app) return;
  for (const ind of DATA.industries) ind.workflows = ind.workflows.map((id) => DATA.workflows[id]).filter(Boolean);

  // ---------- small helpers ----------
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : String(v));
    }
    for (const kid of kids.flat(Infinity)) if (kid !== null && kid !== undefined && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    return el;
  }
  const money = (n) => Number(n).toLocaleString("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 });
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const dayFrom = (offset) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + offset); return d; };
  const monday = (weeks) => { const d = dayFrom(0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + weeks * 7); return d; };
  const niceDate = (s) => { const d = new Date(`${s}T00:00:00`); return isNaN(d) ? s : d.toLocaleDateString("en-AU", { day: "numeric", month: "short" }); };
  function seeded(text) {
    let a = 2166136261;
    for (let i = 0; i < text.length; i++) { a ^= text.charCodeAt(i); a = Math.imul(a, 16777619); }
    return function () { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  const pick = (rnd, list) => list[Math.floor(rnd() * list.length)];
  const between = (rnd, lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

  // ---------- made-up content ----------
  const FIRST = ["Mia", "Liam", "Priya", "Noah", "Aisha", "Jack", "Mei", "Oliver", "Zara", "Lucas", "Grace", "Ethan", "Hannah", "Tom", "Ruby", "Arjun", "Chloe", "Sam", "Leila", "Ben"];
  const LAST = ["Nguyen", "Smith", "Patel", "Brown", "Wilson", "Chen", "Taylor", "Singh", "Kelly", "Martin", "Walsh", "Ali", "Rossi", "Murphy", "Lee", "Harris", "Cooper", "Ward"];
  const SUBJECTS = {
    agencies: ["Spring campaign", "Website refresh", "Brand guidelines", "Monthly SEO report", "Launch video", "Paid social retainer", "Email newsletter", "Product photo shoot"],
    "agriculture-mining": ["North paddock spray", "Harvest contract", "Fencing repairs", "Water licence renewal", "Grain delivery", "Pump service", "Soil test round", "Contractor induction"],
    automotive: ["Logbook service", "Brake pads and rotors", "Trade-in appraisal", "Roadworthy check", "Tyre rotation", "Clutch replacement", "Fleet service", "Warranty claim"],
    construction: ["Kitchen renovation", "Deck and pergola", "Bathroom refit", "Second-storey extension", "Office fit-out", "Roof restoration", "Granny flat", "Retaining wall"],
    "financial-services": ["Home loan refinance", "Annual review", "SMSF setup", "Insurance renewal", "Investment loan", "Tax return", "Business loan", "Super rollover"],
    "fitness-beauty": ["10-class pass", "Membership renewal", "Facial package", "PT intro session", "Colour and cut", "Bridal party booking", "Lash lift", "Corporate wellness"],
    "health-care": ["New patient intake", "Care plan review", "Physio block", "NDIS plan update", "Telehealth follow-up", "Referral letter", "Annual check", "Recall reminder"],
    hospitality: ["Birthday dinner for 12", "Corporate lunch", "Wedding reception", "Weekend booking", "Function room hire", "Supplier order", "Private dining", "End of year party"],
    manufacturing: ["Batch 2041", "Custom bracket order", "Stainless enclosure", "Repeat order", "Prototype run", "Maintenance shutdown", "Supplier quote", "Pallet dispatch"],
    "professional-services": ["Annual accounts", "Lease review", "Business setup", "Will and estate", "BAS quarter", "Contract review", "Due diligence", "Payroll setup"],
    "real-estate": ["3 bed house sale", "Rental appraisal", "Lease renewal", "Apartment listing", "Routine inspection", "Vendor update", "Bond claim", "Townhouse auction"],
    retail: ["Online order", "Wholesale order", "Return request", "Gift card query", "Click and collect", "Stock reorder", "Pop-up stall", "Loyalty sign-up"],
    transport: ["Pallet run to depot", "Interstate load", "Same-day delivery", "Container pickup", "Fleet service", "Linehaul booking", "Refrigerated load", "Return freight"],
  };
  const FALLBACK_SUBJECTS = ["New enquiry", "Follow-up", "Monthly job", "Repeat order", "Site visit", "Annual review", "Small job", "Urgent request"];
  const NOTES = ["Called back, wants a price by Friday.", "Waiting on photos from the customer.", "Draft ready for a check before it goes out.", "Asked for two options, standard and premium.", "Paid the deposit this morning.", "Follow up next Tuesday.", "Happy with the first draft, one change to the dates.", "Needs sign-off from the owner.", "Came in through the website form.", "Repeat customer, keep the same rate.", "Left a voicemail, will try again tomorrow.", "Sent the details by email."];
  const STATUS = ["Open", "In progress", "Waiting on customer", "Done"];
  const CHANNELS = ["Phone", "Email", "Web form", "SMS", "Portal"];
  const TIMES = ["7:30 am", "8:00 am", "9:30 am", "11:00 am", "1:00 pm", "2:30 pm", "4:00 pm"];
  const person = (rnd) => `${pick(rnd, FIRST)} ${pick(rnd, LAST)}`;
  const staffOf = (ind) => { const r = seeded(`staff:${ind}`); return [0, 1, 2, 3].map(() => pick(r, FIRST)); };

  function valueFor(rnd, field, ctx) {
    switch (field.type) {
      case "money": return between(rnd, 25, 1800) * 10;
      case "number": return between(rnd, 1, 40);
      case "textarea": return pick(rnd, NOTES);
      case "date": {
        if (ctx.view === "calendar") return iso(new Date(monday(0).getTime() + between(rnd, 0, 6) * 864e5));
        if (ctx.view === "dashboard") { const start = dayFrom(0); start.setDate(1); start.setMonth(start.getMonth() - 5); return iso(dayFrom(-between(rnd, 0, Math.round((dayFrom(0) - start) / 864e5)))); }
        return iso(dayFrom(between(rnd, -12, 14)));
      }
      default: {
        const k = field.key;
        if (k === "owner") return pick(rnd, ctx.staff);
        if (k === "contact" || k === "from" || k === "customer" || k === "client") return person(rnd);
        if (k === "status") return pick(rnd, STATUS);
        if (k === "channel") return pick(rnd, CHANNELS);
        if (k === "time") return pick(rnd, TIMES);
        if (k === "ref") return `${ctx.prefix}-${between(rnd, 1001, 4999)}`;
        return pick(rnd, ctx.subjects);
      }
    }
  }

  const store = { records: new Map(), approvals: new Map(), seq: 0 };
  function recordsFor(ind, page, tab) {
    const key = `${ind.id}/${page.slug}/${tab.slug}`;
    if (store.records.has(key)) return store.records.get(key);
    const rnd = seeded(key);
    const ctx = { view: tab.view, staff: staffOf(ind.id), subjects: SUBJECTS[ind.id] || FALLBACK_SUBJECTS, prefix: (tab.kind || tab.slug).slice(0, 3).toUpperCase() };
    const stages = tab.stages || null;
    const n = tab.view === "board" ? Math.min(12, Math.max(6, Math.round((stages ? stages.length : 4) * 1.5))) : tab.view === "dashboard" ? 14 : tab.view === "calendar" ? 9 : tab.view === "feed" ? 6 : 7;
    const list = [];
    for (let i = 0; i < n; i++) {
      const data = {};
      for (const f of tab.fields) data[f.key] = valueFor(rnd, f, ctx);
      const subject = pick(rnd, ctx.subjects);
      const title = tab.view === "feed" ? `Question about ${/^[A-Z][a-z]/.test(subject) ? subject.charAt(0).toLowerCase() + subject.slice(1) : subject}` : `${subject}, ${pick(rnd, LAST)}`;
      // Earlier stages hold more cards, like a real pipeline.
      const stage = stages ? stages[Math.min(stages.length - 1, Math.floor(Math.pow(rnd(), 1.6) * stages.length))] : null;
      list.push({ id: `r${++store.seq}`, title, stage, data });
    }
    store.records.set(key, list);
    return list;
  }

  function approvalsFor(ind) {
    if (store.approvals.has(ind.id)) return store.approvals.get(ind.id);
    const rnd = seeded(`approvals:${ind.id}`);
    const list = ind.workflows.filter((w) => w.crons.length).slice(0, 8).map((w, i) => {
      const cron = w.crons.find((c) => /approv|queue|draft/i.test(c.summary)) || w.crons[0];
      const amount = /quot|invoice|bill|pay|price|proposal|chase|deposit|order/i.test(`${w.name} ${cron.summary}`) ? between(rnd, 30, 2400) * 10 : null;
      return { id: `a${i}`, workflow: w.name, department: w.department, run: cron.name, what: cron.summary, who: person(rnd), amount, state: "waiting" };
    });
    store.approvals.set(ind.id, list);
    return list;
  }

  const WF_STATUS = { "record-only": "Recorded", "docs-only": "Designed", "code-built": "Built", "sandbox-tested": "Sandbox tested", "live-tested": "Live tested" };
  const APP_STATUS = { spec: "API spec mapped", "docs-read": "Docs read", "index-only": "Listed" };
  const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  /** "*" daily, "1-5" weekdays, "0" Sundays, "0-4" Sun to Thu, "1,3" Mon and Wed; null for anything else. */
  function dayText(dow) {
    if (dow === "*" || dow === "0-6" || dow === "0-7" || dow === "1-7") return "Daily";
    if (dow === "1-5") return "Weekdays";
    if (/^[0-7]$/.test(dow)) return `${["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays", "Sundays"][Number(dow)]}`;
    const range = /^([0-7])-([0-7])$/.exec(dow);
    if (range && Number(range[1]) > Number(range[2])) return null;
    if (range) return `${DAY[Number(range[1])]} to ${DAY[Number(range[2])]}`;
    if (/^[0-7](,[0-7])+$/.test(dow)) { const d = [...new Set(dow.split(",").map((x) => DAY[Number(x)]))]; if (d.length === 1) return dayText(dow.split(",")[0]); return `${d.slice(0, -1).join(", ")} and ${d.at(-1)}`; }
    return null;
  }
  /** Plain words for the schedules the kit uses; anything else is shown as written. */
  function cronText(s) {
    const p = String(s).trim().split(/\s+/);
    if (p.length !== 5) return String(s);
    const [m, hr, dom, mon, dow] = p;
    const num = (v, lo, hi) => /^\d+$/.test(v) && Number(v) >= lo && Number(v) <= hi;
    const at = () => `${hr.padStart(2, "0")}:${m.padStart(2, "0")} UTC`;
    const every = /^\*\/(\d+)$/.exec(m);
    if (every && num(every[1], 1, 59) && hr === "*" && dom === "*" && mon === "*" && dow === "*") return `Every ${every[1]} minutes`;
    if (num(m, 0, 59) && hr === "*" && dom === "*" && mon === "*" && dow === "*") return "Every hour";
    if (/^\d+(,\d+)+$/.test(m) && m.split(",").every((x) => num(x, 0, 59)) && hr === "*" && dom === "*" && mon === "*" && dow === "*") return `Every hour at ${m.split(",").map((x) => `:${x.padStart(2, "0")}`).join(", ")}`;
    const hEvery = /^\*\/(\d+)$/.exec(hr);
    if (num(m, 0, 59) && hEvery && num(hEvery[1], 1, 23) && dom === "*" && mon === "*" && dow === "*") return `Every ${hEvery[1]} hours`;
    if (!num(m, 0, 59) || !num(hr, 0, 23) || mon !== "*") return String(s);
    if (dom === "*") { const days = dayText(dow); return days ? `${days} at ${at()}` : String(s); }
    if (num(dom, 1, 31) && dow === "*") return `Monthly on day ${dom} at ${at()}`;
    return String(s);
  }

  // ---------- routing ----------
  const byId = new Map(DATA.industries.map((i) => [i.id, i]));
  const deptOf = (id) => DATA.departments.find((d) => d.id === id);
  const fallback = byId.has("construction") ? "construction" : DATA.industries[0].id;
  function parse() {
    const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map((p) => { try { return decodeURIComponent(p); } catch { return ""; } });
    const ind = byId.get(parts[0]) || byId.get(fallback);
    const r = { ind, view: "home" };
    if (parts[1] === "approvals" || parts[1] === "workflows" || parts[1] === "apps") r.view = parts[1];
    else if (parts[1] === "d" && deptOf(parts[2]) && ind.pages.some((p) => p.department === parts[2])) {
      r.view = "dept"; r.dept = parts[2];
      const page = ind.pages.find((p) => p.department === parts[2] && p.slug === parts[3]);
      if (page) { r.view = "page"; r.page = page; r.tab = page.tabs.find((t) => t.slug === parts[4]) || page.tabs[0]; }
    }
    return r;
  }
  const link = (ind, ...rest) => `#/${[ind.id, ...rest].map(encodeURIComponent).join("/")}`;

  // ---------- chrome ----------
  let toastTimer = null;
  function toast(text) {
    document.querySelector(".toast")?.remove();
    const t = h("div", { class: "toast", role: "status", text });
    document.body.append(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.remove(), 3200);
  }

  function sidebar(r) {
    const ind = r.ind;
    const waiting = approvalsFor(ind).filter((a) => a.state === "waiting").length;
    const cur = (on) => (on ? "page" : undefined);
    const depts = DATA.departments.filter((d) => ind.pages.some((p) => p.department === d.id));
    return h("nav", { class: "sidebar", "aria-label": "CRM navigation" },
      h("a", { class: "nav-link", href: link(ind), "aria-current": cur(r.view === "home") }, "Home"),
      h("a", { class: "nav-link", href: link(ind, "approvals"), "aria-current": cur(r.view === "approvals") }, "Approvals", waiting ? h("span", { class: "count", "aria-label": `${waiting} waiting` }, String(waiting)) : null),
      h("div", { class: "nav-group" }, h("div", { class: "nav-label" }, "Departments"),
        depts.map((d) => {
          const open = r.dept === d.id;
          return h("div", {},
            h("a", { class: "nav-link", href: link(ind, "d", d.id), "aria-current": cur(r.view === "dept" && open), "aria-expanded": open ? "true" : "false" }, d.title),
            open ? h("div", { class: "nav-sub" }, ind.pages.filter((p) => p.department === d.id).map((p) => h("a", { class: "nav-link", href: link(ind, "d", d.id, p.slug), "aria-current": cur(r.page === p) }, p.title))) : null);
        })),
      h("div", { class: "nav-group" }, h("div", { class: "nav-label" }, "Admin"),
        h("a", { class: "nav-link", href: link(ind, "workflows"), "aria-current": cur(r.view === "workflows") }, "Workflows"),
        h("a", { class: "nav-link", href: link(ind, "apps"), "aria-current": cur(r.view === "apps") }, "Apps the kit maps")));
  }

  function topbar(r) {
    const select = h("select", { id: "industry", "aria-label": "Industry template", onchange: (e) => { location.hash = `#/${e.target.value}`; } },
      DATA.industries.map((i) => h("option", { value: i.id, selected: i.id === r.ind.id }, i.name)));
    return h("header", { class: "topbar" },
      h("button", { class: "menu-btn", "aria-label": "Open navigation", onclick: () => app.classList.toggle("nav-open") }, "Menu"),
      h("div", { class: "brand" }, h("span", { class: "brand-mark", "aria-hidden": "true" }, "C"), h("span", { class: "brand-text" }, "CRM shell"), h("span", { class: "pill" }, "Demo")),
      h("div", { class: "spacer" }),
      h("label", { class: "industry", for: "industry" }, h("span", { class: "industry-label" }, "Industry template"), select));
  }

  // ---------- record views ----------
  function fieldText(f, v) { return v === undefined || v === "" ? "" : f.type === "money" ? money(v) : f.type === "date" ? niceDate(v) : String(v); }

  function board(ctx) {
    const { tab, records } = ctx;
    const stages = tab.stages || ["Open"];
    const amount = tab.fields.find((f) => f.type === "money");
    return h("div", { class: "lanes" }, stages.map((s) => {
      const inLane = records.filter((x) => (x.stage || stages[0]) === s);
      const total = amount ? inLane.reduce((a, x) => a + (Number(x.data[amount.key]) || 0), 0) : 0;
      return h("section", { class: "lane", "aria-label": s },
        h("div", { class: "lane-head" }, h("b", {}, s), h("span", { class: "muted small" }, `${inLane.length}${amount && total ? ` · ${money(total)}` : ""}`), h("span", { class: "spacer" }),
          h("button", { class: "link-btn muted small", onclick: () => openRecord(ctx, null, s) }, "+ Add")),
        inLane.map((x) => h("div", { class: "item" },
          h("button", { class: "link-btn", onclick: () => openRecord(ctx, x) }, x.title),
          h("div", { class: "meta" }, tab.fields.slice(0, 3).filter((f) => x.data[f.key] !== undefined && f.type !== "textarea").map((f) => h("div", {}, `${f.label}: ${fieldText(f, x.data[f.key])}`))),
          h("select", { "aria-label": `Move ${x.title} to stage`, onchange: (e) => { x.stage = e.target.value; toast(`Moved to ${x.stage}. In this demo only.`); render(); } },
            stages.map((st) => h("option", { value: st, selected: st === (x.stage || stages[0]) }, st))))));
    }));
  }

  function table(ctx, rows) {
    const { tab } = ctx;
    return h("div", { class: "card table-wrap" }, h("table", {},
      h("thead", {}, h("tr", {}, h("th", {}, "Name"), tab.fields.map((f) => h("th", {}, f.label)))),
      h("tbody", {}, (rows || ctx.records).map((x) => h("tr", {},
        h("td", {}, h("button", { class: "link-btn", onclick: () => openRecord(ctx, x) }, x.title)),
        tab.fields.map((f) => h("td", {}, f.type === "textarea" ? h("span", { class: "clamp" }, fieldText(f, x.data[f.key])) : fieldText(f, x.data[f.key]))))))));
  }

  let weekOffset = 0;
  function week(ctx) {
    const dateKey = (ctx.tab.fields.find((f) => f.type === "date") || { key: "date" }).key;
    const start = monday(weekOffset);
    const days = Array.from({ length: 7 }, (_, i) => new Date(start.getTime() + i * 864e5));
    const undated = ctx.records.filter((x) => !x.data[dateKey]);
    return h("div", { class: "stack" },
      h("div", { class: "toolbar" },
        h("button", { class: "btn btn-outline", onclick: () => { weekOffset--; render(); } }, "Previous week"),
        h("button", { class: "btn btn-outline", onclick: () => { weekOffset = 0; render(); } }, "This week"),
        h("button", { class: "btn btn-outline", onclick: () => { weekOffset++; render(); } }, "Next week")),
      h("div", { class: "week" }, days.map((d) => h("section", { class: "lane", "aria-label": d.toDateString() },
        h("div", { class: "muted small" }, d.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" })),
        ctx.records.filter((x) => x.data[dateKey] === iso(d)).map((x) => h("button", { class: "item link-btn", onclick: () => openRecord(ctx, x) }, x.data.time ? h("span", { class: "muted" }, `${x.data.time} `) : null, x.title))))),
      undated.length ? table(ctx, undated) : null);
  }

  function feed(ctx) {
    const sorted = [...ctx.records].sort((a, b) => String(b.data.date || "").localeCompare(String(a.data.date || "")));
    return h("div", { class: "stack" }, sorted.map((x) => h("button", { class: "card feed-item", onclick: () => openRecord(ctx, x) },
      h("div", { class: "feed-top" }, h("b", {}, x.title), x.data.channel ? h("span", { class: "pill" }, String(x.data.channel)) : null, h("span", { class: "spacer" }), x.data.date ? h("span", { class: "muted small" }, niceDate(x.data.date)) : null),
      x.data.from ? h("div", { class: "muted" }, String(x.data.from)) : null,
      x.data.notes ? h("div", { class: "clamp" }, String(x.data.notes)) : null)));
  }

  function numbers(ctx) {
    const amount = ctx.tab.fields.find((f) => f.type === "money");
    const dateKey = (ctx.tab.fields.find((f) => f.type === "date") || {}).key;
    const total = amount ? ctx.records.reduce((a, x) => a + (Number(x.data[amount.key]) || 0), 0) : 0;
    const month = iso(dayFrom(0)).slice(0, 7);
    const months = Array.from({ length: 6 }, (_, i) => { const d = dayFrom(0); d.setDate(1); d.setMonth(d.getMonth() - (5 - i)); return iso(d).slice(0, 7); });
    const per = months.map((m) => ctx.records.filter((x) => dateKey && String(x.data[dateKey]).startsWith(m)).reduce((a, x) => a + (amount ? Number(x.data[amount.key]) || 0 : 1), 0));
    const top = Math.max(1, ...per);
    return h("div", { class: "stack" },
      h("div", { class: "stats" },
        h("div", { class: "stat" }, h("div", { class: "stat-v" }, String(ctx.records.length)), h("div", { class: "stat-l" }, "Entries")),
        h("div", { class: "stat" }, h("div", { class: "stat-v" }, String(ctx.records.filter((x) => dateKey && String(x.data[dateKey]).startsWith(month)).length)), h("div", { class: "stat-l" }, "This month")),
        amount ? h("div", { class: "stat" }, h("div", { class: "stat-v" }, money(total)), h("div", { class: "stat-l" }, "Total")) : null),
      h("div", { class: "card" }, h("h2", {}, amount ? `${amount.label} by month` : "Entries by month"),
        h("div", { class: "bars", role: "img", "aria-label": months.map((m, i) => `${m}: ${amount ? money(per[i]) : per[i]}`).join(", ") }, months.map((m, i) => {
          const bar = h("i", {});
          bar.style.height = `${Math.round((per[i] / top) * 100)}%`;
          return h("div", { class: "bar" }, bar, h("span", { class: "muted small" }, new Date(`${m}-01T00:00:00`).toLocaleDateString("en-AU", { month: "short" })));
        }))),
      h("p", { class: "muted small" }, "In a live CRM this page fills from the business's own accounts once its finance workflows are connected. Here the figures are made up."));
  }

  // ---------- record panel ----------
  function openRecord(ctx, rec, stage) {
    document.querySelector(".scrim")?.remove(); // one record panel at a time
    const { tab, records } = ctx;
    const close = () => { scrim.remove(); document.removeEventListener("keydown", onKey); };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    const title = h("input", { value: rec ? rec.title : "", required: true, maxlength: 200 });
    const stageSel = tab.stages ? h("select", {}, tab.stages.map((s) => h("option", { value: s, selected: s === ((rec && rec.stage) || stage || tab.stages[0]) }, s))) : null;
    const inputs = tab.fields.map((f) => {
      const v = rec ? rec.data[f.key] : "";
      const input = f.type === "textarea" ? h("textarea", { maxlength: 2000 }) : h("input", { type: f.type === "date" ? "date" : f.type === "money" || f.type === "number" ? "number" : "text", maxlength: 300 });
      input.value = v === undefined ? "" : String(v);
      return { f, input };
    });
    const form = h("form", { class: "panel", role: "dialog", "aria-modal": "true", "aria-labelledby": "panel-title", onsubmit: (e) => {
      e.preventDefault();
      const data = {};
      for (const { f, input } of inputs) data[f.key] = f.type === "money" || f.type === "number" ? (input.value === "" ? "" : Number(input.value)) : input.value;
      if (rec) { rec.title = title.value; rec.data = data; if (stageSel) rec.stage = stageSel.value; }
      else records.unshift({ id: `r${++store.seq}`, title: title.value, stage: stageSel ? stageSel.value : null, data });
      close(); toast(rec ? "Saved in this demo only. A refresh puts it back." : "Added in this demo only. A refresh clears it."); render();
    } },
      h("div", { class: "eyebrow" }, tab.title),
      h("h2", { id: "panel-title" }, rec ? rec.title : `New: ${tab.title}`),
      h("label", {}, "Name", title),
      stageSel ? h("label", {}, "Stage", stageSel) : null,
      inputs.map(({ f, input }) => h("label", {}, f.label, input)),
      h("div", { class: "panel-actions" },
        rec ? h("button", { type: "button", class: "btn btn-ghost", onclick: () => { const at = records.indexOf(rec); if (at >= 0) records.splice(at, 1); close(); toast("Deleted in this demo only."); render(); } }, "Delete") : null,
        h("span", { class: "spacer" }),
        h("button", { type: "button", class: "btn btn-outline", onclick: close }, "Close"),
        h("button", { type: "submit", class: "btn" }, "Save")));
    const scrim = h("div", { class: "scrim", onclick: (e) => { if (e.target === scrim) close(); } }, form);
    document.body.append(scrim);
    document.addEventListener("keydown", onKey);
    title.focus();
  }

  // ---------- pages ----------
  function heading(eyebrow, title, lede, eyebrowHref) {
    return h("div", {}, eyebrowHref ? h("a", { class: "eyebrow", href: eyebrowHref }, eyebrow) : h("div", { class: "eyebrow" }, eyebrow), h("h1", { tabindex: "-1" }, title), lede ? h("p", { class: "lede" }, lede) : null);
  }

  function home(r) {
    const ind = r.ind;
    const waiting = approvalsFor(ind).filter((a) => a.state === "waiting").length;
    const depts = DATA.departments.filter((d) => ind.pages.some((p) => p.department === d.id));
    return h("div", { class: "stack" },
      heading("Overview", `${ind.name} business`, "A CRM for one business. Each department has a page for every core job, and the workflows read and draft on their own, then wait for one click before anything reaches a customer, moves money or changes a live record."),
      h("div", { class: "stats" },
        h("a", { class: "stat card-link", href: link(ind, "d", depts[0].id) }, h("div", { class: "stat-v" }, String(ind.pages.length)), h("div", { class: "stat-l" }, "Pages")),
        h("a", { class: "stat card-link", href: link(ind, "workflows") }, h("div", { class: "stat-v" }, String(ind.workflows.length)), h("div", { class: "stat-l" }, "Workflows")),
        h("a", { class: "stat card-link", href: link(ind, "approvals") }, h("div", { class: "stat-v" }, String(waiting)), h("div", { class: "stat-l" }, "Waiting for approval")),
        h("a", { class: "stat card-link", href: link(ind, "apps") }, h("div", { class: "stat-v" }, String(ind.connectors.length)), h("div", { class: "stat-l" }, "Apps mapped"))),
      h("div", { class: "card" }, h("h2", {}, "Try it"), h("p", { class: "muted" }, "Approve a draft on Approvals, move a card along a board, open a record and change it, or switch the industry at the top. Every change stays on this screen.")),
      h("h2", {}, "Departments"),
      h("div", { class: "grid" }, depts.map((d) => {
        const pages = ind.pages.filter((p) => p.department === d.id);
        return h("a", { class: "card card-link", href: link(ind, "d", d.id) }, h("h2", {}, d.title), h("p", { class: "muted small" }, d.line), h("div", { class: "pills" }, pages.map((p) => h("span", { class: "pill" }, p.title))));
      })));
  }

  function department(r) {
    const ind = r.ind, d = deptOf(r.dept);
    const pages = ind.pages.filter((p) => p.department === d.id);
    const flows = ind.workflows.filter((w) => w.department === d.id);
    const waiting = approvalsFor(ind).filter((a) => a.department === d.id && a.state === "waiting");
    return h("div", { class: "stack" },
      heading("Department", d.title, d.line),
      h("div", { class: "grid" }, pages.map((p) => h("a", { class: "card card-link", href: link(ind, "d", d.id, p.slug) }, h("h2", {}, p.title),
        h("div", { class: "pills" }, p.tabs.map((t) => h("span", { class: "pill" }, `${t.title} · ${t.view === "dashboard" ? "numbers" : t.view === "calendar" ? "week" : t.view}`)))))),
      flows.length ? h("div", { class: "card" }, h("h2", {}, "Workflows in this department"), h("ul", { class: "wf-crons" }, flows.map((w) => h("li", {}, h("span", {}, w.name), h("span", { class: "muted" }, w.summary))))) : null,
      waiting.length ? h("a", { class: "card card-link", href: link(ind, "approvals") }, h("h2", {}, `${waiting.length} waiting for approval`), h("p", { class: "muted small" }, "Open Approvals to approve or reject them.")) : null);
  }

  function page(r) {
    const ind = r.ind, d = deptOf(r.dept), p = r.page, tab = r.tab;
    const ctx = { tab, records: recordsFor(ind, p, tab) };
    const view = tab.view === "board" ? board(ctx) : tab.view === "calendar" ? week(ctx) : tab.view === "feed" ? feed(ctx) : tab.view === "dashboard" ? numbers(ctx) : table(ctx);
    return h("div", { class: "stack" },
      heading(d.title, p.title, null, link(ind, "d", d.id)),
      p.tabs.length > 1 ? h("nav", { class: "tabs", "aria-label": `${p.title} tabs` }, p.tabs.map((t) => h("a", { class: "tab", href: link(ind, "d", d.id, p.slug, t.slug), "aria-current": t === tab ? "page" : undefined }, t.title))) : null,
      h("div", { class: "toolbar" }, h("span", { class: "muted" }, `${ctx.records.length} ${ctx.records.length === 1 ? "record" : "records"} · sample data`), h("span", { class: "spacer" }),
        tab.view !== "dashboard" ? h("button", { class: "btn", onclick: () => openRecord(ctx, null) }, "Add") : null),
      view);
  }

  function approvals(r) {
    const list = approvalsFor(r.ind);
    const decide = (a, state) => { a.state = state; toast(state === "approved" ? "Approved in the demo. Nothing was sent: in a live CRM this click lets it go out." : "Rejected. The draft is dropped and nothing goes out."); render(); };
    return h("div", { class: "stack" },
      heading("Approvals", "Waiting for one click", "Workflows read the business's apps and draft the work. Anything that would reach a customer, move money or change a live record waits here until a person approves it."),
      list.map((a) => h("div", { class: `card approval${a.state === "waiting" ? "" : " done"}` },
        h("div", {}, h("div", { class: "eyebrow" }, `${(deptOf(a.department) || { title: a.department }).title} · ${a.workflow}`),
          h("h2", {}, `Draft for ${a.who}${a.amount ? `, ${money(a.amount)}` : ""}`),
          h("p", { class: "muted small" }, `Drafted by the ${a.run} run: ${a.what}`)),
        a.state === "waiting"
          ? h("div", { class: "actions" }, h("button", { class: "btn", onclick: () => decide(a, "approved") }, "Approve"), h("button", { class: "btn btn-outline", onclick: () => decide(a, "rejected") }, "Reject"))
          : h("span", { class: a.state === "approved" ? "pill pill-good" : "pill" }, a.state === "approved" ? "Approved" : "Rejected"))),
      list.some((a) => a.state !== "waiting") ? h("button", { class: "btn btn-outline", onclick: () => { store.approvals.delete(r.ind.id); render(); } }, "Reset the queue") : null);
  }

  function workflows(r) {
    const ind = r.ind;
    const depts = DATA.departments.filter((d) => ind.workflows.some((w) => w.department === d.id));
    return h("div", { class: "stack" },
      heading("Admin", "Workflows", `The ${ind.workflows.length} workflows the ${ind.name} template switches on. Each runs on a schedule, reads the business's apps and drafts the work for approval.`),
      depts.map((d) => h("section", { class: "stack" }, h("h2", {}, d.title),
        ind.workflows.filter((w) => w.department === d.id).map((w) => h("div", { class: "card wf" },
          h("div", { class: "feed-top" }, h("b", {}, w.name), h("span", { class: "spacer" }), h("span", { class: "pill" }, (Object.hasOwn(WF_STATUS, w.status) ? WF_STATUS[w.status] : w.status)), w.shared ? h("span", { class: "pill" }, "Every industry") : null),
          h("p", { class: "muted" }, w.summary),
          w.crons.length ? h("ul", { class: "wf-crons" }, w.crons.map((c) => h("li", {}, h("span", {}, `${c.name}: ${cronText(c.schedule)}`), h("span", { class: "muted" }, c.summary)))) : null,
          w.apps.length ? h("div", { class: "pills" }, h("span", { class: "muted small" }, "Drafts in"), w.apps.map((a) => h("span", { class: "pill" }, a))) : null)))));
  }

  function apps(r) {
    const ind = r.ind;
    return h("div", { class: "stack" },
      heading("Admin", "Apps the kit maps", `The apps a ${ind.name.toLowerCase()} business tends to run, and how far each is mapped in the kit. In a live CRM each one connects with the business's own keys.`),
      h("div", { class: "apps" }, ind.connectors.map((c) => h("div", { class: "app-row" }, h("span", {}, c.tool), h("span", { class: c.status === "spec" ? "pill pill-good" : "pill" }, (Object.hasOwn(APP_STATUS, c.status) ? APP_STATUS[c.status] : c.status))))),
      ind.missing.length ? h("div", { class: "card" }, h("h2", {}, "Not mapped yet"), h("div", { class: "pills" }, ind.missing.map((m) => h("span", { class: "pill" }, m)))) : null);
  }

  // ---------- render ----------
  let lastKey = "";
  function render() {
    const r = parse();
    const key = `${r.ind.id}|${r.view}|${r.dept || ""}|${r.page ? r.page.slug : ""}|${r.tab ? r.tab.slug : ""}`;
    const moved = key !== lastKey;
    if (moved && r.view !== "page") weekOffset = 0;
    const content = h("main", { class: "content", id: "content" },
      r.view === "approvals" ? approvals(r) : r.view === "workflows" ? workflows(r) : r.view === "apps" ? apps(r) : r.view === "dept" ? department(r) : r.view === "page" ? page(r) : home(r));
    const scroll = !moved && document.getElementById("content") ? document.getElementById("content").scrollTop : 0;
    app.classList.remove("nav-open");
    app.replaceChildren(topbar(r), h("div", { class: "notice", role: "note" }, "Sample data only. Every record is made up, and anything you change stays on this screen."), sidebar(r), content);
    content.scrollTop = scroll;
    document.title = `${r.ind.name} · CRM shell demo`;
    if (moved && lastKey) content.querySelector("h1")?.focus({ preventScroll: true });
    lastKey = key;
  }
  window.addEventListener("hashchange", render);
  render();
})();
