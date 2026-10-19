// Клиент локального редактора. Без фреймворков и сборки: ES-модуль,
// который работает прямо из public/.
import { extractOutline, renderMarkdown } from "./markdown.js";

const $ = (id) => document.getElementById(id);
const els = {
  versionBadge: $("versionBadge"),
  gitBadge: $("gitBadge"),
  validationBadge: $("validationBadge"),
  searchInput: $("searchInput"),
  sectionFilter: $("sectionFilter"),
  tagFilter: $("tagFilter"),
  articleList: $("articleList"),
  articleCount: $("articleCount"),
  mediaCount: $("mediaCount"),
  refreshBtn: $("refreshBtn"),
  emptyState: $("emptyState"),
  editorPane: $("editorPane"),
  articleIdInput: $("articleIdInput"),
  articlePathLabel: $("articlePathLabel"),
  titleInput: $("titleInput"),
  shortInput: $("shortInput"),
  sectionChips: $("sectionChips"),
  sectionAdd: $("sectionAdd"),
  tagChips: $("tagChips"),
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
  saveBtn: $("saveBtn"),
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
  treeShowUsed: $("treeShowUsed"),
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
let idTouched = false;
let idTimer = 0;
let idRequest = 0;
let articleSections = [];
let articleTags = [];
let sectionsDirty = false;

const DEFAULT_ARTICLE_BODY = "## Коротко\n\n## Что делать\n\n1. \n\n## Почему так\n\n";

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

/** id статьи → все разделы дерева, где она размещена. */
function treeSectionIndex(tree = state?.tree) {
  const index = new Map();
  function walk(nodes, trail) {
    for (const node of nodes ?? []) {
      const path = [...trail, node.title || "Без названия"];
      for (const articleId of node.articles ?? []) {
        if (!index.has(articleId)) {
          index.set(articleId, { sections: [] });
        }
        const item = index.get(articleId);
        item.sections.push({
          id: node.id,
          title: node.title || "Без названия",
          path: path.join(" / "),
        });
        item.id = item.sections[0].id;
        item.title = item.sections[0].title;
        item.path = item.sections[0].path;
        item.paths = item.sections.map((section) => section.path);
        item.count = item.sections.length;
      }
      walk(node.children ?? [], path);
    }
  }
  walk(tree?.roots ?? [], []);
  return index;
}

/** Плоский список разделов дерева в порядке отображения. */
function allTreeSections(tree = state?.tree) {
  const sections = [];
  function walk(nodes, trail, depth) {
    for (const node of nodes ?? []) {
      const path = [...trail, node.title || "Без названия"];
      sections.push({
        id: node.id,
        title: node.title || "Без названия",
        path: path.join(" / "),
        depth,
      });
      walk(node.children ?? [], path, depth + 1);
    }
  }
  walk(tree?.roots ?? [], [], 1);
  return sections;
}

function findSectionNode(tree, sectionId) {
  let found = null;
  function walk(nodes) {
    for (const node of nodes ?? []) {
      if (node.id === sectionId) {
        found = node;
        return;
      }
      walk(node.children ?? []);
      if (found) return;
    }
  }
  walk(tree?.roots ?? []);
  return found;
}

function tagCatalog() {
  const values = new Map();
  const add = (value) => {
    const tag = normalizeTag(value);
    if (!tag) return;
    const key = tag.toLocaleLowerCase("ru");
    if (!values.has(key)) values.set(key, tag);
  };
  for (const tag of Array.isArray(state?.tags) ? state.tags : []) add(tag);
  for (const article of state?.articles ?? []) {
    for (const tag of article.tags ?? []) add(tag);
  }
  for (const tag of articleTags) add(tag);
  return [...values.values()].sort((a, b) => a.localeCompare(b, "ru"));
}

function renderFilters() {
  const section = els.sectionFilter.value;
  const tag = els.tagFilter.value;
  els.sectionFilter.innerHTML = '<option value="">Все разделы</option>';
  for (const item of allTreeSections()) {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = item.path;
    els.sectionFilter.append(option);
  }
  const unplaced = document.createElement("option");
  unplaced.value = "__unplaced";
  unplaced.textContent = "Без раздела";
  els.sectionFilter.append(unplaced);
  els.sectionFilter.value = [...els.sectionFilter.options].some((o) => o.value === section)
    ? section
    : "";

  const tags = tagCatalog();
  els.tagFilter.innerHTML = '<option value="">Все теги</option>';
  for (const item of tags) {
    const option = document.createElement("option");
    option.value = item;
    option.textContent = item;
    els.tagFilter.append(option);
  }
  els.tagFilter.value = tags.includes(tag) ? tag : "";
}

function sameTag(left, right) {
  return String(left).toLocaleLowerCase("ru") === String(right).toLocaleLowerCase("ru");
}

function visibleArticles() {
  if (!state) return [];
  const query = els.searchInput.value.trim().toLowerCase();
  const section = els.sectionFilter.value;
  const tag = els.tagFilter.value;
  const placements = treeSectionIndex(state.tree);
  return state.articles.filter((article) => {
    const placement = placements.get(article.id);
    if (section === "__unplaced" && placement) return false;
    if (section && section !== "__unplaced" && !placement?.sections.some((item) => item.id === section)) {
      return false;
    }
    if (tag && !article.tags.some((item) => sameTag(item, tag))) return false;
    if (!query) return true;
    return [article.id, article.title, article.short, article.category, ...article.tags]
      .join(" ")
      .toLowerCase()
      .includes(query);
  });
}

let sidebarVisible = new Set();

function navArticleElement(articleId, sectionId) {
  const article = state.articles.find((item) => item.id === articleId);
  const row = document.createElement("div");
  row.className = `nav-article ${article ? "" : "missing"} ${current?.id === articleId ? "active" : ""}`.trim();
  row.dataset.navArticleId = articleId;
  row.dataset.navSectionId = sectionId;
  row.draggable = true;
  row.tabIndex = 0;
  row.setAttribute("role", "button");
  row.title = article ? `${article.title}\n${articleId}` : `Нет статьи: ${articleId}`;

  const title = document.createElement("span");
  title.className = "nav-article-title";
  title.textContent = article?.title || articleId;
  row.append(title);

  if (article?.tags?.length) {
    const tags = document.createElement("span");
    tags.className = "nav-article-tags";
    tags.textContent = article.tags.slice(0, 2).join(" · ");
    row.append(tags);
  }
  if (!article) {
    const missing = document.createElement("small");
    missing.textContent = "нет статьи";
    row.append(missing);
  }

  row.addEventListener("click", () => openArticle(articleId));
  row.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openArticle(articleId);
    }
  });
  row.addEventListener("dragstart", (event) => {
    dragState = { type: "article", id: articleId, sourceSectionId: sectionId || null };
    event.dataTransfer.effectAllowed = "copyMove";
    event.dataTransfer.setData("text/plain", articleId);
    row.classList.add("dragging");
  });
  row.addEventListener("dragend", () => {
    dragState = null;
    row.classList.remove("dragging");
    clearSidebarDropState();
  });
  return row;
}

