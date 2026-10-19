// Хранилище локального редактора контента.
//
// Работает только с content/ репозитория distillarium-content. Никакой базы
// данных: источник правды — Markdown, JSON и Git. Все записи атомарные.
//
// Модуль намеренно не зависит от HTTP-сервера, чтобы его можно было тестировать
// отдельно и позже подключить другой интерфейс.

import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  TREE_FILE,
  TREE_SCHEMA_VERSION,
  analyzeContent,
  parseFrontmatter,
  stringifyFrontmatter,
  walkFiles,
} from "../lib/content.mjs";

export const DEFAULT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const ID_RE = /^[a-z0-9][a-z0-9/_-]*$/;
const DATA_ID_RE = /^[a-z0-9][a-z0-9_-]*$/;
const VERSION_RE = /^(\d{4})\.(\d{2})\.(\d+)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MEDIA_EXTENSIONS = new Set([".webp", ".png", ".jpg", ".jpeg"]);
const MAX_MEDIA_BYTES = 8 * 1024 * 1024;
const GENERATED_ID_PREFIX = "articles";
const TRANSLIT = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ё: "e",
  ж: "zh",
  з: "z",
  и: "i",
  й: "y",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "h",
  ц: "c",
  ч: "ch",
  ш: "sh",
  щ: "sch",
  ъ: "",
  ы: "y",
  ь: "",
  э: "e",
  ю: "yu",
  я: "ya",
  і: "i",
  ї: "yi",
  є: "ye",
  ґ: "g",
};

export class ApiError extends Error {
  constructor(status, message, details = undefined) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, text, "utf8");
  fs.renameSync(temp, file);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" && fallback !== undefined) return fallback;
    throw new ApiError(500, `${path.basename(file)}: ${error.message}`);
  }
}

