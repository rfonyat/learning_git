import Anthropic from "https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.137.0/+esm";

// ---------- storage ----------
const KEYS = { settings: "mt.settings", goals: "mt.goals", entries: "mt.entries", chat: "mt.chat" };
const DEFAULT_GOALS = { calories: 2000, protein: 150, carbs: 200, fat: 65, fiber: 30 };
const DEFAULT_SETTINGS = { apiKey: "", model: "claude-opus-5-5", speak: false };
const MACROS = ["protein", "carbs", "fat", "fiber"];
const MEALS = ["breakfast", "lunch", "dinner", "snack"];

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (err) {
    console.warn("save failed", key, err);
    return false;
  }
}

const state = {
  settings: { ...DEFAULT_SETTINGS, ...load(KEYS.settings, {}) },
  goals: { ...DEFAULT_GOALS, ...load(KEYS.goals, {}) },
  entries: load(KEYS.entries, []),
  // One conversation per calendar day. `api` is the exact message list sent to
  // Claude (append-only); `display` is what the chat screen shows.
  chat: load(KEYS.chat, null),
  viewDate: todayISO(),
  pendingImage: null,
  busy: false,
};

// ---------- dates & numbers ----------
function todayISO(d = new Date()) {
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d - off).toISOString().slice(0, 10);
}
function shiftDate(iso, days) {
  const d = new Date(iso + "T12:00:00");
  d.setDate(d.getDate() + days);
  return todayISO(d);
}
function prettyDate(iso) {
  const today = todayISO();
  if (iso === today) return "Today";
  if (iso === shiftDate(today, -1)) return "Yesterday";
  return new Date(iso + "T12:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}
const round = (n) => Math.round(Number(n) || 0);
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 10) / 10 : 0;
};
const uid = () => Math.random().toString(36).slice(2, 8);

function totalsFor(date) {
  const t = { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 };
  for (const e of state.entries) {
    if (e.date !== date) continue;
    t.calories += e.calories;
    for (const m of MACROS) t[m] += e[m];
  }
  for (const k in t) t[k] = Math.round(t[k] * 10) / 10;
  return t;
}
function defaultMeal() {
  const h = new Date().getHours();
  if (h < 11) return "breakfast";
  if (h < 15) return "lunch";
  if (h >= 17 && h < 22) return "dinner";
  return "snack";
}

// ---------- entries ----------
function addEntry(item, date) {
  const entry = {
    id: uid(),
    date,
    time: new Date().toISOString(),
    meal: MEALS.includes(item.meal) ? item.meal : defaultMeal(),
    name: String(item.name || "Food").slice(0, 80),
    quantity: String(item.quantity || "").slice(0, 60),
    calories: num(item.calories),
    protein: num(item.protein_g ?? item.protein),
    carbs: num(item.carbs_g ?? item.carbs),
    fat: num(item.fat_g ?? item.fat),
    fiber: num(item.fiber_g ?? item.fiber),
  };
  state.entries.push(entry);
  return entry;
}
function persistEntries() {
  save(KEYS.entries, state.entries);
  renderToday();
  if (currentView === "history") renderHistory();
}

// ---------- Claude tools ----------
const ITEM_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", description: "Short food name, e.g. 'Scrambled eggs'" },
    quantity: { type: "string", description: "Portion, e.g. '2 large', '1 cup', '150 g'" },
    meal: { type: "string", enum: MEALS },
    calories: { type: "number" },
    protein_g: { type: "number" },
    carbs_g: { type: "number" },
    fat_g: { type: "number" },
    fiber_g: { type: "number" },
  },
  required: ["name", "quantity", "meal", "calories", "protein_g", "carbs_g", "fat_g", "fiber_g"],
};