function navSectionElement(node, depth) {
  const section = document.createElement("div");
  section.className = "nav-section";
  section.dataset.navSectionId = node.id;
  section.style.setProperty("--nav-depth", String(depth - 1));

  const head = document.createElement("div");
  head.className = "nav-section-head";
  const title = document.createElement("span");
  title.className = "nav-section-title";
  title.textContent = node.title || "Без названия";
  title.title = node.title || "";
  const count = document.createElement("span");
  count.className = "nav-section-count";
  count.textContent = String((node.articles ?? []).length);
  head.append(title, count);
  section.append(head);

  const articles = document.createElement("div");
  articles.className = "nav-section-articles";
  const placed = (node.articles ?? []).filter((articleId) => sidebarVisible.has(articleId));
  if (placed.length) {
    for (const articleId of placed) articles.append(navArticleElement(articleId, node.id));
  } else {
    const empty = document.createElement("div");
    empty.className = "nav-empty";
    empty.textContent = state.articles.length ? "пусто или скрыто фильтром" : "перетащите статью сюда";
    articles.append(empty);
  }
  section.append(articles);

  if ((node.children ?? []).length) {
    const children = document.createElement("div");
    children.className = "nav-section-children";
    for (const child of node.children) children.append(navSectionElement(child, depth + 1));
    section.append(children);
  }
  return section;
}