function writeJson(file, value) {
  atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`);
}

function asString(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function asStringArray(value, field) {
  if (value === undefined || value === null || value === "") return [];
  if (!Array.isArray(value)) {
    throw new ApiError(400, `${field} должен быть массивом строк`);
  }
  return value.map((item) => String(item).trim()).filter(Boolean);
}

/** Теги сравниваем без учёта регистра, сохраняя первое написание. */
function uniqueTags(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = item.toLocaleLowerCase("ru");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

/** undefined — не менять размещение, [] — убрать из всех разделов. */
function optionalStringArray(value, field) {
  if (value === undefined) return null;
  return [...new Set(asStringArray(value, field))];
}

function cleanText(value) {
  return String(value ?? "").replace(/\r\n/g, "\n").trimEnd();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isValidArticleId(id) {
  if (typeof id !== "string") return false;
  const value = id.trim();
  if (!value || value.length > 160) return false;
  if (value.startsWith("/") || value.endsWith("/") || value.includes("//")) return false;
  if (!ID_RE.test(value)) return false;
  return value.split("/").every((part) => part && part !== "." && part !== "..");
}

/** Заголовок → читаемый латинский слаг для автоматического id. */
export function slugifyTitle(value) {
  const text = String(value ?? "").normalize("NFC").toLowerCase();
  let slug = "";
  for (const char of text) {
    if (/[a-z0-9]/.test(char)) {
      slug += char;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(TRANSLIT, char)) {
      slug += TRANSLIT[char];
      continue;
    }
    const plain = char.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
    slug += /^[a-z0-9]+$/.test(plain) ? plain : "-";
  }
  return slug
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
}

function assertArticleId(id) {
  if (!isValidArticleId(id)) {
    throw new ApiError(
      400,
      "id статьи: строчные латинские буквы, цифры, «-», «_» и «/»; без пустых сегментов и «..»",
    );
  }
}

function assertDataId(id, what = "id") {
  if (typeof id !== "string" || !DATA_ID_RE.test(id)) {
    throw new ApiError(400, `${what}: строчные латинские буквы, цифры, «-» и «_»`);
  }
}

function assertDate(value, field, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const text = String(value).trim();
  if (!DATE_RE.test(text)) throw new ApiError(400, `${field} должен быть в формате ГГГГ-ММ-ДД`);
  return text;
}

function normalizeLevel(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 3) {
    throw new ApiError(400, "level должен быть числом 1–3");
  }
  return number;
}

export function nextContentVersion(current) {
  const now = new Date();
  const period = `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, "0")}`;
  const match = VERSION_RE.exec(String(current ?? ""));
  if (!match) return `${period}.1`;
  if (`${match[1]}.${match[2]}` === period) {
    return `${period}.${Number(match[3]) + 1}`;
  }
  return `${period}.1`;
}

function summarize(article) {
  const data = article.data ?? {};
  return {
    id: article.id,
    title: article.title,
    short: article.short,
    category: asString(data.category),
    level: typeof data.level === "number" ? data.level : null,
    tags: Array.isArray(data.tags) ? data.tags : [],
    tech: Array.isArray(data.tech) ? data.tech : [],
    equipment: Array.isArray(data.equipment) ? data.equipment : [],
    source: asString(data.source),
    created: asString(data.created),
    updated: asString(data.updated),
    packagePath: article.packagePath,
  };
}

function normalizeArticleData(input, id, { creating }) {
  const data = { ...(input?.data ?? {}) };
  delete data.id;
  const title = asString(input?.title ?? data.title).trim();
  if (!title) throw new ApiError(400, "title не может быть пустым");

  const short = asString(input?.short ?? data.short).trim();
  const created = assertDate(input?.created ?? data.created, "created", today());
  const updated = assertDate(input?.updated ?? data.updated, "updated", today());

  const normalized = {
    ...data,
    id,
    title,
    created,
    updated,
    sources: asStringArray(input?.sources ?? data.sources ?? [], "sources"),
  };

  if (short) normalized.short = short;
  else if (creating) normalized.short = title.slice(0, 300);
  else delete normalized.short;

  const category = asString(input?.category ?? data.category).trim();
  if (category) normalized.category = category;
  else delete normalized.category;

  const level = normalizeLevel(input?.level ?? data.level);
  if (level === undefined) delete normalized.level;
  else normalized.level = level;

  for (const field of ["tech", "equipment", "tags"]) {
    let items = asStringArray(input?.[field] ?? data[field] ?? [], field);
    if (field === "tags") items = uniqueTags(items);
    if (items.length) normalized[field] = items;
    else delete normalized[field];
  }

  const source = asString(input?.source ?? data.source).trim();
  if (source) normalized.source = source;
  else if (creating) normalized.source = "manual";
  else delete normalized.source;

  if (normalized.source_slug === "") delete normalized.source_slug;
  return normalized;
}

function normalizeTree(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ApiError(400, "дерево должно быть объектом {schemaVersion, roots}");
  }
  if (!Array.isArray(input.roots)) {
    throw new ApiError(400, "roots должен быть массивом");
  }
  const seen = new Set();
  const walk = (node, where, depth) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      throw new ApiError(400, `${where}: раздел должен быть объектом`);
    }
    if (depth > 4) {
      throw new ApiError(400, `${where}: больше четырёх уровней вложенности`);
    }
    const id = asString(node.id).trim();
    if (!isValidArticleId(id)) {
      throw new ApiError(400, `${where}: некорректный id раздела`);
    }
    if (seen.has(id)) throw new ApiError(400, `дубль id раздела "${id}"`);
    seen.add(id);
    const title = asString(node.title).trim();
    if (!title) throw new ApiError(400, `${where}: пустой title раздела`);
    const articles = asStringArray(node.articles ?? [], `${where}.articles`);
    const children = node.children ?? [];
    if (!Array.isArray(children)) throw new ApiError(400, `${where}: children должен быть массивом`);
    return {
      id,
      title,
      articles,
      children: children.map((child, index) =>
        walk(child, `${where} → child ${index + 1}`, depth + 1),
      ),
    };
  };
  return {
    schemaVersion: TREE_SCHEMA_VERSION,
    roots: input.roots.map((node, index) => walk(node, `root ${index + 1}`, 1)),
  };
}

function treeSectionMap(tree) {
  const map = new Map();
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    map.set(node.id, node);
    (node.children ?? []).forEach(walk);
  };
  (tree?.roots ?? []).forEach(walk);
  return map;
}

export class ContentStore {
  constructor(root = DEFAULT_ROOT) {
    this.root = path.resolve(root);
    this.contentDir = path.join(this.root, "content");
    this.wikiDir = path.join(this.contentDir, "wiki");
    this.redirectsFile = path.join(this.contentDir, "redirects.json");
    this.versionFile = path.join(this.contentDir, "version.json");
    this.treeFile = path.join(this.contentDir, TREE_FILE);
    this.packageFile = path.join(this.root, "package.json");
  }

  articleFile(id) {
    assertArticleId(id);
    return path.join(this.wikiDir, `${id}.md`);
  }

  analyze() {
    return analyzeContent(this.contentDir);
  }

  validation() {
    const result = this.analyze();
    return {
      errors: result.errors,
      warnings: result.warnings,
      stats: result.stats,
    };
  }

  listArticles() {
    return this.analyze().articles.map(summarize).sort((a, b) => a.id.localeCompare(b.id));
  }

  readArticle(id) {
    const file = this.articleFile(id);
    if (!fs.existsSync(file)) throw new ApiError(404, `статья ${id} не найдена`);
    const parsed = parseFrontmatter(fs.readFileSync(file, "utf8"));
    const data = parsed.data;
    return {
      ...summarize({
        id,
        title: asString(data.title),
        short: asString(data.short),
        data,
        packagePath: `wiki/${id}.md`,
      }),
      data,
      body: parsed.body,
    };
  }

  writeArticle(id, data, body) {
    const file = this.articleFile(id);
    atomicWrite(file, `${stringifyFrontmatter(data)}${cleanText(body)}\n`);
    return this.validation();
  }

  nextArticleId(title, redirects = {}) {
    const slug = slugifyTitle(title) || "article";
    const base = `${GENERATED_ID_PREFIX}/${slug}`;
    const taken = (id) =>
      fs.existsSync(this.articleFile(id)) ||
      Object.prototype.hasOwnProperty.call(redirects, id);
    if (!taken(base)) return base;
    for (let index = 2; index < 10000; index += 1) {
      const candidate = `${base}-${index}`;
      if (!taken(candidate)) return candidate;
    }
    return `${base}-${Date.now()}`;
  }

  createArticle(input) {
    const title = asString(input?.title ?? input?.data?.title).trim();
    if (!title) throw new ApiError(400, "title не может быть пустым");
    const requestedId = asString(input?.id).trim();
    const redirects = readJson(this.redirectsFile, {});
    const id = requestedId || this.nextArticleId(title, redirects);
    assertArticleId(id);
    const file = this.articleFile(id);
    if (fs.existsSync(file)) throw new ApiError(409, `статья ${id} уже существует`);
    if (Object.prototype.hasOwnProperty.call(redirects, id)) {
      throw new ApiError(409, `id ${id} уже занят редиректом`);
    }
    const sections = optionalStringArray(input?.sections, "sections");
    this.assertSectionsExist(sections);
    const data = normalizeArticleData({ ...input, title }, id, { creating: true });
    this.writeArticle(id, data, input?.body ?? "");
    if (sections) this.applyArticleSections(id, sections);
    return { article: this.readArticle(id), validation: this.validation() };
  }

  updateArticle(id, input) {
    const existing = this.readArticle(id);
    const data = normalizeArticleData(
      { ...input, data: { ...existing.data, ...(input?.data ?? {}) } },
      id,
      { creating: false },
    );
    const body = input?.body === undefined ? existing.body : input.body;
    const sections = optionalStringArray(input?.sections, "sections");
    this.assertSectionsExist(sections);
    this.writeArticle(id, data, body);
    if (sections) this.applyArticleSections(id, sections);
    return { article: this.readArticle(id), validation: this.validation() };
  }

  assertSectionsExist(sections) {
    if (!sections?.length) return;
    const known = treeSectionMap(this.readTree());
    for (const sectionId of sections) {
      if (!known.has(sectionId)) {
        throw new ApiError(400, `раздел ${sectionId} не найден в дереве`);
      }
    }
  }

  /**
   * Приводит размещения статьи к списку разделов, сохраняя порядок
   * в тех разделах, где статья уже была. Пустой список убирает статью
   * из дерева, null (не передан) оставляет всё как есть.
   */
  applyArticleSections(id, sectionIds) {
    if (!Array.isArray(sectionIds)) return;
    const tree = normalizeTree(this.readTree());
    const wanted = new Set(sectionIds);
    const present = new Set();
    let changed = false;

    const walk = (node) => {
      const current = node.articles ?? [];
      const next = [];
      for (const articleId of current) {
        if (articleId !== id) {
          next.push(articleId);
          continue;
        }
        if (wanted.has(node.id) && !present.has(node.id)) {
          next.push(articleId);
          present.add(node.id);
        } else {
          changed = true;
        }
      }
      if (next.length !== current.length) changed = true;
      node.articles = next;
      (node.children ?? []).forEach(walk);
    };
    tree.roots.forEach(walk);

    const sections = treeSectionMap(tree);
    for (const sectionId of sectionIds) {
      const section = sections.get(sectionId);
      if (!section || present.has(sectionId)) continue;
      section.articles ??= [];
      section.articles.push(id);
      present.add(sectionId);
      changed = true;
    }
    if (changed) writeJson(this.treeFile, tree);
  }


  renameArticle(id, newId) {
    assertArticleId(newId);
    if (id === newId) return this.readArticle(id);
    const source = this.articleFile(id);
    const target = this.articleFile(newId);
    if (!fs.existsSync(source)) throw new ApiError(404, `статья ${id} не найдена`);
    if (fs.existsSync(target)) throw new ApiError(409, `статья ${newId} уже существует`);

    const parsed = parseFrontmatter(fs.readFileSync(source, "utf8"));
    const redirects = this.retargetRedirects(id, newId);
    delete redirects[newId];
    parsed.data.id = newId;
    parsed.data.updated = today();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    atomicWrite(target, `${stringifyFrontmatter(parsed.data)}${cleanText(parsed.body)}\n`);
    fs.unlinkSync(source);
    this.removeEmptyDirs(path.dirname(source));

    redirects[id] = newId;
    writeJson(this.redirectsFile, redirects);
    this.rewriteRecipeReferences(id, newId);
    this.updateTreeReferences(id, newId);
    return { article: this.readArticle(newId), validation: this.validation() };
  }

  deleteArticle(id, redirectTo = "") {
    assertArticleId(id);
    const file = this.articleFile(id);
    if (!fs.existsSync(file)) throw new ApiError(404, `статья ${id} не найдена`);
    const target = asString(redirectTo).trim();
    if (target) {
      assertArticleId(target);
      if (target === id) throw new ApiError(400, "нельзя перенаправить статью на саму себя");
      if (!fs.existsSync(this.articleFile(target))) {
        throw new ApiError(400, `цель редиректа ${target} не найдена`);
      }
    }
    const parsed = parseFrontmatter(fs.readFileSync(file, "utf8"));
    const title = asString(parsed.data.title).trim();
    fs.unlinkSync(file);
    this.removeEmptyDirs(path.dirname(file));
    this.updateTreeReferences(id);
    if (target) {
      const redirects = this.retargetRedirects(id, target);
      redirects[id] = target;
      writeJson(this.redirectsFile, redirects);
      this.rewriteRecipeReferences(id, target);
    } else {
      this.retargetRedirects(id);
      this.removeRecipeReferences(id);
      this.removeArticleLinks(id, title);
    }
    return { validation: this.validation() };
  }

  removeEmptyDirs(start) {
    let dir = start;
    while (dir.startsWith(this.wikiDir) && dir !== this.wikiDir) {
      if (fs.readdirSync(dir).length) break;
      fs.rmdirSync(dir);
      dir = path.dirname(dir);
    }
  }

  rewriteRecipeReferences(oldId, newId) {
    const dir = path.join(this.contentDir, "recipes");
    for (const rel of walkFiles(dir).filter((file) => file.endsWith(".json"))) {
      const file = path.join(dir, rel);
      const recipe = readJson(file);
      let changed = false;
      for (const step of Array.isArray(recipe.steps) ? recipe.steps : []) {
        if (step?.wikiId === oldId) {
          step.wikiId = newId;
          changed = true;
        }
      }
      if (changed) writeJson(file, recipe);
    }
  }

  /** Убирает ссылки на удалённую статью из шагов рецептов. */
  removeRecipeReferences(id) {
    const dir = path.join(this.contentDir, "recipes");
    for (const rel of walkFiles(dir).filter((file) => file.endsWith(".json"))) {
      const file = path.join(dir, rel);
      const recipe = readJson(file);
      let changed = false;
      for (const step of Array.isArray(recipe.steps) ? recipe.steps : []) {
        if (step?.wikiId === id) {
          delete step.wikiId;
          changed = true;
        }
      }
      if (changed) writeJson(file, recipe);
    }
  }

  /**
   * Убирает [[id]] и [[id|подпись]] из остальных статей. Без этого удаление
   * статьи оставляло бы битые ссылки и вечные ошибки проверки.
   */
  removeArticleLinks(id, fallbackLabel = "") {
    const target = escapeRegExp(id);
    const labelRe = new RegExp(`\\[\\[\\s*${target}\\s*\\|([^\\]]+)\\]\\]`, "g");
    const plainRe = new RegExp(`\\[\\[\\s*${target}\\s*\\]\\]`, "g");
    const replacement = fallbackLabel || id;
    for (const rel of walkFiles(this.wikiDir).filter((file) => file.endsWith(".md"))) {
      const file = path.join(this.wikiDir, rel);
      const parsed = parseFrontmatter(fs.readFileSync(file, "utf8"));
      let body = parsed.body;
      if (!labelRe.test(body) && !plainRe.test(body)) {
        labelRe.lastIndex = 0;
        plainRe.lastIndex = 0;
        continue;
      }
      labelRe.lastIndex = 0;
      plainRe.lastIndex = 0;
      body = body
        .replace(labelRe, (_, label) => String(label).trim())
        .replace(plainRe, () => replacement);
      parsed.data.updated = today();
      atomicWrite(file, `${stringifyFrontmatter(parsed.data)}${cleanText(body)}\n`);
    }
  }

  retargetRedirects(fromId, toId = "") {
    const redirects = readJson(this.redirectsFile, {});
    let changed = false;
    for (const [key, target] of Object.entries(redirects)) {
      if (target !== fromId || key === toId) continue;
      if (toId) redirects[key] = toId;
      else delete redirects[key];
      changed = true;
    }
    if (changed) writeJson(this.redirectsFile, redirects);
    return redirects;
  }

  readData() {
    const reference = walkFiles(path.join(this.contentDir, "reference"))
      .filter((rel) => rel.endsWith(".json"))
      .map((rel) => ({
        id: rel.slice(0, -5),
        file: `reference/${rel}`,
        data: readJson(path.join(this.contentDir, "reference", rel)),
      }));
    const recipes = walkFiles(path.join(this.contentDir, "recipes"))
      .filter((rel) => rel.endsWith(".json"))
      .map((rel) => ({
        id: rel.slice(0, -5),
        file: `recipes/${rel}`,
        data: readJson(path.join(this.contentDir, "recipes", rel)),
      }));
    return {
      version: readJson(this.versionFile, {}),
      calculators: readJson(path.join(this.contentDir, "calculators.json"), {
        schemaVersion: 1,
        items: [],
      }),
      redirects: readJson(this.redirectsFile, {}),
      reference,
      recipes,
    };
  }


  readTree() {
    return readJson(this.treeFile, {
      schemaVersion: TREE_SCHEMA_VERSION,
      roots: [],
    });
  }

  saveTree(data) {
    const tree = normalizeTree(data);
    const before = fs.existsSync(this.treeFile)
      ? fs.readFileSync(this.treeFile, "utf8")
      : null;
    writeJson(this.treeFile, tree);
    const validation = this.validation();
    const treeErrors = validation.errors.filter((item) => item.startsWith(`${TREE_FILE}:`));
    if (treeErrors.length) {
      if (before === null) fs.rmSync(this.treeFile, { force: true });
      else atomicWrite(this.treeFile, before);
      throw new ApiError(422, "дерево не прошло проверку", { errors: treeErrors });
    }
    return { tree: this.readTree(), validation };
  }

  updateTreeReferences(oldId, newId = "") {
    if (!fs.existsSync(this.treeFile)) return;
    const tree = this.readTree();
    let changed = false;
    const walk = (node) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node.articles)) {
        const next = newId
          ? node.articles.map((id) => (id === oldId ? newId : id))
          : node.articles.filter((id) => id !== oldId);
        if (next.length !== node.articles.length || next.some((id, index) => id !== node.articles[index])) {
          node.articles = next;
          changed = true;
        }
      }
      (node.children ?? []).forEach(walk);
    };
    tree.roots?.forEach(walk);
    if (changed) writeJson(this.treeFile, normalizeTree(tree));
  }

  saveReference(id, data) {
    assertDataId(id);
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new ApiError(400, "справочная таблица должна быть объектом");
    }
    if (data.id !== id) throw new ApiError(400, `id в JSON должен совпадать с именем файла: ${id}`);
    writeJson(path.join(this.contentDir, "reference", `${id}.json`), data);
    return this.validation();
  }

  saveRecipe(id, data) {
    assertDataId(id);
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new ApiError(400, "рецепт должен быть объектом");
    }
    if (data.id !== id) throw new ApiError(400, `id в JSON должен совпадать с именем файла: ${id}`);
    writeJson(path.join(this.contentDir, "recipes", `${id}.json`), data);
    return this.validation();
  }

  saveCalculators(data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new ApiError(400, "calculators.json должен быть объектом");
    }
    writeJson(path.join(this.contentDir, "calculators.json"), data);
    return this.validation();
  }

  saveRedirects(data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new ApiError(400, "redirects.json должен быть объектом");
    }
    writeJson(this.redirectsFile, data);
    return this.validation();
  }

  saveVersion(data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new ApiError(400, "version.json должен быть объектом");
    }
    if (!VERSION_RE.test(asString(data.contentVersion))) {
      throw new ApiError(400, "contentVersion должен быть в формате ГГГГ.ММ.N");
    }
    const next = {
      ...data,
      contentVersion: asString(data.contentVersion),
      released: assertDate(data.released, "released", today()),
    };
    writeJson(this.versionFile, next);
    return this.validation();
  }

  setReleaseVersion(version) {
    const value = asString(version).trim();
    if (!VERSION_RE.test(value)) throw new ApiError(400, "версия должна быть в формате ГГГГ.ММ.N");
    const versionData = readJson(this.versionFile, {});
    versionData.contentVersion = value;
    versionData.released = today();
    writeJson(this.versionFile, versionData);
    const pkg = readJson(this.packageFile, {});
    pkg.version = value;
    writeJson(this.packageFile, pkg);
    return value;
  }

  listMedia() {
    const dir = path.join(this.contentDir, "media");
    return walkFiles(dir)
      .filter((rel) => MEDIA_EXTENSIONS.has(path.extname(rel).toLowerCase()))
      .map((rel) => ({ path: `media/${rel}`, size: fs.statSync(path.join(dir, rel)).size }));
  }

  saveMedia({ name, mime, base64 }) {
    const original = path.basename(asString(name));
    const ext = path.extname(original).toLowerCase();
    if (!MEDIA_EXTENSIONS.has(ext)) {
      throw new ApiError(400, "поддерживаются WebP, PNG и JPEG");
    }
    if (typeof base64 !== "string" || !base64) throw new ApiError(400, "нет данных файла");
    const buffer = Buffer.from(base64, "base64");
    if (!buffer.length || buffer.length > MAX_MEDIA_BYTES) {
      throw new ApiError(400, "файл пустой или больше 8 МБ");
    }
    if (mime && !String(mime).startsWith("image/")) throw new ApiError(400, "ожидалась картинка");
    const dir = path.join(this.contentDir, "media");
    fs.mkdirSync(dir, { recursive: true });
    const stem =
      original
        .slice(0, -ext.length)
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "") || "image";
    let filename = `${stem}${ext}`;
    let index = 2;
    while (fs.existsSync(path.join(dir, filename))) {
      filename = `${stem}-${index}${ext}`;
      index += 1;
    }
    fs.writeFileSync(path.join(dir, filename), buffer);
    const rel = `media/${filename}`;
    return { path: rel, markdown: `![${stem}](${rel})` };
  }

  git(args, { allowFailure = false } = {}) {
    try {
      return execFileSync("git", args, {
        cwd: this.root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      }).trim();
    } catch (error) {
      const output = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim() || error.message;
      if (allowFailure) return { error: output };
      throw new ApiError(500, `git ${args.join(" ")}: ${output}`);
    }
  }

  gitState() {
    const branch = this.git(["rev-parse", "--abbrev-ref", "HEAD"], { allowFailure: true });
    const status = this.git(["status", "--porcelain"], { allowFailure: true });
    const last = this.git(["log", "-1", "--format=%h %s"], { allowFailure: true });
    const remote = this.git(["remote", "get-url", "origin"], { allowFailure: true });
    const userName = this.git(["config", "user.name"], { allowFailure: true });
    const userEmail = this.git(["config", "user.email"], { allowFailure: true });
    const dirty = typeof status === "string" ? status.split("\n").filter(Boolean) : [];
    return {
      branch: typeof branch === "string" ? branch : "—",
      lastCommit: typeof last === "string" ? last : "—",
      remote: typeof remote === "string" ? remote : "—",
      userName: typeof userName === "string" ? userName : "",
      userEmail: typeof userEmail === "string" ? userEmail : "",
      dirty,
      clean: dirty.length === 0,
    };
  }


  runNode(script) {
    const result = spawnSync(process.execPath, [path.join(this.root, "tools", script)], {
      cwd: this.root,
      encoding: "utf8",
      timeout: 120_000,
      env: { ...process.env, NO_COLOR: "1" },
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    if (result.error) {
      throw new ApiError(500, `не удалось запустить ${script}: ${result.error.message}`);
    }
    return { ok: result.status === 0, output, status: result.status };
  }

  build() {
    const build = this.runNode("build-content.mjs");
    const validate = build.ok
      ? this.runNode("validate-content.mjs")
      : { ok: false, output: "" };
    return {
      ok: build.ok && validate.ok,
      build: build.output,
      validate: validate.output,
      output: [build.output, validate.output].filter(Boolean).join("\n\n"),
    };
  }

  publish({ message, version } = {}) {
    const git = this.gitState();
    if (!git.userName || !git.userEmail) {
      throw new ApiError(
        400,
        "не настроены git user.name и user.email; выполните git config --local user.name … и git config --local user.email …",
      );
    }

    const log = [];
    let releaseVersion = "";
    let restoreReleaseFiles = () => {};
    if (version) {
      const requested = asString(version).trim();
      if (!VERSION_RE.test(requested)) {
        throw new ApiError(400, "версия должна быть в формате ГГГГ.ММ.N");
      }
      const tag = `content-${requested}`;
      if (this.git(["tag", "--list", tag])) {
        throw new ApiError(409, `тег ${tag} уже существует`);
      }
      const versionBackup = fs.existsSync(this.versionFile)
        ? fs.readFileSync(this.versionFile, "utf8")
        : null;
      const packageBackup = fs.existsSync(this.packageFile)
        ? fs.readFileSync(this.packageFile, "utf8")
        : null;
      restoreReleaseFiles = () => {
        if (versionBackup === null) fs.rmSync(this.versionFile, { force: true });
        else atomicWrite(this.versionFile, versionBackup);
        if (packageBackup === null) fs.rmSync(this.packageFile, { force: true });
        else atomicWrite(this.packageFile, packageBackup);
      };
      releaseVersion = this.setReleaseVersion(requested);
      log.push(`Версия: ${releaseVersion}`);
    }

    let built;
    try {
      built = this.build();
    } catch (error) {
      restoreReleaseFiles();
      throw error;
    }
    log.push(built.output);
    if (!built.ok) {
      restoreReleaseFiles();
      throw new ApiError(422, "сборка или валидация не прошли; публикация отменена", { log });
    }

    const commitMessage = asString(message).trim() || `Контент: обновление ${today()}`;
    this.git(["add", "-A"]);
    const staged = this.git(["diff", "--cached", "--name-only"]);
    if (staged) {
      this.git(["commit", "-m", commitMessage]);
      log.push(`Коммит: ${this.git(["log", "-1", "--format=%h %s"])}`);
    } else if (!releaseVersion) {
      log.push("Изменений нет — коммит не создан.");
    }

    const branch = this.git(["rev-parse", "--abbrev-ref", "HEAD"]);
    this.git(["push", "origin", branch]);
    log.push(`Отправлено в origin/${branch}.`);

    if (releaseVersion) {
      const tag = `content-${releaseVersion}`;
      const exists = this.git(["tag", "--list", tag]);
      if (exists) throw new ApiError(409, `тег ${tag} уже существует`);
      this.git(["tag", "-a", tag, "-m", `Пакет контента ${releaseVersion}`]);
      this.git(["push", "origin", tag]);
      log.push(`Тег ${tag} отправлен. GitHub Actions соберёт релиз.`);
    }

    return {
      ok: true,
      version: releaseVersion || this.readData().version.contentVersion,
      tag: releaseVersion ? `content-${releaseVersion}` : "",
      log: log.filter(Boolean).join("\n"),
      git: this.gitState(),
    };
  }

  state() {
    const data = this.readData();
    const analysis = this.analyze();
    const articles = analysis.articles
      .map(summarize)
      .sort((a, b) => a.id.localeCompare(b.id));
    const categories = [...new Set(articles.map((article) => article.category).filter(Boolean))].sort();
    const tags = uniqueTags(articles.flatMap((article) => article.tags))
      .sort((a, b) => a.localeCompare(b, "ru"));
    return {
      contentVersion: asString(data.version.contentVersion),
      nextVersion: nextContentVersion(data.version.contentVersion),
      articles,
      categories,
      tags,
      tree: this.readTree(),
      data,
      media: this.listMedia(),
      git: this.gitState(),
      validation: {
        errors: analysis.errors,
        warnings: analysis.warnings,
        stats: analysis.stats,
      },
    };
  }
}