const TOOLS = [
  {
    name: "log_food",
    description:
      "Add one or more food items to the user's food log. Log each distinct food as its own item. Returns the new entry ids and the day's updated totals versus goals.",
    input_schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "YYYY-MM-DD. Omit for today." },
        items: { type: "array", items: ITEM_SCHEMA, minItems: 1 },
      },
      required: ["items"],
    },
  },
  {
    name: "get_log",
    description: "Get the entries (with ids) and totals for a day, plus the user's goals.",
    input_schema: {
      type: "object",
      properties: { date: { type: "string", description: "YYYY-MM-DD. Omit for today." } },
    },
  },
  {
    name: "update_entry",
    description: "Change fields of an existing log entry (e.g. corrected portion or macros). Only pass fields that change.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string" }, ...ITEM_SCHEMA.properties },
      required: ["id"],
    },
  },
  {
    name: "delete_entries",
    description: "Remove entries from the log by id.",
    input_schema: {
      type: "object",
      properties: { ids: { type: "array", items: { type: "string" } } },
      required: ["ids"],
    },
  },
  {
    name: "set_goals",
    description: "Update the user's daily targets. Only pass the targets that change.",
    input_schema: {
      type: "object",
      properties: {
        calories: { type: "number" },
        protein_g: { type: "number" },
        carbs_g: { type: "number" },
        fat_g: { type: "number" },
        fiber_g: { type: "number" },
      },
    },
  },
];

const SYSTEM_PROMPT = `You are MacroTalk, a friendly nutrition-logging assistant inside a phone app, similar to Cal AI. The user tells you (by text, voice transcription, or photo) what they ate, and you log it with the tools.

How to work:
- Estimate calories, protein, carbs, fat and fiber for each food using standard nutrition data (USDA-style values, restaurant and brand nutrition info when a brand or chain is named). Use realistic typical portions when the user doesn't give amounts, and say what you assumed so they can correct it.
- For photos, identify each food, estimate portion sizes from visual cues (plate size, utensils, packaging), and log each item separately. If the photo shows a nutrition label, use the label values times the servings eaten.
- Log right away rather than asking questions. Ask a short clarifying question only when the answer would change the estimate a lot (e.g. "a smoothie" with unknown ingredients) — and even then you may log your best guess and offer to adjust.
- Pick the meal (breakfast/lunch/dinner/snack) from what the user says, otherwise from the local time in their message.
- To correct or remove something, call get_log first if you don't already know the entry id, then update_entry or delete_entries.
- If the user asks you to set or calculate goals, use their stats (Mifflin-St Jeor BMR × activity factor, adjusted for their goal; protein around 0.7–1 g per lb of goal body weight for active people) and call set_goals. Briefly explain the numbers.
- You can also answer nutrition questions and suggest foods that fit their remaining macros.

Replies are read on a small phone screen and sometimes read aloud: keep them short (1–4 sentences), plain text, no markdown tables or headers. After logging, give a one-line summary of what was logged with calories and protein, then what's left for the day (calories and protein). Each user message starts with a bracketed line giving their local date/time and current totals — use it but don't repeat it back.`;