function renderArticleList() {
  if (!state) return;
  const articles = visibleArticles();
  sidebarVisible = new Set(articles.map((article) => article.id));
  els.articleList.innerHTML = "";
  els.articleCount.textContent = `${articles.length} / ${state.articles.length}`;

  const roots = state.tree?.roots ?? [];
  if (!roots.length) {
    const empty = document.createElement("div");
    empty.className = "nav-empty nav-empty-tree";
    empty.textContent = "В дереве пока нет разделов. Откройте «Дерево» и добавьте первый раздел.";
    els.articleList.append(empty);
  } else {
    for (const node of roots) els.articleList.append(navSectionElement(node, 1));
  }

  const placements = treeSectionIndex(state.tree);
  const unplaced = articles.filter((article) => !placements.has(article.id));
  const group = document.createElement("div");
  group.className = "nav-unplaced";
  group.dataset.navUnplaced = "1";
  const head = document.createElement("div");
  head.className = "nav-unplaced-head";
  const title = document.createElement("span");
  title.textContent = "Без раздела";
  const count = document.createElement("span");
  count.className = "nav-section-count";
  count.textContent = String(unplaced.length);
  head.append(title, count);
  group.append(head);
  if (unplaced.length) {
    for (const article of unplaced) group.append(navArticleElement(article.id, ""));
  } else {
    const empty = document.createElement("div");
    empty.className = "nav-empty";
    empty.textContent = state.articles.length ? "все статьи размещены" : "статей пока нет";
    group.append(empty);
  }
  els.articleList.append(group);
}

function clearSidebarDropState() {
  for (const element of els.articleList.querySelectorAll(".drop-before, .drop-into")) {
    element.classList.remove("drop-before", "drop-into");
  }
}

function sidebarDropContext(event) {
  const row = event.target.closest("[data-nav-article-id]");
  if (row) {
    return {
      sectionId: row.dataset.navSectionId ?? "",
      beforeId: row.dataset.navArticleId,
      element: row,
      mode: "before",
    };
  }
  const section = event.target.closest("[data-nav-section-id]");
  if (section) {
    return {
      sectionId: section.dataset.navSectionId,
      beforeId: null,
      element: section.querySelector(".nav-section-head") ?? section,
      mode: "into",
    };
  }
  const unplaced = event.target.closest("[data-nav-unplaced]");
  if (unplaced) {
    return {
      sectionId: "",
      beforeId: null,
      element: unplaced.querySelector(".nav-unplaced-head") ?? unplaced,
      mode: "into",
    };
  }
  return null;
}

function moveSidebarArticle(articleId, targetSectionId, beforeArticleId, sourceSectionId, copy) {
  const tree = cloneTree(state.tree);
  const target = targetSectionId ? findSectionNode(tree, targetSectionId) : null;
  const source = sourceSectionId ? findSectionNode(tree, sourceSectionId) : null;
  if (targetSectionId && !target) return null;

  if (!targetSectionId) {
    if (!source) return null;
    const index = source.articles.indexOf(articleId);
    if (index === -1) return null;
    source.articles.splice(index, 1);
    return tree;
  }

  const before = JSON.stringify(tree);
  const targetArticles = target.articles ?? (target.articles = []);
  const sameSection = source === target;

  if (sameSection) {
    if (copy || beforeArticleId === articleId) return null;
    const from = targetArticles.indexOf(articleId);
    if (from === -1) return null;
    const [moved] = targetArticles.splice(from, 1);
    let index = beforeArticleId ? targetArticles.indexOf(beforeArticleId) : -1;
    if (index === -1) index = targetArticles.length;
    targetArticles.splice(index, 0, moved);
  } else if (targetArticles.includes(articleId)) {
    if (copy || !source) return null;
    source.articles = source.articles.filter((id) => id !== articleId);
  } else {
    if (!copy && source) {
      source.articles = source.articles.filter((id) => id !== articleId);
    }
    let index = beforeArticleId ? targetArticles.indexOf(beforeArticleId) : -1;
    if (index === -1) index = targetArticles.length;
    targetArticles.splice(index, 0, articleId);
  }
  return before === JSON.stringify(tree) ? null : tree;
}

