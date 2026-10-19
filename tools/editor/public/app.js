// Клиент локального редактора. Без фреймворков и сборки: ES-модуль,
// который работает прямо из public/.
import { extractOutline, renderMarkdown } from "./markdown.js";

const $ = (id) => document.getElementById(id);
const els = {
  versionBadge: $("versionBadge"),
  gitBadge: $("gitBadge"),
  validationBadge: $("validationBadge"),
  searchInput: $("searchInput"),
  categoryFilter: $("categoryFilter"),
  tagFilter: $("tagFilter"),
  articleList: $("articleList"),
  articleCount: $("articleCount"),
  mediaCount: $("mediaCount"),
  refreshBtn: $("refreshBtn"),
  emptyState: $("emptyState"),
  editorPane: $("editorPane"),
  articleIdLabel: $("articleIdLabel"),
  articlePathLabel: $("articlePathLabel"),
  titleInput: $("titleInput"),
  shortInput: $("shortInput"),
  categoryInput: $("categoryInput"),
  categoryOptions: $("categoryOptions"),
  levelInput: $("levelInput"),
  techInput: $("techInput"),
  equipmentInput: $("equipmentInput"),
  tagsInput: $("tagsInput"),
  calcInput: $("calcInput"),
  sourceInput: $("sourceInput"),
  createdInput: $("createdInput"),
  updatedInput: $("updatedInput"),
  sourcesInput: $("sourcesInput"),
  bodyInput: $("bodyInput"),
  editorBody: $("editorBody"),
  writePane: $("writePane"),
  livePreviewPane: $("livePreviewPane"),
  previewPane: $("previewPane"),
  outlinePane: $("outlinePane"),
  wordCount: $("wordCount"),
  saveState: $("saveState"),
  toast: $("toast"),
  dataModal: $("dataModal"),
  dataNav: $("dataNav"),
  dataFileLabel: $("dataFileLabel"),
  dataStatus: $("dataStatus"),
  dataJson: $("dataJson"),
  treeModal: $("treeModal"),
  treeRoots: $("treeRoots"),
  treeRootDrop: $("treeRootDrop"),
  treeSummary: $("treeSummary"),
  treeUnplaced: $("treeUnplaced"),
  treeUnplacedCount: $("treeUnplacedCount"),
  treeErrors: $("treeErrors"),
  treeStatus: $("treeStatus"),
  treeSaveBtn: $("treeSaveBtn"),
  linkModal: $("linkModal"),
  linkKindTabs: $("linkKindTabs"),
  linkSearchInput: $("linkSearchInput"),
  linkResults: $("linkResults"),
  linkLabelInput: $("linkLabelInput"),
  linkUrlField: $("linkUrlField"),
  linkUrlInput: $("linkUrlInput"),
  linkError: $("linkError"),
  publishModal: $("publishModal"),
  publishInfo: $("publishInfo"),
  commitMessage: $("commitMessage"),
  releaseCheck: $("releaseCheck"),
  releaseFields: $("releaseFields"),
  releaseVersion: $("releaseVersion"),
  publishLog: $("publishLog"),
  outputModal: $("outputModal"),
  outputTitle: $("outputTitle"),
  outputSubtitle: $("outputSubtitle"),
  outputText: $("outputText"),
};

let state = null;
let current = null;
let baseline = "";
let activeTab = "write";
let dataSelection = null;
let toastTimer = 0;
let previewTimer = 0;
let treeDraft = null;
let treeDirty = false;
let treeSequence = 0;
let dragState = null;
let linkKind = "article";
let linkSelection = null;

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options,
  });
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { error: text || `HTTP ${response.status}` };
  }
  if (!response.ok) {
    const error = new Error(payload.error || `HTTP ${response.status}`);
    error.payload = payload;
    error.status = response.status;
    throw error;
  }
  return payload;
}

function showToast(message, type = "") {
  clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.className = `toast ${type}`.trim();
  els.toast.hidden = false;
  toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, type === "error" ? 6000 : 3200);
}

function openModal(id) {
  $(id).hidden = false;
}

function closeModal(id) {
  $(id).hidden = true;
}

function requestCloseModal(id) {
  if (id === "treeModal" && treeDirty && !confirm("Закрыть дерево без сохранения изменений?")) return;
  closeModal(id);
}

function showOutput(title, subtitle, text) {
  els.outputTitle.textContent = title;
  els.outputSubtitle.textContent = subtitle || "";
  els.outputText.textContent = text || "Нет вывода.";
  openModal("outputModal");
}

function splitList(value) {
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item, index, all) => all.indexOf(item) === index);
}

function joinList(value) {
  return Array.isArray(value) ? value.join(", ") : "";
}