function execTool(name, input) {
  const today = todayISO();
  switch (name) {
    case "log_food": {
      const date = /^\d{4}-\d{2}-\d{2}$/.test(input.date || "") ? input.date : today;
      const items = Array.isArray(input.items) ? input.items : [];
      if (!items.length) throw new Error("items must be a non-empty array");
      const added = items.map((it) => addEntry(it, date));
      persistEntries();
      return {
        logged: added.map((e) => ({ id: e.id, name: e.name, calories: e.calories, protein_g: e.protein })),
        date,
        day_totals: totalsFor(date),
        goals: state.goals,
        _ui: added.map((e) => `Logged ${e.name}${e.quantity ? ` (${e.quantity})` : ""} · ${round(e.calories)} kcal · ${round(e.protein)}g P`),
      };
    }
    case "get_log": {
      const date = /^\d{4}-\d{2}-\d{2}$/.test(input.date || "") ? input.date : today;
      const entries = state.entries
        .filter((e) => e.date === date)
        .map(({ id, meal, name, quantity, calories, protein, carbs, fat, fiber }) => ({
          id, meal, name, quantity, calories, protein_g: protein, carbs_g: carbs, fat_g: fat, fiber_g: fiber,
        }));
      return { date, entries, totals: totalsFor(date), goals: state.goals };
    }
    case "update_entry": {
      const e = state.entries.find((x) => x.id === input.id);
      if (!e) throw new Error(`No entry with id ${input.id}. Call get_log to see ids.`);
      if (input.name) e.name = String(input.name).slice(0, 80);
      if (input.quantity) e.quantity = String(input.quantity).slice(0, 60);
      if (MEALS.includes(input.meal)) e.meal = input.meal;
      if (input.calories != null) e.calories = num(input.calories);
      for (const m of MACROS) if (input[`${m}_g`] != null) e[m] = num(input[`${m}_g`]);
      persistEntries();
      return { updated: e.id, day_totals: totalsFor(e.date), _ui: [`Updated ${e.name} · ${round(e.calories)} kcal`] };
    }
    case "delete_entries": {
      const ids = new Set(input.ids || []);
      const removed = state.entries.filter((e) => ids.has(e.id));
      state.entries = state.entries.filter((e) => !ids.has(e.id));
      persistEntries();
      return {
        deleted: removed.map((e) => e.id),
        not_found: [...ids].filter((id) => !removed.some((e) => e.id === id)),
        day_totals: totalsFor(today),
        _ui: removed.map((e) => `Removed ${e.name}`),
      };
    }
    case "set_goals": {
      const map = { calories: "calories", protein_g: "protein", carbs_g: "carbs", fat_g: "fat", fiber_g: "fiber" };
      for (const [k, g] of Object.entries(map)) if (input[k] != null && Number(input[k]) > 0) state.goals[g] = round(input[k]);
      save(KEYS.goals, state.goals);
      fillSettings();
      renderToday();
      const g = state.goals;
      return { goals: g, _ui: [`Goals set · ${g.calories} kcal · P ${g.protein}g · C ${g.carbs}g · F ${g.fat}g`] };
    }
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}

// ---------- chat state ----------
function freshChat() {
  return { date: todayISO(), api: [], display: [] };
}
function ensureChat() {
  if (!state.chat || state.chat.date !== todayISO()) {
    state.chat = freshChat();
    persistChat();
  }
  return state.chat;
}
function persistChat() {
  if (save(KEYS.chat, state.chat)) return;
  // Storage full (usually photos). Drop photo thumbnails from the on-screen
  // history first; if still too big, start a fresh conversation.
  for (const d of state.chat.display) delete d.image;
  if (!save(KEYS.chat, state.chat)) {
    state.chat = freshChat();
    save(KEYS.chat, state.chat);
    toast("Chat storage was full, so a new conversation was started.");
  }
}

function contextLine() {
  const now = new Date();
  const t = totalsFor(todayISO());
  const g = state.goals;
  return `[Local time: ${now.toLocaleString(undefined, { weekday: "long", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} (date ${todayISO()}). Today so far: ${round(t.calories)}/${g.calories} kcal, protein ${round(t.protein)}/${g.protein}g, carbs ${round(t.carbs)}/${g.carbs}g, fat ${round(t.fat)}/${g.fat}g, fiber ${round(t.fiber)}/${g.fiber}g.]`;
}

// ---------- Claude call loop ----------
function client() {
  return new Anthropic({ apiKey: state.settings.apiKey, dangerouslyAllowBrowser: true, maxRetries: 2 });
}

function requestParams(messages) {
  const model = state.settings.model;
  const params = {
    model,
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    tools: TOOLS,
    messages,
    cache_control: { type: "ephemeral" },
    output_config: { effort: "medium" },
  };
  // Server-side refusal fallback (not offered for Haiku).
  if (model !== "claude-haiku-5-5") {
    params.betas = ["server-side-fallback-2026-07-01"];
    params.fallbacks = "default";
  }
  return params;
}

async function sendToClaude(text, image) {
  const chat = ensureChat();
  const content = [];
  if (image) content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: image.split(",")[1] } });
  content.push({ type: "text", text: `${contextLine()}\n${text || "(photo of what I ate)"}` });

  // If the previous turn failed after tool results were sent, the history ends
  // with a user message; add to it rather than sending two user turns in a row.
  const last = chat.api[chat.api.length - 1];
  if (last && last.role === "user") last.content = [...last.content, ...content];
  else chat.api.push({ role: "user", content });

  chat.display.push({ role: "user", text, image });
  persistChat();
  renderMessages();
  setBusy(true);

  const api = client();
  const spoken = [];
  try {
    for (let step = 0; step < 10; step++) {
      const resp = await api.beta.messages.create(requestParams(chat.api));
      chat.api.push({ role: "assistant", content: resp.content });

      const says = resp.content.filter((b) => b.type === "text" && b.text.trim()).map((b) => b.text.trim());
      for (const s of says) {
        chat.display.push({ role: "assistant", text: s });
        spoken.push(s);
      }

      if (resp.stop_reason === "refusal") {
        chat.display.push({ role: "error", text: "Claude declined that request. Try rephrasing." });
        break;
      }
      if (resp.stop_reason === "max_tokens") {
        chat.display.push({ role: "error", text: "Reply was cut off." });
        break;
      }
      if (resp.stop_reason !== "tool_use") break;

      const results = [];
      for (const block of resp.content) {
        if (block.type !== "tool_use") continue;
        try {
          const { _ui, ...out } = execTool(block.name, block.input || {});
          for (const line of _ui || []) chat.display.push({ role: "chip", text: line });
          results.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(out) });
        } catch (err) {
          results.push({ type: "tool_result", tool_use_id: block.id, content: String(err.message || err), is_error: true });
        }
      }
      chat.api.push({ role: "user", content: results });
      persistChat();
      renderMessages();
    }
  } catch (err) {
    chat.display.push({ role: "error", text: friendlyError(err) });
    // Drop the unanswered user turn so it can be retried cleanly.
    const tail = chat.api[chat.api.length - 1];
    if (tail && tail.role === "user" && tail.content.some((b) => b.type === "text")) {
      if (tail.content.every((b) => b.type !== "tool_result")) chat.api.pop();
    }
  } finally {
    persistChat();
    setBusy(false);
    renderMessages();
    if (state.settings.speak && spoken.length) speak(spoken.join(" "));
  }
}