async function commitSidebarTree(nextTree) {
  if (!nextTree) {
    dragState = null;
    clearSidebarDropState();
    return;
  }
  try {
    const result = await api("/api/tree", {
      method: "PUT",
      body: JSON.stringify({ tree: nextTree }),
    });
    state.tree = result.tree;
    if (result.validation) state.validation = result.validation;
    renderBadges();
    renderFilters();
    renderArticleList();
    if (current) {
      if (current.isNew) renderSectionEditor();
      else if (!sectionsDirty) syncCurrentSectionsFromTree();
    }
    showToast("Дерево обновлено", "ok");
  } catch (error) {
    showToast(error.message, "error");
    renderArticleList();
  } finally {
    dragState = null;
    clearSidebarDropState();
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

function setArticleMode(isNew) {
  els.articleIdInput.readOnly = !isNew;
  els.articleIdInput.classList.toggle("new-id", isNew);
  $("renameBtn").hidden = isNew;
  $("deleteBtn").hidden = isNew;
  els.saveBtn.innerHTML = isNew
    ? "Создать <kbd>Ctrl S</kbd>"
    : "Сохранить <kbd>Ctrl S</kbd>";
}

function setArticleId(value) {
  els.articleIdInput.value = value || "";
  els.articlePathLabel.textContent = value ? `wiki/${value}.md` : "id будет создан при сохранении";
}

function renderSectionEditor() {
  if (!state) return;
  const sections = allTreeSections();
  const known = new Map(sections.map((section) => [section.id, section]));
  articleSections = [...new Set(articleSections)].filter((id) => known.has(id));

  els.sectionChips.innerHTML = "";
  if (!articleSections.length) {
    const empty = document.createElement("span");
    empty.className = "chip-empty";
    empty.textContent = "Без раздела — можно выбрать ниже";
    els.sectionChips.append(empty);
  } else {
    for (const sectionId of articleSections) {
      const chip = document.createElement("span");
      chip.className = "chip";
      const label = document.createElement("span");
      label.textContent = known.get(sectionId)?.path ?? sectionId;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "chip-remove";
      remove.textContent = "×";
      remove.title = "Убрать из этого раздела";
      remove.addEventListener("click", () => {
        articleSections = articleSections.filter((id) => id !== sectionId);
        sectionsDirty = true;
        renderSectionEditor();
        markDirty();
      });
      chip.append(label, remove);
      els.sectionChips.append(chip);
    }
  }

  els.sectionAdd.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = sections.length
    ? articleSections.length === sections.length
      ? "Все разделы уже выбраны"
      : "Добавить в раздел…"
    : "В дереве пока нет разделов";
  els.sectionAdd.append(placeholder);
  for (const section of sections) {
    if (articleSections.includes(section.id)) continue;
    const option = document.createElement("option");
    option.value = section.id;
    option.textContent = `${"— ".repeat(section.depth - 1)}${section.path}`;
    els.sectionAdd.append(option);
  }
  els.sectionAdd.disabled = sections.length === 0 || articleSections.length === sections.length;
}

function syncCurrentSectionsFromTree() {
  if (!current || current.isNew) return;
  const placement = treeSectionIndex(state.tree).get(current.id);
  articleSections = placement
    ? [...new Set(placement.sections.map((section) => section.id))]
    : [];
  sectionsDirty = false;
  renderSectionEditor();
}

function normalizeTag(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function addTagValues(value) {
  const parts = String(value ?? "")
    .split(/[,;]+/)
    .map(normalizeTag)
    .filter(Boolean);
  let changed = false;
  for (const tag of parts) {
    if (articleTags.some((item) => item.toLocaleLowerCase("ru") === tag.toLocaleLowerCase("ru"))) continue;
    articleTags.push(tag);
    changed = true;
  }
  if (!changed) return false;
  renderTagEditor();
  markDirty();
  return true;
}

function renderTagEditor() {
  els.tagChips.innerHTML = "";
  if (!articleTags.length) {
    const empty = document.createElement("span");
    empty.className = "chip-empty";
    empty.textContent = "Тегов пока нет";
    els.tagChips.append(empty);
  } else {
    for (const tag of articleTags) {
      const chip = document.createElement("span");
      chip.className = "chip chip-tag";
      const label = document.createElement("span");
      label.textContent = tag;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "chip-remove";
      remove.textContent = "×";
      remove.title = "Убрать тег";
      remove.addEventListener("click", () => {
        articleTags = articleTags.filter((item) => item !== tag);
        renderTagEditor();
        markDirty();
      });
      chip.append(label, remove);
      els.tagChips.append(chip);
    }
  }

  const datalist = $("tagOptions");
  datalist.innerHTML = "";
  for (const tag of tagCatalog()) {
    if (articleTags.some((item) => sameTag(item, tag))) continue;
    const option = document.createElement("option");
    option.value = tag;
    datalist.append(option);
  }
}

function fillForm(article) {
  const data = article.data ?? {};
  const isNew = Boolean(article.isNew);
  setArticleId(article.id);
  els.titleInput.value = article.title ?? "";
  els.shortInput.value = data.short ?? "";
  const placement = treeSectionIndex(state.tree).get(article.id);
  articleSections = placement
    ? [...new Set(placement.sections.map((section) => section.id))]
    : [];
  sectionsDirty = false;
  articleTags = Array.isArray(data.tags) ? [...data.tags] : [];
  renderSectionEditor();
  renderTagEditor();
  els.tagsInput.value = "";
  els.calcInput.value = joinList(data.calc);
  els.sourceInput.value = data.source ?? "";
  els.createdInput.value = data.created ?? "";
  els.updatedInput.value = data.updated ?? today();
  els.sourcesInput.value = Array.isArray(data.sources) ? data.sources.join("\n") : "";
  els.bodyInput.value = article.body ?? "";
  setArticleMode(isNew);
  updateWordCount();
  renderPreview();
  switchTab("write");
}

async function openArticle(id, { force = false } = {}) {
  if (!id) return;
  if (!force && isDirty() && !confirmDiscard()) return;
  try {
    const article = await api(`/api/articles/${encodeURIComponent(id)}`);
    current = { ...article, dirty: false, isNew: false };
    idTouched = false;
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
  idTouched = false;
  articleSections = [];
  articleTags = [];
  sectionsDirty = false;
  clearTimeout(idTimer);
  idRequest += 1;
  setArticleId("");
  els.tagsInput.value = "";
  els.editorPane.hidden = true;
  els.emptyState.hidden = false;
  renderArticleList();
}

function collectArticle() {
  const data = { ...(current?.data ?? {}) };
  delete data.level;
  delete data.tech;
  delete data.equipment;
  const fields = {
    short: els.shortInput.value.trim(),
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
  if (articleTags.length) data.tags = [...articleTags];
  else delete data.tags;
  return {
    id: els.articleIdInput.value.trim(),
    title: els.titleInput.value.trim(),
    data,
    body: els.bodyInput.value,
    sections: [...articleSections],
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
  if (current) {
    if (current.isNew || sectionsDirty) renderSectionEditor();
    else syncCurrentSectionsFromTree();
    renderTagEditor();
  }
  if (reloadCurrent && current && !current.isNew) {
    await openArticle(current.id, { force: true });
  }
}

const LOCAL_TRANSLIT = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh",
  з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o",
  п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "c",
  ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu",
  я: "ya", і: "i", ї: "yi", є: "ye", ґ: "g",
};

/** Резервная транслитерация, если запущенный сервер ещё не умеет /api/article-id. */
function localSlugifyTitle(value) {
  const text = String(value ?? "").normalize("NFC").toLowerCase();
  let slug = "";
  for (const char of text) {
    if (/[a-z0-9]/.test(char)) slug += char;
    else if (Object.prototype.hasOwnProperty.call(LOCAL_TRANSLIT, char)) slug += LOCAL_TRANSLIT[char];
    else {
      const plain = char.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
      slug += /^[a-z0-9]+$/.test(plain) ? plain : "-";
    }
  }
  return slug.replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 80).replace(/-+$/g, "");
}

function isValidLocalArticleId(id) {
  if (typeof id !== "string") return false;
  const value = id.trim();
  if (!value || value.length > 160) return false;
  if (value.startsWith("/") || value.endsWith("/") || value.includes("//")) return false;
  if (!/^[a-z0-9][a-z0-9/_-]*$/.test(value)) return false;
  return value.split("/").every((part) => part && part !== "." && part !== "..");
}

function localNextArticleId(title) {
  const slug = localSlugifyTitle(title) || "article";
  const base = `articles/${slug}`;
  const redirects = state?.data?.redirects ?? {};
  const taken = (id) =>
    (state?.articles ?? []).some((article) => article.id === id) ||
    Object.prototype.hasOwnProperty.call(redirects, id);
  if (!taken(base)) return base;
  for (let index = 2; index < 10000; index += 1) {
    const candidate = `${base}-${index}`;
    if (!taken(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

async function requestArticleId(title) {
  try {
    const result = await api(`/api/article-id?title=${encodeURIComponent(title)}`);
    if (result?.id) return result.id;
  } catch {
    // Старый сервер без маршрута: ниже сгенерируем id в браузере.
  }
  return localNextArticleId(title);
}

async function saveArticle() {
  if (!current) return;
  const pendingTag = els.tagsInput.value.trim();
  if (pendingTag) {
    addTagValues(pendingTag);
    els.tagsInput.value = "";
  }
  const payload = collectArticle();
  if (!payload.title) {
    showToast("Заголовок не может быть пустым", "error");
    els.titleInput.focus();
    return;
  }
  els.saveBtn.disabled = true;
  els.saveState.textContent = "сохраняю…";
  try {
    if (!payload.id) {
      payload.id = await requestArticleId(payload.title);
      setArticleId(payload.id);
    }
    if (!isValidLocalArticleId(payload.id)) {
      els.saveState.textContent = "не сохранено";
      showToast("id: строчные латинские буквы, цифры, «-», «_» и «/»", "error");
      els.articleIdInput.focus();
      return;
    }
    if (current.isNew) {
      const created = await api("/api/articles", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      sectionsDirty = false;
      await refreshState();
      await openArticle(created.article.id, { force: true });
      showToast("Статья создана", "ok");
      return;
    }
    const result = await api(`/api/articles/${encodeURIComponent(current.id)}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    current = { ...result.article, dirty: false, isNew: false };
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
  } finally {
    els.saveBtn.disabled = false;
  }
}

function suggestedArticleId() {
  if (!current?.isNew || idTouched) return;
  clearTimeout(idTimer);
  const title = els.titleInput.value.trim();
  const request = ++idRequest;
  if (!title) {
    setArticleId("");
    return;
  }
  idTimer = setTimeout(async () => {
    const id = await requestArticleId(title);
    if (request !== idRequest || !current?.isNew || idTouched) return;
    setArticleId(id);
  }, 200);
}

function createArticle() {
  if (!confirmDiscard()) return;
  current = {
    id: "",
    title: "",
    isNew: true,
    dirty: false,
    data: { source: "manual", created: today(), updated: today(), sources: [] },
    body: DEFAULT_ARTICLE_BODY,
  };
  idTouched = false;
  fillForm(current);
  baseline = JSON.stringify(collectArticle());
  setDirty(false);
  els.saveState.textContent = "новая статья";
  els.emptyState.hidden = true;
  els.editorPane.hidden = false;
  localStorage.removeItem("distillarium.editor.article");
  renderArticleList();
  els.titleInput.focus();
}

async function renameArticle() {
  if (!current) return;
  const newId = prompt("Новый id статьи (технический адрес):", current.id);
  if (!newId || newId.trim() === current.id) return;
  if (!confirm(`Изменить id ${current.id} → ${newId.trim()}? Старый id станет редиректом.`)) return;
  try {
    const result = await api(`/api/articles/${encodeURIComponent(current.id)}/rename`, {
      method: "POST",
      body: JSON.stringify({ newId: newId.trim() }),
    });
    current = { ...result.article, dirty: false };
    await refreshState();
    await openArticle(result.article.id, { force: true });
    showToast(`Новый id: ${result.article.id}`, "ok");
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function deleteArticle() {
  if (!current) return;
  if (!confirm(`Удалить статью «${current.title || current.id}»? Её размещения в дереве и ссылки на неё будут очищены.`)) return;
  const redirect = prompt(
    "Куда перенаправить старые ссылки? Оставьте пустым, чтобы удалить ссылки и wikiId из рецептов.",
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

function treePlacementCount() {
  let count = 0;
  walkTree(treeDraft?.roots ?? [], (node) => {
    count += (node.articles ?? []).length;
  });
  return count;
}

function allArticlesForTree() {
  return [...state.articles].sort((a, b) =>
    (a.title || a.id).localeCompare(b.title || b.id, "ru"),
  );
}

function unplacedArticles() {
  const placed = treePlacedIds();
  return allArticlesForTree().filter((article) => !placed.has(article.id));
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


const CATEGORY_TITLES = {
  ingredienty: "Сырье",
  oborudovanie: "Оборудование",
  pivo: "Пивоварение",
  "problemy-i-resheniya": "Проблемы",
  retsepty: "Рецепты",
  samogon: "Самогоноварение",
  spravochnik: "Справочник",
  tehnologii: "Технологии",
  vino: "Виноделие",
};

function categorySectionTitle(category) {
  const key = String(category ?? "").trim().toLowerCase();
  if (!key) return "Без категории";
  if (CATEGORY_TITLES[key]) return CATEGORY_TITLES[key];
  return key
    .replace(/[-_]+/g, " ")
    .replace(/^./, (letter) => letter.toUpperCase());
}

/**
 * Переносит старые категории в редактируемое дерево: недостающие разделы
 * создаются, статьи раскладываются по разделам с тем же названием.
 */
function seedTreeFromCategories() {
  if (!treeDraft) return;
  const unplaced = unplacedArticles();
  if (!unplaced.length) {
    showToast("Все статьи уже размещены в дереве", "ok");
    return;
  }
  if (!confirm(
    `Разложить ${unplaced.length} статей по категориям? ` +
      "Недостающие разделы будут добавлены в дерево, существующие разделы " +
      "с тем же названием будут использованы.",
  )) {
    return;
  }

  const byTitle = new Map();
  walkTree(treeDraft.roots, (node) => {
    const key = String(node.title ?? "").trim().toLowerCase();
    if (key && !byTitle.has(key)) byTitle.set(key, node);
  });

  let created = 0;
  let placed = 0;
  for (const article of unplaced) {
    const title = categorySectionTitle(article.category);
    const key = title.toLowerCase();
    let section = byTitle.get(key);
    if (!section) {
      section = {
        id: treeNewId(""),
        title,
        articles: [],
        children: [],
      };
      treeDraft.roots.push(section);
      byTitle.set(key, section);
      created += 1;
    }
    section.articles = section.articles ?? [];
    if (!section.articles.includes(article.id)) {
      section.articles.push(article.id);
      placed += 1;
    }
  }

  treeDirtyState(true);
  renderTreeEditor();
  showToast(
    `Разложено статей: ${placed}; добавлено разделов: ${created}. Проверьте структуру и сохраните.`,
    "ok",
  );
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

/**
 * Перетаскивание из списка «Без раздела» добавляет ещё одно размещение.
 * Перетаскивание чипа внутри дерева переносит именно это размещение.
 */
function placeArticleInSection(articleId, sectionId, beforeArticleId = null, sourceSectionId = null) {
  const target = findTreeSection(sectionId);
  if (!target) return false;
  const targetArticles = target.node.articles ?? (target.node.articles = []);
  const source = sourceSectionId ? findTreeSection(sourceSectionId) : null;
  const isSameSection = Boolean(source && source.node.id === target.node.id);

  if (isSameSection) {
    const from = targetArticles.indexOf(articleId);
    if (from === -1) return false;
    if (!beforeArticleId || beforeArticleId === articleId) return false;
    const [moved] = targetArticles.splice(from, 1);
    let index = targetArticles.indexOf(beforeArticleId);
    if (index === -1) index = targetArticles.length;
    targetArticles.splice(index, 0, moved);
  } else {
    if (targetArticles.includes(articleId)) return false;
    if (source) {
      source.node.articles = (source.node.articles ?? []).filter((id) => id !== articleId);
    }
    let index = beforeArticleId ? targetArticles.indexOf(beforeArticleId) : -1;
    if (index === -1) index = targetArticles.length;
    targetArticles.splice(index, 0, articleId);
  }

  treeDirtyState(true);
  renderTreeEditor();
  return true;
}

function unplaceArticle(articleId, sectionId = "") {
  if (!sectionId) return;
  const found = findTreeSection(sectionId);
  if (!found) return;
  const before = (found.node.articles ?? []).length;
  found.node.articles = (found.node.articles ?? []).filter((id) => id !== articleId);
  if ((found.node.articles ?? []).length === before) return;
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
  const placement = treeSectionIndex(treeDraft).get(articleId);
  chip.title = article
    ? `${article.title} · ${articleId}${placement ? `\n${placement.paths.join("\n")}` : ""}`
    : `Нет статьи: ${articleId}`;
  const label = document.createElement("span");
  label.className = "tree-article-label";
  label.textContent = article?.title || articleId;
  chip.append(label);
  if (!article) {
    const missing = document.createElement("small");
    missing.textContent = "нет статьи";
    chip.append(missing);
  } else if (!sectionId && placement) {
    const used = document.createElement("small");
    used.className = "tree-article-used";
    used.textContent = `×${placement.count}`;
    chip.append(used);
  }

  chip.addEventListener("dragstart", (event) => {
    dragState = { type: "article", id: articleId, sourceSectionId: sectionId || null };
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
      unplaceArticle(articleId, sectionId);
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
    placeArticleInSection(
      dragState.id,
      wrapper.dataset.sectionId,
      wrapper.dataset.articleId,
      dragState.sourceSectionId,
    );
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
      placeArticleInSection(dragState.id, node.id, null, dragState.sourceSectionId);
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
  els.treeSummary.textContent = `${treeSectionCount()} разделов · размещено ${placed.size} из ${state.articles.length} статей · размещений ${treePlacementCount()}`;
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
  const listed = els.treeShowUsed.checked ? allArticlesForTree() : unplaced;
  els.treeUnplacedCount.textContent = els.treeShowUsed.checked
    ? `${unplaced.length} без раздела / ${listed.length} всего`
    : unplaced.length
      ? `${unplaced.length}`
      : "нет";
  els.treeUnplaced.innerHTML = "";
  if (!listed.length) {
    const empty = document.createElement("div");
    empty.className = "tree-empty";
    empty.textContent = state.articles.length ? "Все статьи размещены." : "В контенте пока нет статей.";
    els.treeUnplaced.append(empty);
  } else {
    for (const article of listed) {
      const element = treeArticleElement(article.id, "", false);
      element.classList.add("unplaced-article");
      if (placed.has(article.id)) element.classList.add("used-article");
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
    if (dragState.sourceSectionId) {
      unplaceArticle(dragState.id, dragState.sourceSectionId);
    }
    dragState = null;
  });
  els.treeShowUsed.addEventListener("change", renderTreeEditor);
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
  for (const input of [
    els.titleInput,
    els.shortInput,
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

  els.titleInput.addEventListener("input", suggestedArticleId);
  els.articleIdInput.addEventListener("input", () => {
    if (!current?.isNew) return;
    idTouched = Boolean(els.articleIdInput.value.trim());
    if (idTouched) setArticleId(els.articleIdInput.value.trim());
    else suggestedArticleId();
    markDirty();
  });

  els.sectionAdd.addEventListener("change", () => {
    const sectionId = els.sectionAdd.value;
    if (!sectionId || articleSections.includes(sectionId)) return;
    articleSections.push(sectionId);
    sectionsDirty = true;
    renderSectionEditor();
    markDirty();
  });

  const commitTagInput = () => {
    if (!els.tagsInput.value.trim()) return;
    addTagValues(els.tagsInput.value);
    els.tagsInput.value = "";
  };
  els.tagsInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      commitTagInput();
      return;
    }
    if (event.key === "Backspace" && !els.tagsInput.value && articleTags.length) {
      articleTags.pop();
      renderTagEditor();
      markDirty();
    }
  });
  els.tagsInput.addEventListener("change", commitTagInput);

  els.articleList.addEventListener("dragover", (event) => {
    if (dragState?.type !== "article") return;
    const context = sidebarDropContext(event);
    if (!context) return;
    event.preventDefault();
    event.stopPropagation();
    clearSidebarDropState();
    context.element.classList.add(context.mode === "before" ? "drop-before" : "drop-into");
    event.dataTransfer.dropEffect = event.ctrlKey || event.metaKey ? "copy" : "move";
  });
  els.articleList.addEventListener("dragleave", (event) => {
    if (!els.articleList.contains(event.relatedTarget)) clearSidebarDropState();
  });
  els.articleList.addEventListener("drop", (event) => {
    if (dragState?.type !== "article") return;
    const context = sidebarDropContext(event);
    if (!context) return;
    event.preventDefault();
    event.stopPropagation();
    const sourceSectionId = dragState.sourceSectionId;
    const articleId = dragState.id;
    const copy = event.ctrlKey || event.metaKey;
    clearSidebarDropState();
    const next = moveSidebarArticle(
      articleId,
      context.sectionId,
      context.beforeId,
      sourceSectionId,
      copy,
    );
    void commitSidebarTree(next);
  });

  els.searchInput.addEventListener("input", renderArticleList);
  els.sectionFilter.addEventListener("change", renderArticleList);
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
  $("treeSeedBtn").addEventListener("click", seedTreeFromCategories);
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