function wordCount(text) {
  const clean = String(text ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_`[\]()|-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clean ? clean.split(" ").length : 0;
}

function setDirty(value) {
  if (value === Boolean(current?.dirty)) return;
  if (current) current.dirty = value;
  els.saveState.textContent = value ? "есть несохранённые правки" : "сохранено";
  els.saveState.style.color = value ? "var(--warn)" : "";
}

function isDirty() {
  return Boolean(current?.dirty);
}

function confirmDiscard() {
  return !isDirty() || confirm("Есть несохранённые правки. Отменить их?");
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renderBadges() {
  if (!state) return;
  els.versionBadge.textContent = `версия ${state.contentVersion}`;
  els.gitBadge.textContent = `${state.git.branch} · ${state.git.clean ? "чисто" : `изменений: ${state.git.dirty.length}`}`;
  els.gitBadge.className = `badge ${state.git.clean ? "" : "warn"}`.trim();
  const errors = state.validation.errors.length;
  const warnings = state.validation.warnings.length;
  els.validationBadge.textContent = errors
    ? `ошибок: ${errors}`
    : warnings
      ? `предупреждений: ${warnings}`
      : "контент валиден";
  els.validationBadge.className = `badge badge-button ${errors ? "bad" : warnings ? "warn" : "ok"}`;
  els.mediaCount.textContent = `медиа: ${state.media.length}`;
}

function renderFilters() {
  const category = els.categoryFilter.value;
  const tag = els.tagFilter.value;
  els.categoryFilter.innerHTML = '<option value="">Все категории</option>';
  for (const item of state.categories) {
    const option = document.createElement("option");
    option.value = item;
    option.textContent = item;
    els.categoryFilter.append(option);
  }
  els.categoryFilter.value = category;

  const tags = [...new Set(state.articles.flatMap((article) => article.tags))].sort();
  els.tagFilter.innerHTML = '<option value="">Все теги</option>';
  for (const item of tags) {
    const option = document.createElement("option");
    option.value = item;
    option.textContent = item;
    els.tagFilter.append(option);
  }
  els.tagFilter.value = tag;

  els.categoryOptions.innerHTML = "";
  for (const item of state.categories) {
    const option = document.createElement("option");
    option.value = item;
    els.categoryOptions.append(option);
  }
}

function visibleArticles() {
  if (!state) return [];
  const query = els.searchInput.value.trim().toLowerCase();
  const category = els.categoryFilter.value;
  const tag = els.tagFilter.value;
  return state.articles.filter((article) => {
    if (category && article.category !== category) return false;
    if (tag && !article.tags.includes(tag)) return false;
    if (!query) return true;
    return [article.id, article.title, article.short, article.category, ...article.tags]
      .join(" ")
      .toLowerCase()
      .includes(query);
  });
}

function renderArticleList() {
  if (!state) return;
  const articles = visibleArticles();
  els.articleList.innerHTML = "";
  els.articleCount.textContent = `${articles.length} / ${state.articles.length}`;
  if (!articles.length) {
    const empty = document.createElement("div");
    empty.className = "muted";
    empty.style.padding = "18px 10px";
    empty.textContent = "Ничего не найдено.";
    els.articleList.append(empty);
    return;
  }

  const groups = new Map();
  for (const article of articles) {
    const key = article.category || "без категории";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(article);
  }
  for (const [group, items] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const label = document.createElement("div");
    label.className = "group-label";
    label.textContent = `${group} · ${items.length}`;
    els.articleList.append(label);
    for (const article of items) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `article-item ${current?.id === article.id ? "active" : ""}`;
      button.dataset.articleId = article.id;
      const title = document.createElement("strong");
      title.textContent = article.title || article.id;
      const id = document.createElement("small");
      id.textContent = article.id;
      button.append(title, id);
      if (article.tags.length) {
        const tags = document.createElement("span");
        tags.className = "item-tags";
        for (const tag of article.tags.slice(0, 4)) {
          const chip = document.createElement("span");
          chip.className = "tag";
          chip.textContent = tag;
          tags.append(chip);
        }
        button.append(tags);
      }
      els.articleList.append(button);
    }
  }
}


function renderValidation() {
  renderBadges();
  if (!state) return;
  const parts = [];
  if (state.validation.stats) {
    const stats = state.validation.stats;
    parts.push(`Статей: ${stats.total}, ссылок: ${stats.links}, редиректов: ${stats.redirects}`);
  }
  if (state.validation.errors.length) {
    parts.push("", "Ошибки:", ...state.validation.errors.map((item) => `✗ ${item}`));
  }
  if (state.validation.warnings.length) {
    parts.push("", "Предупреждения:", ...state.validation.warnings.map((item) => `! ${item}`));
  }
  if (!state.validation.errors.length && !state.validation.warnings.length) {
    parts.push("", "Ошибок и предупреждений нет.");
  }
  showOutput("Проверка контента", parts[0], parts.join("\n"));
}

function fillForm(article) {
  const data = article.data ?? {};
  els.articleIdLabel.textContent = article.id;
  els.articlePathLabel.textContent = `wiki/${article.id}.md`;
  els.titleInput.value = article.title ?? "";
  els.shortInput.value = data.short ?? "";
  els.categoryInput.value = data.category ?? "";
  els.levelInput.value = data.level ? String(data.level) : "";
  els.techInput.value = joinList(data.tech);
  els.equipmentInput.value = joinList(data.equipment);
  els.tagsInput.value = joinList(data.tags);
  els.calcInput.value = joinList(data.calc);
  els.sourceInput.value = data.source ?? "";
  els.createdInput.value = data.created ?? "";
  els.updatedInput.value = data.updated ?? today();
  els.sourcesInput.value = Array.isArray(data.sources) ? data.sources.join("\n") : "";
  els.bodyInput.value = article.body ?? "";
  updateWordCount();
  renderPreview();
  switchTab("write");
}

async function openArticle(id, { force = false } = {}) {
  if (!id) return;
  if (!force && isDirty() && !confirmDiscard()) return;
  try {
    const article = await api(`/api/articles/${encodeURIComponent(id)}`);
    current = { ...article, dirty: false };
    fillForm(article);
    baseline = JSON.stringify(collectArticle());
    setDirty(false);
    els.saveState.textContent = "сохранено";
    localStorage.setItem("distillarium.editor.article", id);
    els.emptyState.hidden = true;
    els.editorPane.hidden = false;
    renderArticleList();
  } catch (error) {
    showToast(error.message, "error");
  }
}

function clearEditor() {
  current = null;
  els.editorPane.hidden = true;
  els.emptyState.hidden = false;
  renderArticleList();
}

function collectArticle() {
  const data = { ...(current?.data ?? {}) };
  const fields = {
    short: els.shortInput.value.trim(),
    category: els.categoryInput.value.trim(),
    level: els.levelInput.value,
    tech: splitList(els.techInput.value),
    equipment: splitList(els.equipmentInput.value),
    tags: splitList(els.tagsInput.value),
    calc: splitList(els.calcInput.value),
    source: els.sourceInput.value.trim(),
    created: els.createdInput.value,
    updated: els.updatedInput.value,
    sources: els.sourcesInput.value
      .split("\n")
      .map((item) => item.trim())
      .filter(Boolean),
  };
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value) ? value.length : value) data[key] = value;
    else delete data[key];
  }
  if (fields.level) data.level = Number(fields.level);
  else delete data.level;
  return {
    id: current?.id ?? "",
    title: els.titleInput.value.trim(),
    data,
    body: els.bodyInput.value,
  };
}

function updateWordCount() {
  els.wordCount.textContent = `${wordCount(els.bodyInput.value)} слов`;
}

function knownLinkTargets() {
  const known = new Set(state.articles.map((article) => article.id));
  for (const key of Object.keys(state.data.redirects ?? {})) known.add(key);
  for (const item of state.data.calculators?.items ?? []) {
    if (item?.id) known.add(`calc:${item.id}`);
  }
  for (const table of state.data.reference ?? []) {
    if (table?.id) known.add(`ref:${table.id}`);
  }
  return known;
}

function renderPreview() {
  if (!state) return;
  const html = renderMarkdown(els.bodyInput.value, knownLinkTargets());
  els.livePreviewPane.innerHTML = html;
  els.previewPane.innerHTML = html;
}

function renderOutline() {
  const outline = extractOutline(els.bodyInput.value);
  els.outlinePane.innerHTML = "<h3>Оглавление</h3>";
  if (!outline.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "В тексте нет заголовков.";
    els.outlinePane.append(empty);
    return;
  }
  const list = document.createElement("ol");
  for (const item of outline) {
    const li = document.createElement("li");
    li.style.marginLeft = `${(item.level - 1) * 14}px`;
    const link = document.createElement("a");
    link.href = `#${item.id}`;
    link.textContent = item.text;
    link.addEventListener("click", (event) => {
      event.preventDefault();
      switchTab("preview");
      requestAnimationFrame(() => {
        document.getElementById(item.id)?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
    li.append(link);
    list.append(li);
  }
  els.outlinePane.append(list);
}

function switchTab(tab) {
  activeTab = tab;
  for (const button of document.querySelectorAll(".tab")) {
    button.classList.toggle("active", button.dataset.tab === tab);
  }
  const write = tab === "write";
  els.writePane.hidden = !write;
  els.livePreviewPane.hidden = !write;
  els.editorBody.classList.toggle("split", write);
  els.previewPane.hidden = tab !== "preview";
  els.outlinePane.hidden = tab !== "outline";
  if (write) renderPreview();
  if (tab === "preview") renderPreview();
  if (tab === "outline") renderOutline();
}

function markDirty() {
  if (!current) return;
  current.dirty = true;
  els.saveState.textContent = "есть несохранённые правки";
  els.saveState.style.color = "var(--warn)";
  updateWordCount();
  if (activeTab === "preview" || activeTab === "write") {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(renderPreview, 180);
  }
}


async function refreshState({ reloadCurrent = false } = {}) {
  state = await api("/api/state");
  renderFilters();
  renderBadges();
  renderArticleList();
  if (reloadCurrent && current) {
    await openArticle(current.id, { force: true });
  }
}

async function saveArticle() {
  if (!current) return;
  const payload = collectArticle();
  if (!payload.title) {
    showToast("Заголовок не может быть пустым", "error");
    els.titleInput.focus();
    return;
  }
  els.saveState.textContent = "сохраняю…";
  try {
    const result = await api(`/api/articles/${encodeURIComponent(current.id)}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    current = { ...result.article, dirty: false };
    fillForm(result.article);
    baseline = JSON.stringify(collectArticle());
    setDirty(false);
    els.saveState.textContent = "сохранено";
    await refreshState();
    renderArticleList();
    const errors = result.validation?.errors?.length ?? 0;
    showToast(errors ? `Сохранено, но есть ошибки: ${errors}` : "Сохранено", errors ? "error" : "ok");
  } catch (error) {
    els.saveState.textContent = "не сохранено";
    els.saveState.style.color = "var(--danger)";
    showToast(error.message, "error");
    if (error.payload?.details?.log) showOutput("Ошибка сохранения", "", error.payload.details.log);
  }
}

async function createArticle() {
  if (!confirmDiscard()) return;
  const id = prompt(
    "id новой статьи (латиница, цифры, «-», «_», «/»):",
    "processes/new-article",
  );
  if (!id) return;
  const title = prompt("Заголовок статьи:", "");
  if (!title) return;
  try {
    const result = await api("/api/articles", {
      method: "POST",
      body: JSON.stringify({
        id: id.trim(),
        title: title.trim(),
        category: id.includes("/") ? id.split("/")[0] : "",
        source: "manual",
        created: today(),
        updated: today(),
        sources: [],
        body: "## Коротко\n\n## Что делать\n\n1. \n\n## Почему так\n\n",
      }),
    });
    await refreshState();
    await openArticle(result.article.id, { force: true });
    showToast("Статья создана", "ok");
    els.titleInput.focus();
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function renameArticle() {
  if (!current) return;
  const newId = prompt("Новый id статьи:", current.id);
  if (!newId || newId.trim() === current.id) return;
  if (!confirm(`Переименовать ${current.id} → ${newId.trim()}? Старый id станет редиректом.`)) return;
  try {
    const result = await api(`/api/articles/${encodeURIComponent(current.id)}/rename`, {
      method: "POST",
      body: JSON.stringify({ newId: newId.trim() }),
    });
    current = { ...result.article, dirty: false };
    await refreshState();
    await openArticle(result.article.id, { force: true });
    showToast(`Переименовано в ${result.article.id}`, "ok");
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function deleteArticle() {
  if (!current) return;
  if (!confirm(`Удалить статью «${current.title || current.id}»?`)) return;
  const redirect = prompt(
    "Куда перенаправить старые ссылки? Оставьте пустым, если редирект не нужен.",
    "",
  );
  try {
    await api(
      `/api/articles/${encodeURIComponent(current.id)}${redirect?.trim() ? `?redirect=${encodeURIComponent(redirect.trim())}` : ""}`,
      { method: "DELETE" },
    );
    const deleted = current.id;
    clearEditor();
    await refreshState();
    localStorage.removeItem("distillarium.editor.article");
    showToast(`Статья ${deleted} удалена`, "ok");
    if (state.articles.length) await openArticle(state.articles[0].id, { force: true });
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function insertImage(file) {
  if (!file || !current) return;
  if (file.size > 8 * 1024 * 1024) {
    showToast("Картинка больше 8 МБ", "error");
    return;
  }
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  const base64 = dataUrl.split(",")[1] ?? "";
  try {
    const uploaded = await api("/api/media", {
      method: "POST",
      body: JSON.stringify({ name: file.name, mime: file.type, base64 }),
    });
    const textarea = els.bodyInput;
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? start;
    const insert = `\n\n${uploaded.markdown}\n`;
    textarea.value = `${textarea.value.slice(0, start)}${insert}${textarea.value.slice(end)}`;
    textarea.selectionStart = textarea.selectionEnd = start + insert.length;
    textarea.focus();
    markDirty();
    await refreshState();
    showToast("Картинка добавлена", "ok");
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    $("imageInput").value = "";
  }
}


function markdownEdit(before, after = before, placeholder = "текст") {
  const textarea = els.bodyInput;
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? start;
  const selected = textarea.value.slice(start, end) || placeholder;
  const insert = `${before}${selected}${after}`;
  textarea.value = `${textarea.value.slice(0, start)}${insert}${textarea.value.slice(end)}`;
  textarea.selectionStart = start + before.length;
  textarea.selectionEnd = start + before.length + selected.length;
  textarea.focus();
  markDirty();
}

function prefixLines(prefix, placeholder = "пункт") {
  const textarea = els.bodyInput;
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? start;
  const lineStart = textarea.value.lastIndexOf("\n", start - 1) + 1;
  const nextBreak = textarea.value.indexOf("\n", end);
  const lineEnd = nextBreak === -1 ? textarea.value.length : nextBreak;
  const block = textarea.value.slice(lineStart, lineEnd) || placeholder;
  const insert = block
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
  textarea.value = `${textarea.value.slice(0, lineStart)}${insert}${textarea.value.slice(lineEnd)}`;
  textarea.selectionStart = lineStart;
  textarea.selectionEnd = lineStart + insert.length;
  textarea.focus();
  markDirty();
}

function applyFormat(kind) {
  if (kind === "bold") markdownEdit("**", "**", "жирный текст");
  else if (kind === "italic") markdownEdit("*", "*", "курсив");
  else if (kind === "heading") prefixLines("## ", "Заголовок");
  else if (kind === "list") prefixLines("- ", "пункт");
  else if (kind === "quote") prefixLines("> ", "цитата");
  else if (kind === "code") markdownEdit("`", "`", "код");
}

function insertAtCursor(text) {
  const textarea = els.bodyInput;
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? start;
  textarea.value = `${textarea.value.slice(0, start)}${text}${textarea.value.slice(end)}`;
  textarea.selectionStart = textarea.selectionEnd = start + text.length;
  textarea.focus();
  markDirty();
}

const LINK_KINDS = [
  { key: "article", label: "Статья" },
  { key: "calculator", label: "Калькулятор" },
  { key: "reference", label: "Справочник" },
  { key: "url", label: "Внешний адрес" },
];

function linkItems() {
  if (!state) return [];
  if (linkKind === "article") {
    return state.articles.map((article) => ({
      target: article.id,
      title: article.title || article.id,
      subtitle: article.id,
    }));
  }
  if (linkKind === "calculator") {
    return (state.data.calculators?.items ?? []).map((item) => ({
      target: `calc:${item.id}`,
      title: item.title || item.id,
      subtitle: `calc:${item.id}`,
    }));
  }
  if (linkKind === "reference") {
    return (state.data.reference ?? []).map((table) => ({
      target: `ref:${table.id}`,
      title: table.data?.title || table.id,
      subtitle: `ref:${table.id}`,
    }));
  }
  return [];
}

function renderLinkKinds() {
  els.linkKindTabs.innerHTML = "";
  for (const kind of LINK_KINDS) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = kind.label;
    button.className = linkKind === kind.key ? "active" : "";
    button.addEventListener("click", () => {
      linkKind = kind.key;
      linkSelection = null;
      els.linkLabelInput.value = "";
      els.linkError.hidden = true;
      renderLinkKinds();
      renderLinkResults();
    });
    els.linkKindTabs.append(button);
  }
}

function renderLinkResults() {
  const query = els.linkSearchInput.value.trim().toLowerCase();
  els.linkResults.innerHTML = "";
  els.linkUrlField.hidden = linkKind !== "url";
  if (linkKind === "url") {
    const hint = document.createElement("div");
    hint.className = "link-result-empty";
    hint.textContent = "Введите адрес https://… и подпись ссылки.";
    els.linkResults.append(hint);
    return;
  }
  const items = linkItems().filter((item) => {
    if (!query) return true;
    return `${item.title} ${item.subtitle}`.toLowerCase().includes(query);
  });
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "link-result-empty";
    empty.textContent = "Ничего не найдено.";
    els.linkResults.append(empty);
    return;
  }
  for (const item of items) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `link-result ${linkSelection?.target === item.target ? "active" : ""}`;
    const title = document.createElement("strong");
    title.textContent = item.title;
    const subtitle = document.createElement("small");
    subtitle.textContent = item.subtitle;
    button.append(title, subtitle);
    button.addEventListener("click", () => {
      linkSelection = item;
      els.linkLabelInput.value = item.title;
      els.linkError.hidden = true;
      renderLinkResults();
    });
    els.linkResults.append(button);
  }
}

function openLinkModal() {
  if (!state || !current) {
    showToast("Сначала откройте статью", "error");
    return;
  }
  linkKind = "article";
  linkSelection = null;
  els.linkSearchInput.value = "";
  els.linkLabelInput.value = "";
  els.linkUrlInput.value = "";
  els.linkError.hidden = true;
  renderLinkKinds();
  renderLinkResults();
  openModal("linkModal");
  els.linkSearchInput.focus();
}

function insertLink() {
  if (linkKind === "url") {
    const url = els.linkUrlInput.value.trim();
    if (!/^https?:\/\//i.test(url)) {
      els.linkError.textContent = "Адрес должен начинаться с http:// или https://";
      els.linkError.hidden = false;
      return;
    }
    const label = els.linkLabelInput.value.trim() || url;
    insertAtCursor(`[${label}](${url})`);
    closeModal("linkModal");
    return;
  }
  if (!linkSelection) {
    els.linkError.textContent = "Выберите элемент из списка";
    els.linkError.hidden = false;
    return;
  }
  const label = els.linkLabelInput.value.trim() || linkSelection.title;
  insertAtCursor(`[[${linkSelection.target}|${label}]]`);
  closeModal("linkModal");
}


function cloneTreeNode(node) {
  return {
    id: String(node.id ?? ""),
    title: String(node.title ?? ""),
    articles: Array.isArray(node.articles) ? [...node.articles] : [],
    children: Array.isArray(node.children) ? node.children.map(cloneTreeNode) : [],
  };
}

function cloneTree(tree) {
  return {
    schemaVersion: 1,
    roots: Array.isArray(tree?.roots) ? tree.roots.map(cloneTreeNode) : [],
  };
}

function walkTree(nodes, visit, parent = null, depth = 1) {
  nodes.forEach((node, index) => {
    visit(node, parent, index, depth);
    walkTree(node.children ?? [], visit, node, depth + 1);
  });
}

function findTreeSection(id, nodes = treeDraft?.roots ?? [], parent = null, depth = 1) {
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (node.id === id) return { node, parent, index, depth };
    const found = findTreeSection(id, node.children ?? [], node, depth + 1);
    if (found) return found;
  }
  return null;
}

function treeSectionCount() {
  let count = 0;
  walkTree(treeDraft?.roots ?? [], () => {
    count += 1;
  });
  return count;
}

function treeArticleIds(node) {
  const ids = [...(node.articles ?? [])];
  for (const child of node.children ?? []) ids.push(...treeArticleIds(child));
  return ids;
}

function treePlacedIds() {
  const placed = new Set();
  walkTree(treeDraft?.roots ?? [], (node) => {
    for (const id of node.articles ?? []) placed.add(id);
  });
  return placed;
}

function unplacedArticles() {
  const placed = treePlacedIds();
  return state.articles
    .filter((article) => !placed.has(article.id))
    .sort((a, b) => (a.title || a.id).localeCompare(b.title || b.id, "ru"));
}

function findArticlePlacement(articleId) {
  let found = null;
  walkTree(treeDraft?.roots ?? [], (node) => {
    if (found) return;
    const index = (node.articles ?? []).indexOf(articleId);
    if (index !== -1) found = { node, index };
  });
  return found;
}

function removeArticleEverywhere(articleId) {
  walkTree(treeDraft?.roots ?? [], (node) => {
    node.articles = (node.articles ?? []).filter((id) => id !== articleId);
  });
}

function isTreeDescendant(node, id) {
  if (node.id === id) return true;
  return (node.children ?? []).some((child) => isTreeDescendant(child, id));
}

function treeNewId(parentId) {
  const ids = new Set();
  walkTree(treeDraft?.roots ?? [], (node) => ids.add(node.id));
  treeSequence += 1;
  const suffix = `${Date.now().toString(36)}${treeSequence.toString(36)}`;
  const stem = `${parentId ? `${parentId}/` : ""}section`;
  let id = `${stem}-${suffix}`;
  while (ids.has(id)) id += "x";
  return id;
}

function treeDirtyState(dirty) {
  treeDirty = dirty;
  els.treeStatus.textContent = dirty ? "есть несохранённые правки" : "сохранено";
  els.treeStatus.style.color = dirty ? "var(--warn)" : "";
  $("treeSaveBtn").disabled = !dirty;
  if (dirty) {
    els.treeErrors.hidden = true;
    els.treeErrors.textContent = "";
  }
}


function addTreeSection(parentId = "") {
  const found = parentId ? findTreeSection(parentId) : null;
  if (parentId && !found) return;
  if (found && found.depth >= 4) {
    showToast("Вложенность ограничена четырьмя уровнями", "error");
    return;
  }
  const title = prompt(parentId ? "Название подраздела:" : "Название раздела:", "");
  if (!title?.trim()) return;
  const section = {
    id: treeNewId(parentId),
    title: title.trim(),
    articles: [],
    children: [],
  };
  if (found) found.node.children.push(section);
  else treeDraft.roots.push(section);
  treeDirtyState(true);
  renderTreeEditor();
}

function renameTreeSection(id) {
  const found = findTreeSection(id);
  if (!found) return;
  const title = prompt("Название раздела:", found.node.title);
  if (!title?.trim() || title.trim() === found.node.title) return;
  found.node.title = title.trim();
  treeDirtyState(true);
  renderTreeEditor();
}

function moveTreeSectionOrder(id, offset) {
  const found = findTreeSection(id);
  if (!found) return;
  const siblings = found.parent ? found.parent.children : treeDraft.roots;
  const target = found.index + offset;
  if (target < 0 || target >= siblings.length) return;
  const [node] = siblings.splice(found.index, 1);
  siblings.splice(target, 0, node);
  treeDirtyState(true);
  renderTreeEditor();
}

function deleteTreeSection(id) {
  const found = findTreeSection(id);
  if (!found) return;
  const total = treeArticleIds(found.node).length;
  const message = found.node.children.length
    ? `Удалить раздел «${found.node.title}»? Подразделы поднимутся на уровень выше, ${total} статей останутся без раздела.`
    : `Удалить раздел «${found.node.title}»? ${total ? `${total} статей останутся без раздела.` : ""}`;
  if (!confirm(message.trim())) return;
  const siblings = found.parent ? found.parent.children : treeDraft.roots;
  siblings.splice(found.index, 1);
  const children = found.node.children ?? [];
  if (children.length) siblings.splice(found.index, 0, ...children);
  treeDirtyState(true);
  renderTreeEditor();
}

function moveSectionInto(id, targetId) {
  if (!id || !targetId || id === targetId) return false;
  const source = findTreeSection(id);
  const target = findTreeSection(targetId);
  if (!source || !target) return false;
  if (isTreeDescendant(source.node, targetId)) {
    showToast("Нельзя вложить раздел в самого себя", "error");
    return false;
  }
  if (target.depth >= 4) {
    showToast("Вложенность ограничена четырьмя уровнями", "error");
    return false;
  }
  const siblings = source.parent ? source.parent.children : treeDraft.roots;
  siblings.splice(source.index, 1);
  target.node.children.push(source.node);
  treeDirtyState(true);
  renderTreeEditor();
  return true;
}

function moveSectionToRoots(id) {
  const source = findTreeSection(id);
  if (!source) return false;
  const siblings = source.parent ? source.parent.children : treeDraft.roots;
  if (!source.parent) {
    siblings.splice(source.index, 1);
    siblings.push(source.node);
  } else {
    siblings.splice(source.index, 1);
    treeDraft.roots.push(source.node);
  }
  treeDirtyState(true);
  renderTreeEditor();
  return true;
}

function moveArticleToSection(articleId, sectionId, beforeArticleId = null) {
  const target = findTreeSection(sectionId);
  if (!target) return false;
  removeArticleEverywhere(articleId);
  const articles = target.node.articles ?? (target.node.articles = []);
  let index = beforeArticleId ? articles.indexOf(beforeArticleId) : -1;
  if (index === -1) index = articles.length;
  articles.splice(index, 0, articleId);
  treeDirtyState(true);
  renderTreeEditor();
  return true;
}

function unplaceArticle(articleId) {
  if (!findArticlePlacement(articleId)) return;
  removeArticleEverywhere(articleId);
  treeDirtyState(true);
  renderTreeEditor();
}


function treeArticleElement(articleId, sectionId, showRemove = true) {
  const article = state.articles.find((item) => item.id === articleId);
  const wrapper = document.createElement("span");
  wrapper.className = "tree-article-drop";
  wrapper.dataset.sectionId = sectionId;
  wrapper.dataset.articleId = articleId;

  const chip = document.createElement("span");
  chip.className = "tree-article";
  chip.draggable = true;
  chip.dataset.articleId = articleId;
  chip.title = article ? `${article.title} · ${articleId}` : `Нет статьи: ${articleId}`;
  const label = document.createElement("span");
  label.className = "tree-article-label";
  label.textContent = article?.title || articleId;
  chip.append(label);
  if (!article) {
    const missing = document.createElement("small");
    missing.textContent = "нет статьи";
    chip.append(missing);
  }

  chip.addEventListener("dragstart", (event) => {
    dragState = { type: "article", id: articleId };
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", articleId);
    chip.classList.add("dragging");
  });
  chip.addEventListener("dragend", () => {
    dragState = null;
    chip.classList.remove("dragging");
  });

  if (showRemove) {
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "tree-article-remove";
    remove.textContent = "×";
    remove.title = "Убрать из раздела";
    remove.draggable = false;
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      unplaceArticle(articleId);
    });
    chip.append(remove);
  }

  wrapper.addEventListener("dragover", (event) => {
    if (!sectionId || dragState?.type !== "article") return;
    event.preventDefault();
    event.stopPropagation();
    wrapper.classList.add("over");
  });
  wrapper.addEventListener("dragleave", () => wrapper.classList.remove("over"));
  wrapper.addEventListener("drop", (event) => {
    if (!sectionId || dragState?.type !== "article") return;
    event.preventDefault();
    event.stopPropagation();
    wrapper.classList.remove("over");
    moveArticleToSection(dragState.id, wrapper.dataset.sectionId, wrapper.dataset.articleId);
    dragState = null;
  });

  wrapper.append(chip);
  return wrapper;
}

function treeSectionElement(node, depth) {
  const section = document.createElement("div");
  section.className = "tree-section";
  section.dataset.sectionId = node.id;
  if ((node.articles ?? []).length || (node.children ?? []).length) {
    section.classList.add("has-content");
  }

  const head = document.createElement("div");
  head.className = "tree-section-head";

  const handle = document.createElement("button");
  handle.type = "button";
  handle.className = "tree-handle";
  handle.textContent = "⋮⋮";
  handle.title = "Перетащите раздел";
  handle.draggable = true;
  handle.addEventListener("dragstart", (event) => {
    dragState = { type: "section", id: node.id };
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", node.id);
  });
  handle.addEventListener("dragend", () => {
    dragState = null;
  });

  const title = document.createElement("span");
  title.className = "tree-section-title";
  title.textContent = node.title;
  title.title = node.title;

  const count = document.createElement("span");
  count.className = "tree-count";
  count.textContent = String(treeArticleIds(node).length);
  count.title = "Статей в разделе с подразделами";

  const actions = document.createElement("div");
  actions.className = "tree-section-actions";
  const action = (text, titleText, handler, extraClass = "") => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `tree-icon ${extraClass}`.trim();
    button.textContent = text;
    button.title = titleText;
    button.addEventListener("click", handler);
    actions.append(button);
  };
  action("↑", "Выше", () => moveTreeSectionOrder(node.id, -1));
  action("↓", "Ниже", () => moveTreeSectionOrder(node.id, 1));
  if (depth < 4) action("+", "Добавить подраздел", () => addTreeSection(node.id));
  action("✎", "Переименовать", () => renameTreeSection(node.id));
  action("✕", "Удалить раздел", () => deleteTreeSection(node.id), "danger");

  head.append(handle, title, count, actions);

  const body = document.createElement("div");
  body.className = "tree-section-body";
  const articles = document.createElement("div");
  articles.className = "tree-articles";
  if ((node.articles ?? []).length) {
    for (const articleId of node.articles) {
      articles.append(treeArticleElement(articleId, node.id));
    }
  } else {
    const hint = document.createElement("span");
    hint.className = "tree-drop-hint";
    hint.textContent = "Перетащите статьи сюда";
    articles.append(hint);
  }
  body.append(articles);

  if ((node.children ?? []).length) {
    const children = document.createElement("div");
    children.className = "tree-section-children";
    for (const child of node.children) children.append(treeSectionElement(child, depth + 1));
    body.append(children);
  }

  section.append(head, body);

  section.addEventListener("dragover", (event) => {
    if (event.target.closest(".tree-section") !== section) return;
    if (dragState?.type === "article") {
      event.preventDefault();
      event.stopPropagation();
      section.classList.add("drop-target");
      return;
    }
    if (dragState?.type === "section") {
      const source = findTreeSection(dragState.id);
      if (!source || source.node.id === node.id) return;
      if (isTreeDescendant(source.node, node.id) || depth >= 4) return;
      event.preventDefault();
      event.stopPropagation();
      section.classList.add("drop-target");
    }
  });
  section.addEventListener("dragleave", (event) => {
    if (!section.contains(event.relatedTarget)) section.classList.remove("drop-target");
  });
  section.addEventListener("drop", (event) => {
    if (event.target.closest(".tree-section") !== section) return;
    event.preventDefault();
    event.stopPropagation();
    section.classList.remove("drop-target");
    if (dragState?.type === "article") {
      moveArticleToSection(dragState.id, node.id);
    } else if (dragState?.type === "section") {
      moveSectionInto(dragState.id, node.id);
    }
    dragState = null;
  });

  return section;
}

function renderTreeEditor() {
  if (!treeDraft) return;
  const placed = treePlacedIds();
  els.treeSummary.textContent = `${treeSectionCount()} разделов · размещено ${placed.size} из ${state.articles.length} статей`;
  els.treeRoots.innerHTML = "";

  if (!treeDraft.roots.length) {
    const empty = document.createElement("div");
    empty.className = "tree-empty";
    empty.textContent = "В дереве пока нет разделов. Добавьте первый или перетащите статьи после создания.";
    els.treeRoots.append(empty);
  } else {
    for (const node of treeDraft.roots) els.treeRoots.append(treeSectionElement(node, 1));
  }

  const unplaced = unplacedArticles();
  els.treeUnplacedCount.textContent = unplaced.length ? `${unplaced.length}` : "нет";
  els.treeUnplaced.innerHTML = "";
  if (!unplaced.length) {
    const empty = document.createElement("div");
    empty.className = "tree-empty";
    empty.textContent = "Все статьи размещены.";
    els.treeUnplaced.append(empty);
  } else {
    for (const article of unplaced) {
      const element = treeArticleElement(article.id, "", false);
      element.classList.add("unplaced-article");
      els.treeUnplaced.append(element);
    }
  }

  els.treeSaveBtn.disabled = !treeDirty;
  if (!treeDirty) {
    els.treeStatus.textContent = "сохранено";
    els.treeStatus.style.color = "";
  }
}

function openTreeModal() {
  if (!state) return;
  if (!confirmDiscard()) return;
  if (treeDirty && !confirm("Несохранённые правки дерева будут потеряны. Продолжить?")) return;
  treeDraft = cloneTree(state.tree);
  treeDirtyState(false);
  els.treeErrors.hidden = true;
  els.treeErrors.textContent = "";
  renderTreeEditor();
  openModal("treeModal");
}

function reloadTreeDraft() {
  if (!state) return;
  if (treeDirty && !confirm("Отменить изменения дерева?")) return;
  treeDraft = cloneTree(state.tree);
  treeDirtyState(false);
  els.treeErrors.hidden = true;
  els.treeErrors.textContent = "";
  renderTreeEditor();
}

async function saveTree() {
  if (!treeDraft) return;
  els.treeSaveBtn.disabled = true;
  els.treeStatus.textContent = "сохраняю…";
  els.treeStatus.style.color = "";
  try {
    const result = await api("/api/tree", {
      method: "PUT",
      body: JSON.stringify({ tree: treeDraft }),
    });
    treeDraft = cloneTree(result.tree);
    treeDirtyState(false);
    await refreshState();
    closeModal("treeModal");
    showToast("Дерево сохранено", "ok");
  } catch (error) {
    const errors = error.payload?.details?.errors ?? error.payload?.errors ?? [error.message];
    els.treeErrors.textContent = errors.join("\n");
    els.treeErrors.hidden = false;
    els.treeStatus.textContent = "не сохранено";
    els.treeStatus.style.color = "var(--danger)";
    els.treeSaveBtn.disabled = false;
    showToast(error.message, "error");
  }
}

function bindTreeDropZones() {
  els.treeRootDrop.addEventListener("dragover", (event) => {
    if (dragState?.type !== "section") return;
    event.preventDefault();
    els.treeRootDrop.classList.add("over");
  });
  els.treeRootDrop.addEventListener("dragleave", () => els.treeRootDrop.classList.remove("over"));
  els.treeRootDrop.addEventListener("drop", (event) => {
    if (dragState?.type !== "section") return;
    event.preventDefault();
    els.treeRootDrop.classList.remove("over");
    moveSectionToRoots(dragState.id);
    dragState = null;
  });

  els.treeUnplaced.addEventListener("dragover", (event) => {
    if (dragState?.type !== "article") return;
    event.preventDefault();
    els.treeUnplaced.classList.add("over");
  });
  els.treeUnplaced.addEventListener("dragleave", () => els.treeUnplaced.classList.remove("over"));
  els.treeUnplaced.addEventListener("drop", (event) => {
    if (dragState?.type !== "article") return;
    event.preventDefault();
    els.treeUnplaced.classList.remove("over");
    unplaceArticle(dragState.id);
    dragState = null;
  });
}


function dataItems() {
  if (!state) return [];
  const items = [
    { key: "version", group: "Пакет", label: "version.json", kind: "version", data: state.data.version },
    { key: "redirects", group: "Пакет", label: "redirects.json", kind: "redirects", data: state.data.redirects },
    { key: "calculators", group: "Пакет", label: "calculators.json", kind: "calculators", data: state.data.calculators },
  ];
  for (const table of state.data.reference) {
    items.push({
      key: `reference/${table.id}`,
      group: "Справочники",
      label: table.file,
      kind: "reference",
      id: table.id,
      data: table.data,
    });
  }
  for (const recipe of state.data.recipes) {
    items.push({
      key: `recipes/${recipe.id}`,
      group: "Рецепты",
      label: recipe.file,
      kind: "recipes",
      id: recipe.id,
      data: recipe.data,
    });
  }
  return items;
}

function renderDataNav() {
  const items = dataItems();
  els.dataNav.innerHTML = "";
  let group = "";
  for (const item of items) {
    if (item.group !== group) {
      group = item.group;
      const title = document.createElement("h4");
      title.textContent = group;
      els.dataNav.append(title);
    }
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = item.label;
    button.className = dataSelection?.key === item.key ? "active" : "";
    button.addEventListener("click", () => selectData(item.key));
    els.dataNav.append(button);
  }
}

function selectData(key) {
  const item = dataItems().find((entry) => entry.key === key);
  if (!item) return;
  dataSelection = item;
  els.dataFileLabel.textContent = item.label;
  els.dataJson.value = `${JSON.stringify(item.data, null, 2)}\n`;
  els.dataStatus.textContent = "";
  renderDataNav();
}

function openDataModal() {
  if (!state) return;
  openModal("dataModal");
  const first = dataSelection?.key ?? "version";
  selectData(first);
}

async function saveData() {
  if (!dataSelection) return;
  let data;
  try {
    data = JSON.parse(els.dataJson.value);
  } catch (error) {
    els.dataStatus.textContent = `JSON не разбирается: ${error.message}`;
    els.dataStatus.style.color = "var(--danger)";
    return;
  }
  const item = dataSelection;
  let path;
  if (item.kind === "version") path = "/api/data/version";
  else if (item.kind === "redirects") path = "/api/data/redirects";
  else if (item.kind === "calculators") path = "/api/data/calculators";
  else path = `/api/data/${item.kind}/${encodeURIComponent(item.id)}`;

  els.dataStatus.textContent = "сохраняю…";
  els.dataStatus.style.color = "";
  try {
    const result = await api(path, { method: "PUT", body: JSON.stringify({ data }) });
    await refreshState();
    selectData(item.key);
    const errors = result.validation?.errors?.length ?? 0;
    els.dataStatus.textContent = errors ? `сохранено, ошибок: ${errors}` : "сохранено";
    els.dataStatus.style.color = errors ? "var(--danger)" : "var(--ok)";
    showToast(errors ? `JSON сохранён, ошибок: ${errors}` : "JSON сохранён", errors ? "error" : "ok");
  } catch (error) {
    els.dataStatus.textContent = error.message;
    els.dataStatus.style.color = "var(--danger)";
    showToast(error.message, "error");
  }
}


function renderPublishInfo() {
  if (!state) return;
  const rows = [
    ["Версия", state.contentVersion],
    ["Следующая", state.nextVersion],
    ["Ветка", state.git.branch],
    ["Remote", state.git.remote],
    ["Последний коммит", state.git.lastCommit],
    ["Рабочая копия", state.git.clean ? "чисто" : `изменений: ${state.git.dirty.length}`],
  ];
  els.publishInfo.innerHTML = "";
  for (const [label, value] of rows) {
    const cell = document.createElement("div");
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    cell.append(dt, dd);
    els.publishInfo.append(cell);
  }
}

function openPublishModal() {
  if (!state) return;
  renderPublishInfo();
  els.commitMessage.value = `Контент: обновление ${today()}`;
  els.releaseCheck.checked = false;
  els.releaseFields.hidden = true;
  els.releaseVersion.value = state.nextVersion;
  els.publishLog.hidden = true;
  els.publishLog.textContent = "";
  openModal("publishModal");
}

async function confirmPublish() {
  const button = $("publishConfirmBtn");
  button.disabled = true;
  button.textContent = "Публикую…";
  els.publishLog.hidden = false;
  els.publishLog.textContent = "Проверка и сборка…";
  try {
    const result = await api("/api/publish", {
      method: "POST",
      body: JSON.stringify({
        message: els.commitMessage.value.trim(),
        version: els.releaseCheck.checked ? els.releaseVersion.value.trim() : "",
      }),
    });
    els.publishLog.textContent = result.log;
    showToast(result.tag ? `Опубликовано, тег ${result.tag}` : "Опубликовано", "ok");
    await refreshState();
    renderPublishInfo();
  } catch (error) {
    const log = error.payload?.details?.log;
    els.publishLog.textContent = Array.isArray(log)
      ? log.join("\n\n")
      : log || error.message;
    showToast(error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = "Опубликовать";
  }
}

async function checkContent() {
  const button = $("checkBtn");
  button.disabled = true;
  try {
    const result = await api("/api/check", { method: "POST", body: "{}" });
    state.validation = result.validation;
    renderBadges();
    renderValidation();
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

async function buildContent() {
  const button = $("buildBtn");
  button.disabled = true;
  button.textContent = "Собираю…";
  try {
    const result = await api("/api/build", { method: "POST", body: "{}" });
    showOutput(
      result.ok ? "Пакет собран" : "Сборка не прошла",
      result.ok ? "content-pack.zip и manifest.json готовы в dist/" : "",
      result.output,
    );
    await refreshState();
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = "Собрать";
  }
}


function bindEvents() {
  els.articleList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-article-id]");
    if (button) openArticle(button.dataset.articleId);
  });

  for (const input of [
    els.titleInput,
    els.shortInput,
    els.categoryInput,
    els.levelInput,
    els.techInput,
    els.equipmentInput,
    els.tagsInput,
    els.calcInput,
    els.sourceInput,
    els.createdInput,
    els.updatedInput,
    els.sourcesInput,
    els.bodyInput,
  ]) {
    input.addEventListener("input", markDirty);
    input.addEventListener("change", markDirty);
  }

  els.searchInput.addEventListener("input", renderArticleList);
  els.categoryFilter.addEventListener("change", renderArticleList);
  els.tagFilter.addEventListener("change", renderArticleList);
  els.refreshBtn.addEventListener("click", async () => {
    if (!confirmDiscard()) return;
    await refreshState({ reloadCurrent: true });
    showToast("Обновлено", "ok");
  });

  $("newArticleBtn").addEventListener("click", createArticle);
  $("emptyNewBtn").addEventListener("click", createArticle);
  $("saveBtn").addEventListener("click", saveArticle);
  $("renameBtn").addEventListener("click", renameArticle);
  $("deleteBtn").addEventListener("click", deleteArticle);
  $("checkBtn").addEventListener("click", checkContent);
  $("buildBtn").addEventListener("click", buildContent);
  $("publishBtn").addEventListener("click", openPublishModal);
  $("publishConfirmBtn").addEventListener("click", confirmPublish);
  $("dataBtn").addEventListener("click", openDataModal);
  $("emptyDataBtn").addEventListener("click", openDataModal);
  $("dataSaveBtn").addEventListener("click", saveData);
  $("dataReloadBtn").addEventListener("click", () => dataSelection && selectData(dataSelection.key));
  $("validationBadge").addEventListener("click", renderValidation);
  $("treeBtn").addEventListener("click", openTreeModal);
  $("treeAddRootBtn").addEventListener("click", () => addTreeSection());
  $("treeSaveBtn").addEventListener("click", saveTree);
  $("treeReloadBtn").addEventListener("click", reloadTreeDraft);
  bindTreeDropZones();

  $("insertLinkBtn").addEventListener("click", openLinkModal);
  $("linkInsertBtn").addEventListener("click", insertLink);
  els.linkSearchInput.addEventListener("input", renderLinkResults);
  els.linkSearchInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    const first = els.linkResults.querySelector(".link-result");
    if (first) first.click();
    else insertLink();
  });
  for (const button of document.querySelectorAll("[data-format]")) {
    button.addEventListener("click", () => applyFormat(button.dataset.format));
  }

  $("insertImageBtn").addEventListener("click", () => $("imageInput").click());
  $("imageInput").addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    if (file) insertImage(file);
  });

  els.releaseCheck.addEventListener("change", () => {
    els.releaseFields.hidden = !els.releaseCheck.checked;
  });

  for (const button of document.querySelectorAll(".tab")) {
    button.addEventListener("click", () => switchTab(button.dataset.tab));
  }

  for (const button of document.querySelectorAll("[data-close]")) {
    button.addEventListener("click", () => requestCloseModal(button.dataset.close));
  }
  for (const backdrop of document.querySelectorAll(".modal-backdrop")) {
    backdrop.addEventListener("mousedown", (event) => {
      if (event.target === backdrop) requestCloseModal(backdrop.id);
    });
  }

  document.addEventListener("keydown", (event) => {
    const modalOpen = [...document.querySelectorAll(".modal-backdrop")].some((node) => !node.hidden);
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      if (!els.treeModal.hidden) saveTree();
      else if (modalOpen && !els.dataModal.hidden) saveData();
      else if (!modalOpen && current) saveArticle();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && document.activeElement === els.bodyInput) {
      const key = event.key.toLowerCase();
      if (key === "b" || key === "i") {
        event.preventDefault();
        applyFormat(key === "b" ? "bold" : "italic");
        return;
      }
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      els.searchInput.focus();
      els.searchInput.select();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      checkContent();
      return;
    }
    if (event.key === "Escape") {
      for (const node of document.querySelectorAll(".modal-backdrop")) {
        if (node.hidden) continue;
        if (node.id === "treeModal") requestCloseModal(node.id);
        else node.hidden = true;
      }
    }
  });

  els.bodyInput.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") return;
    event.preventDefault();
    const start = els.bodyInput.selectionStart;
    const end = els.bodyInput.selectionEnd;
    els.bodyInput.value = `${els.bodyInput.value.slice(0, start)}  ${els.bodyInput.value.slice(end)}`;
    els.bodyInput.selectionStart = els.bodyInput.selectionEnd = start + 2;
    markDirty();
  });

  window.addEventListener("beforeunload", (event) => {
    if (!isDirty() && !treeDirty) return;
    event.preventDefault();
    event.returnValue = "";
  });
}

async function init() {
  bindEvents();
  try {
    await refreshState();
    const remembered = localStorage.getItem("distillarium.editor.article");
    const target = state.articles.find((article) => article.id === remembered) ?? state.articles[0];
    if (target) await openArticle(target.id, { force: true });
    else clearEditor();
    if (state.validation.errors.length) {
      showToast(`В контенте ошибок: ${state.validation.errors.length}. Нажмите на бейдж проверки.`, "error");
    }
  } catch (error) {
    showToast(`Не удалось загрузить состояние: ${error.message}`, "error");
    els.emptyState.hidden = false;
  }
}

init();