function friendlyError(err) {
  const status = err?.status;
  if (status === 401) return "Your API key was rejected. Check it in Settings.";
  if (status === 429) return "Rate limited by the API — wait a moment and try again.";
  if (status === 529 || status >= 500) return "Claude is overloaded right now. Try again in a bit.";
  if (status === 400) return `Request error: ${err?.error?.error?.message || err.message}`;
  if (!navigator.onLine) return "You're offline.";
  return `Something went wrong: ${err?.message || err}`;
}

// ---------- rendering ----------
const $ = (sel) => document.querySelector(sel);
let currentView = "today";

function showView(name) {
  currentView = name;
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
  document.querySelectorAll(".tabbar button").forEach((b) => b.classList.toggle("on", b.dataset.view === name));
  if (name === "chat") {
    ensureChat();
    renderMessages();
    if (!state.settings.apiKey) toast("Add your Anthropic API key in Settings first.");
  }
  if (name === "history") renderHistory();
  if (name === "today") renderToday();
}

function renderToday() {
  const date = state.viewDate;
  $("#day-label").textContent = prettyDate(date);
  $("#next-day").style.visibility = date >= todayISO() ? "hidden" : "visible";

  const t = totalsFor(date);
  const g = state.goals;
  const left = g.calories - t.calories;
  $("#cal-left").textContent = Math.abs(round(left)).toLocaleString();
  $("#cal-left-label").textContent = left >= 0 ? "kcal left" : "kcal over";
  $("#cal-eaten").textContent = round(t.calories).toLocaleString();
  $("#cal-goal").textContent = g.calories.toLocaleString();
  const ring = $("#cal-ring");
  const C = 2 * Math.PI * 52;
  const pct = g.calories ? Math.min(t.calories / g.calories, 1) : 0;
  ring.style.strokeDasharray = C;
  ring.style.strokeDashoffset = C * (1 - pct);
  ring.classList.toggle("over", left < 0);

  for (const m of MACROS) {
    const card = document.querySelector(`.macro[data-macro=${m}]`);
    card.querySelector(".v").textContent = round(t[m]);
    card.querySelector(".g").textContent = `/${g[m]}g`;
    card.querySelector(".bar i").style.width = `${g[m] ? Math.min((t[m] / g[m]) * 100, 100) : 0}%`;
  }

  const list = $("#entries");
  list.innerHTML = "";
  const todays = state.entries.filter((e) => e.date === date);
  $("#entries-empty").hidden = todays.length > 0;
  for (const meal of MEALS) {
    const items = todays.filter((e) => e.meal === meal);
    if (!items.length) continue;
    const group = document.createElement("div");
    group.className = "meal-group";
    const kcal = items.reduce((s, e) => s + e.calories, 0);
    group.innerHTML = `<h3><span>${meal}</span><span>${round(kcal)} kcal</span></h3>`;
    for (const e of items) {
      const btn = document.createElement("button");
      btn.className = "entry";
      btn.innerHTML = `
        <div class="main">
          <div class="name"></div>
          <div class="sub"><span class="dot" style="background:var(--protein)"></span>${round(e.protein)}g
            <span class="dot" style="background:var(--carbs)"></span>${round(e.carbs)}g
            <span class="dot" style="background:var(--fat)"></span>${round(e.fat)}g
            <span class="qty"></span></div>
        </div>
        <div class="kcal">${round(e.calories)}</div>`;
      btn.querySelector(".name").textContent = e.name;
      btn.querySelector(".qty").textContent = e.quantity ? ` · ${e.quantity}` : "";
      btn.addEventListener("click", () => openEdit(e.id));
      group.appendChild(btn);
    }
    list.appendChild(group);
  }
}

function renderMarkdownLite(text) {
  const esc = text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  return esc
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/(^|\n)[-•] (.+)/g, "$1• $2");
}

function renderMessages() {
  const box = $("#messages");
  const chat = ensureChat();
  box.innerHTML = "";
  if (!chat.display.length) {
    box.innerHTML = `<div class="welcome">Tell me what you ate, like<br><b>“Chipotle chicken bowl with rice, beans and guac”</b><br>or tap 📷 to snap a photo, or 🎤 to talk.<br><br>You can also say “I'm 28, female, 140 lb, want to lose 10 lb — set my goals.”</div>`;
  }
  for (const m of chat.display) {
    const el = document.createElement("div");
    el.className = m.role === "chip" ? "chip" : `msg ${m.role}`;
    if (m.image) {
      const img = document.createElement("img");
      img.src = m.image;
      el.appendChild(img);
    }
    if (m.text) {
      const span = document.createElement("span");
      if (m.role === "assistant") span.innerHTML = renderMarkdownLite(m.text);
      else span.textContent = m.text;
      el.appendChild(span);
    }
    box.appendChild(el);
  }
  if (state.busy) {
    const t = document.createElement("div");
    t.className = "typing";
    t.innerHTML = "<i></i><i></i><i></i>";
    box.appendChild(t);
  }
  box.scrollTop = box.scrollHeight;
}

function renderHistory() {
  const days = Number(document.querySelector("#range-seg .on").dataset.days);
  const today = todayISO();
  const dates = Array.from({ length: days }, (_, i) => shiftDate(today, i - days + 1));
  const totals = dates.map((d) => ({ d, ...totalsFor(d) }));
  const g = state.goals;
  const max = Math.max(g.calories * 1.2, ...totals.map((t) => t.calories)) || 1;

  const chart = $("#chart");
  chart.innerHTML = "";
  const line = document.createElement("div");
  line.className = "goal-line";
  line.style.bottom = `calc(${(g.calories / max) * 100}% * (180 - 18) / 180 + 18px)`;
  chart.appendChild(line);
  totals.forEach((t, i) => {
    const col = document.createElement("div");
    col.className = "col";
    const h = (t.calories / max) * 100;
    const showLabel = days <= 7 || i % 5 === (days - 1) % 5;
    const label = days <= 7
      ? new Date(t.d + "T12:00:00").toLocaleDateString(undefined, { weekday: "short" }).slice(0, 2)
      : String(Number(t.d.slice(8)));
    col.innerHTML = `<div class="b ${t.calories > g.calories ? "over" : ""} ${t.calories ? "" : "zero"}" style="height:calc(${h}% * (180 - 18) / 180)"></div><div class="lbl">${showLabel ? label : "&nbsp;"}</div>`;
    col.title = `${t.d}: ${round(t.calories)} kcal`;
    col.addEventListener("click", () => {
      state.viewDate = t.d;
      showView("today");
    });
    chart.appendChild(col);
  });

  const logged = totals.filter((t) => t.calories > 0);
  const avg = (k) => (logged.length ? round(logged.reduce((s, t) => s + t[k], 0) / logged.length) : 0);
  $("#averages").innerHTML = `
    <h2>Daily average (${logged.length} logged day${logged.length === 1 ? "" : "s"})</h2>
    <div class="avg-row"><span>Calories</span><b>${avg("calories")} / ${g.calories}</b></div>
    <div class="avg-row"><span>Protein</span><b>${avg("protein")} / ${g.protein} g</b></div>
    <div class="avg-row"><span>Carbs</span><b>${avg("carbs")} / ${g.carbs} g</b></div>
    <div class="avg-row"><span>Fat</span><b>${avg("fat")} / ${g.fat} g</b></div>
    <div class="avg-row"><span>Fiber</span><b>${avg("fiber")} / ${g.fiber} g</b></div>`;
}

function setBusy(b) {
  state.busy = b;
  $("#send-btn").disabled = b;
}

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3000);
}

// ---------- edit dialog ----------
let editingId = null;
function openEdit(id) {
  const e = state.entries.find((x) => x.id === id);
  if (!e) return;
  editingId = id;
  $("#e-name").value = e.name;
  $("#e-quantity").value = e.quantity;
  $("#e-meal").value = e.meal;
  $("#e-calories").value = e.calories;
  for (const m of MACROS) $(`#e-${m}`).value = e[m];
  $("#edit-dialog").showModal();
}
$("#edit-dialog").addEventListener("close", () => {
  const action = $("#edit-dialog").returnValue;
  const e = state.entries.find((x) => x.id === editingId);
  if (!e) return;
  if (action === "delete") {
    state.entries = state.entries.filter((x) => x.id !== editingId);
  } else if (action === "save") {
    e.name = $("#e-name").value.trim() || e.name;
    e.quantity = $("#e-quantity").value.trim();
    e.meal = $("#e-meal").value;
    e.calories = num($("#e-calories").value);
    for (const m of MACROS) e[m] = num($(`#e-${m}`).value);
  } else return;
  persistEntries();
});

// ---------- photo ----------
function resizeImage(file, maxSide = 1024) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/jpeg", 0.8));
    };
    img.onerror = () => reject(new Error("Couldn't read that image."));
    img.src = url;
  });
}
$("#photo-input").addEventListener("change", async (ev) => {
  const file = ev.target.files[0];
  ev.target.value = "";
  if (!file) return;
  try {
    state.pendingImage = await resizeImage(file);
    $("#pending-image img").src = state.pendingImage;
    $("#pending-image").hidden = false;
    $("#input").focus();
  } catch (err) {
    toast(err.message);
  }
});
$("#remove-image").addEventListener("click", () => {
  state.pendingImage = null;
  $("#pending-image").hidden = true;
});

// ---------- voice ----------
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recog = null;
$("#mic-btn").addEventListener("click", () => {
  if (!Recognition) {
    toast("Voice input isn't supported here — use the mic on your keyboard.");
    $("#input").focus();
    return;
  }
  if (recog) {
    recog.stop();
    return;
  }
  recog = new Recognition();
  recog.lang = navigator.language || "en-US";
  recog.interimResults = true;
  recog.continuous = false;
  const base = $("#input").value ? $("#input").value.trim() + " " : "";
  recog.onresult = (e) => {
    const said = Array.from(e.results).map((r) => r[0].transcript).join("");
    $("#input").value = base + said;
    autosize();
  };
  recog.onerror = (e) => {
    if (e.error === "not-allowed") toast("Microphone permission was denied.");
  };
  recog.onend = () => {
    $("#mic-btn").classList.remove("listening");
    recog = null;
    if ($("#input").value.trim()) submit();
  };
  $("#mic-btn").classList.add("listening");
  recog.start();
});

function speak(text) {
  if (!("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text.replace(/\*\*/g, ""));
  u.lang = navigator.language || "en-US";
  speechSynthesis.speak(u);
}

// ---------- composer ----------
function autosize() {
  const ta = $("#input");
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight, 140) + "px";
}
function submit() {
  if (state.busy) return;
  const text = $("#input").value.trim();
  const image = state.pendingImage;
  if (!text && !image) return;
  if (!state.settings.apiKey) {
    toast("Add your Anthropic API key in Settings first.");
    showView("settings");
    return;
  }
  $("#input").value = "";
  autosize();
  state.pendingImage = null;
  $("#pending-image").hidden = true;
  sendToClaude(text, image);
}
$("#composer").addEventListener("submit", (e) => {
  e.preventDefault();
  submit();
});
$("#input").addEventListener("input", autosize);
$("#input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !matchMedia("(pointer: coarse)").matches) {
    e.preventDefault();
    submit();
  }
});
$("#new-chat").addEventListener("click", () => {
  if (state.busy) return;
  state.chat = freshChat();
  persistChat();
  renderMessages();
});

// ---------- settings ----------
function fillSettings() {
  $("#api-key").value = state.settings.apiKey;
  $("#model").value = state.settings.model;
  $("#speak").checked = state.settings.speak;
  for (const k of Object.keys(DEFAULT_GOALS)) $(`#goal-${k}`).value = state.goals[k];
}
$("#settings-form").addEventListener("submit", (e) => {
  e.preventDefault();
  state.settings.apiKey = $("#api-key").value.trim();
  state.settings.model = $("#model").value;
  state.settings.speak = $("#speak").checked;
  save(KEYS.settings, state.settings);
  for (const k of Object.keys(DEFAULT_GOALS)) {
    const v = round($(`#goal-${k}`).value);
    if (v > 0) state.goals[k] = v;
  }
  save(KEYS.goals, state.goals);
  renderToday();
  toast("Saved");
});
$("#export-btn").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify({ goals: state.goals, entries: state.entries }, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `macrotalk-${todayISO()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});
$("#import-input").addEventListener("change", async (ev) => {
  const file = ev.target.files[0];
  ev.target.value = "";
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.entries)) throw new Error("No entries in file");
    const ids = new Set(state.entries.map((e) => e.id));
    const fresh = data.entries.filter((e) => e && e.id && e.date && !ids.has(e.id));
    state.entries.push(...fresh);
    if (data.goals) state.goals = { ...state.goals, ...data.goals };
    save(KEYS.goals, state.goals);
    persistEntries();
    fillSettings();
    toast(`Imported ${fresh.length} entries`);
  } catch (err) {
    toast(`Import failed: ${err.message}`);
  }
});
$("#reset-btn").addEventListener("click", () => {
  if (!confirm("Delete all logged food, goals and chat history on this device? (Your API key is kept.)")) return;
  state.entries = [];
  state.goals = { ...DEFAULT_GOALS };
  state.chat = freshChat();
  save(KEYS.entries, state.entries);
  save(KEYS.goals, state.goals);
  persistChat();
  fillSettings();
  renderToday();
  toast("All data deleted");
});

// ---------- nav ----------
document.querySelectorAll(".tabbar button").forEach((b) => b.addEventListener("click", () => {
  if (b.dataset.view === "today") state.viewDate = todayISO();
  showView(b.dataset.view);
}));
$("#prev-day").addEventListener("click", () => {
  state.viewDate = shiftDate(state.viewDate, -1);
  renderToday();
});
$("#next-day").addEventListener("click", () => {
  if (state.viewDate < todayISO()) state.viewDate = shiftDate(state.viewDate, 1);
  renderToday();
});
document.querySelectorAll("#range-seg button").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll("#range-seg button").forEach((x) => x.classList.toggle("on", x === b));
  renderHistory();
}));
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") renderToday();
});

// ---------- boot ----------
fillSettings();
renderToday();
if (!state.settings.apiKey) showView("settings");
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
