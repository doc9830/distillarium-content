// Общая библиотека конвейера контента: разбор Markdown, проверки, индекс поиска.
// Зависимостей нет — только Node.js. Контент не выполняет код: читаем только
// frontmatter и текст Markdown.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const SCHEMA_VERSION = 1;
export const TREE_SCHEMA_VERSION = 1;
export const TREE_FILE = "tree.json";
export const REQUIRED_FIELDS = ["id", "title", "short"];
export const FRONTMATTER_ORDER = [
  "id",
  "title",
  "short",
  "category",
  "level",
  "tech",
  "equipment",
  "tags",
  "created",
  "updated",
  "sources",
  "calc",
  "source",
  "source_slug",
];

export const POSIX = path.posix;

export function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

export function fileSha256(file) {
  return sha256(fs.readFileSync(file));
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КиБ`;
  return `${(bytes / 1024 / 1024).toFixed(2)} МиБ`;
}

export function toPosix(value) {
  return value.split(path.sep).join("/");
}

/** Все файлы каталога рекурсивно, пути относительно base, отсортированы. */
export function walkFiles(dir, base = dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(full, base));
    } else if (entry.isFile()) {
      out.push(toPosix(path.relative(base, full)));
    }
  }
  return out.sort();
}

export function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Frontmatter: поддерживаем подмножество YAML, которое использует проект.
// ---------------------------------------------------------------------------

function unquote(value) {
  const text = value.trim();
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    if (text.startsWith('"')) {
      try {
        return JSON.parse(text);
      } catch {
        return text.slice(1, -1);
      }
    }
    return text.slice(1, -1);
  }
  return text;
}

export function parseFrontmatter(text) {
  const source = text.replace(/^\uFEFF/, "");
  const lines = source.split("\n");
  if (lines[0]?.trim() !== "---") {
    return { data: {}, body: source, hasFrontmatter: false };
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) {
    return { data: {}, body: source, hasFrontmatter: false };
  }

  const data = {};
  const fmLines = lines.slice(1, end);
  for (let i = 0; i < fmLines.length; i++) {
    const line = fmLines[i];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1];
    const rawValue = match[2].trim();

    if (rawValue === "") {
      const items = [];
      let j = i + 1;
      while (j < fmLines.length) {
        const item = /^\s+-\s+(.*)$/.exec(fmLines[j]);
        if (!item) break;
        items.push(unquote(item[1].trim()));
        j++;
      }
      if (items.length) {
        data[key] = items;
        i = j - 1;
      } else {
        data[key] = "";
      }
      continue;
    }

    if (rawValue.startsWith("[")) {
      try {
        const parsed = JSON.parse(rawValue);
        data[key] = Array.isArray(parsed) ? parsed : rawValue;
      } catch {
        data[key] = rawValue
          .replace(/^\[|\]$/g, "")
          .split(",")
          .map((part) => unquote(part))
          .filter((part) => part !== "");
      }
      continue;
    }

    if (rawValue === "null" || rawValue === "~") {
      data[key] = null;
    } else if (rawValue === "true" || rawValue === "false") {
      data[key] = rawValue === "true";
    } else if (/^-?\d+(\.\d+)?$/.test(rawValue)) {
      data[key] = Number(rawValue);
    } else {
      data[key] = unquote(rawValue);
    }
  }

  const body = lines
    .slice(end + 1)
    .join("\n")
    .replace(/^\n+/, "")
    .replace(/\s+$/, "");

  return { data, body, hasFrontmatter: true };
}

function needsQuotes(value) {
  if (value === "") return true;
  if (/^\s|\s$/.test(value)) return true;
  if (/[:#\[\]{}&*!|>'"%@`,]/.test(value)) return true;
  if (/^(true|false|null|~|-?\d+(\.\d+)?)$/.test(value)) return true;
  return false;
}

export function stringifyFrontmatter(data, order = FRONTMATTER_ORDER) {
  const keys = [
    ...order.filter((key) => Object.prototype.hasOwnProperty.call(data, key)),
    ...Object.keys(data).filter((key) => !order.includes(key)),
  ];
  const lines = ["---"];
  for (const key of keys) {
    const value = data[key];
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    } else if (value === null) {
      lines.push(`${key}: null`);
    } else if (typeof value === "number" || typeof value === "boolean") {
      lines.push(`${key}: ${value}`);
    } else if (typeof value === "string" && needsQuotes(value)) {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push("---", "");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Текст: короткое описание, оглавление, plain text для индекса.
// ---------------------------------------------------------------------------

export function stripMarkdown(text) {
  return text
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/^>\s?/gm, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/^:::.*$/gm, "")
    .replace(/^==.*==$/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function clip(text, limit = 300) {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut).trim()}…`;
}

function sectionText(body, title) {
  const lines = body.split("\n");
  const wanted = title.trim().toLowerCase();
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const match = /^(#{1,6})\s+(.*)$/.exec(lines[i]);
    if (!match) continue;
    if (match[2].trim().toLowerCase() === wanted) {
      start = i + 1;
      level = match[1].length;
      break;
    }
  }
  if (start === -1) return "";
  const collected = [];
  for (let i = start; i < lines.length; i++) {
    const match = /^(#{1,6})\s+/.exec(lines[i]);
    if (match && match[1].length <= level) break;
    collected.push(lines[i]);
  }
  return collected.join("\n");
}

export function deriveShort(data, body) {
  const fromFrontmatter = typeof data.short === "string" ? data.short.trim() : "";
  if (fromFrontmatter) return clip(stripMarkdown(fromFrontmatter));

  const shortSection = sectionText(body, "Коротко");
  if (shortSection.trim()) {
    const paragraphs = shortSection
      .split(/\n\s*\n/)
      .map((part) => part.trim())
      .filter(Boolean);
    for (const paragraph of paragraphs) {
      if (/^(>|:::|-|\*|\d+\.|\|)/.test(paragraph)) continue;
      const text = stripMarkdown(paragraph);
      if (text) return clip(text);
    }
  }

  const paragraphs = body
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean);
  for (const paragraph of paragraphs) {
    if (/^(#|:::|==|\||>)/.test(paragraph)) continue;
    const text = stripMarkdown(paragraph);
    if (text.length >= 20) return clip(text);
  }
  return "";
}

export function extractHeadings(body) {
  const headings = [];
  for (const line of body.split("\n")) {
    const match = /^(#{2,6})\s+(.+)$/.exec(line);
    if (match) headings.push(stripMarkdown(match[2]).trim());
  }
  return headings;
}

export function plainText(body) {
  return stripMarkdown(body);
}

// ---------------------------------------------------------------------------
// Загрузка контента и проверки
// ---------------------------------------------------------------------------

function checkStringArray(value, field, where, errors) {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    errors.push(`${where}: поле ${field} должно быть массивом строк`);
  }
}

function loadArticles(contentDir, errors, warnings) {
  const wikiDir = path.join(contentDir, "wiki");
  const files = walkFiles(wikiDir).filter((rel) => rel.endsWith(".md"));
  if (!files.length) {
    warnings.push("content/wiki: статей пока нет");
    return [];
  }

  const articles = [];
  for (const rel of files) {
    const where = `wiki/${rel}`;
    const raw = fs.readFileSync(path.join(wikiDir, rel), "utf8");
    const parsed = parseFrontmatter(raw);
    if (!parsed.hasFrontmatter) {
      errors.push(`${where}: нет frontmatter (нужен блок --- … ---)`);
    }
    const data = parsed.data;
    const id = typeof data.id === "string" ? data.id.trim() : "";
    const expectedId = rel.slice(0, -".md".length);
    if (!id) {
      errors.push(`${where}: пустой обязательный id`);
    } else if (id !== expectedId) {
      errors.push(
        `${where}: id "${id}" не совпадает с путём; ожидался "${expectedId}"`,
      );
    }

    const title = typeof data.title === "string" ? data.title.trim() : "";
    if (!title) errors.push(`${where}: пустой обязательный title`);

    const short = deriveShort(data, parsed.body);
    if (!short) errors.push(`${where}: пустой обязательный short (не выводится из текста)`);

    for (const field of ["tech", "equipment", "tags", "sources", "calc"]) {
      checkStringArray(data[field], field, where, errors);
    }
    if (
      data.level !== undefined &&
      (typeof data.level !== "number" || data.level < 1 || data.level > 3)
    ) {
      errors.push(`${where}: level должен быть числом 1–3`);
    }
    if (data.sources === undefined) {
      errors.push(`${where}: нет поля sources (пустой массив допустим)`);
    }

    articles.push({
      id,
      rel,
      packagePath: `wiki/${rel}`,
      fullPath: path.join(wikiDir, rel),
      data,
      body: parsed.body,
      title,
      short,
    });
  }
  return articles;
}

function loadRedirects(contentDir, errors) {
  const file = path.join(contentDir, "redirects.json");
  if (!fs.existsSync(file)) {
    errors.push("redirects.json: файл не найден");
    return {};
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    errors.push(`redirects.json: не разбирается как JSON (${error.message})`);
    return {};
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    errors.push("redirects.json: ожидался объект {старый адрес: id}");
    return {};
  }
  for (const [key, value] of Object.entries(data)) {
    if (!key.trim() || typeof value !== "string" || !value.trim()) {
      errors.push(`redirects.json: некорректная запись "${key}"`);
    }
  }
  return data;
}

/** Индекс объектов вне вики: справочники, рецепты, калькуляторы. */
function loadTypedObjects(contentDir, errors) {
  const objects = {
    reference: new Set(),
    recipe: new Set(),
    calc: new Set(),
    recipes: [],
  };
  const referenceTables = [];
  const recipeTemplates = [];

  const addObjects = (parsed, where, target) => {
    const add = (value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        errors.push(`${where}: элемент должен быть объектом с полем id`);
        return;
      }
      if (typeof value.id !== "string" || !value.id.trim()) {
        errors.push(`${where}: у объекта нет строкового id`);
        return;
      }
      target.add(value.id.trim());
    };
    if (Array.isArray(parsed)) {
      parsed.forEach(add);
    } else if (parsed && typeof parsed === "object" && Array.isArray(parsed.items)) {
      if (typeof parsed.id === "string") add(parsed);
      parsed.items.forEach(add);
    } else {
      add(parsed);
    }
  };

  const validateReference = (data, where, expectedId) => {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      errors.push(`${where}: ожидался объект справочной таблицы`);
      return;
    }
    if (typeof data.id !== "string" || !data.id.trim()) {
      errors.push(`${where}: у таблицы нет строкового id`);
    } else if (data.id.trim() !== expectedId) {
      errors.push(`${where}: id "${data.id}" не совпадает с именем файла "${expectedId}"`);
    }
    if (typeof data.title !== "string" || !data.title.trim()) {
      errors.push(`${where}: пустой title`);
    }
    if (typeof data.short !== "string" || !data.short.trim()) {
      errors.push(`${where}: пустой short`);
    }
    if (!Array.isArray(data.columns) || data.columns.length === 0) {
      errors.push(`${where}: нужен непустой массив columns`);
      return;
    }
    const keys = new Set();
    data.columns.forEach((column, index) => {
      if (!column || typeof column !== "object" || Array.isArray(column)) {
        errors.push(`${where}: колонка ${index + 1} должна быть объектом`);
        return;
      }
      if (typeof column.key !== "string" || !column.key.trim()) {
        errors.push(`${where}: у колонки ${index + 1} нет key`);
        return;
      }
      if (keys.has(column.key)) {
        errors.push(`${where}: дубль колонки ${column.key}`);
      }
      keys.add(column.key);
      if (typeof column.title !== "string" || !column.title.trim()) {
        errors.push(`${where}: у колонки ${column.key} нет title`);
      }
    });
    if (!Array.isArray(data.rows) || data.rows.length === 0) {
      errors.push(`${where}: нужен непустой массив rows`);
      return;
    }
    data.rows.forEach((row, index) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        errors.push(`${where}: строка ${index + 1} должна быть объектом`);
        return;
      }
      for (const key of keys) {
        if (!(key in row)) {
          errors.push(`${where}: в строке ${index + 1} нет колонки ${key}`);
        }
      }
    });
    if (data.calc !== undefined && typeof data.calc !== "string") {
      errors.push(`${where}: calc должен быть строкой с id калькулятора`);
    }
    referenceTables.push({ where, calc: data.calc });
  };

  for (const rel of walkFiles(path.join(contentDir, "reference"))) {
    if (!rel.endsWith(".json")) continue;
    const full = path.join(contentDir, "reference", rel);
    const expectedId = rel.slice(0, -".json".length);
    try {
      const parsed = JSON.parse(fs.readFileSync(full, "utf8"));
      validateReference(parsed, `reference/${rel}`, expectedId);
      addObjects(parsed, `reference/${rel}`, objects.reference);
    } catch (error) {
      errors.push(`reference/${rel}: не разбирается как JSON (${error.message})`);
    }
  }

  const validateRecipe = (data, where, expectedId) => {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      errors.push(`${where}: ожидался объект шаблона рецепта`);
      return;
    }
    if (typeof data.id !== "string" || !data.id.trim()) {
      errors.push(`${where}: у рецепта нет строкового id`);
    } else if (data.id.trim() !== expectedId) {
      errors.push(`${where}: id "${data.id}" не совпадает с именем файла "${expectedId}"`);
    }
    if (typeof data.title !== "string" || !data.title.trim()) {
      errors.push(`${where}: пустой title`);
    }
    if (typeof data.short !== "string" || !data.short.trim()) {
      errors.push(`${where}: пустой short`);
    }
    if (!["distillate", "wine", "beer", "other"].includes(data.type)) {
      errors.push(`${where}: type должен быть distillate, wine, beer или other`);
    }
    if (typeof data.volume !== "number" || !Number.isFinite(data.volume) || data.volume <= 0) {
      errors.push(`${where}: volume должен быть положительным числом`);
    }
    if (data.expected !== undefined) {
      if (!data.expected || typeof data.expected !== "object" || Array.isArray(data.expected)) {
        errors.push(`${where}: expected должен быть объектом`);
      } else {
        for (const field of ["volume", "abv"]) {
          if (
            data.expected[field] !== undefined &&
            (typeof data.expected[field] !== "number" || data.expected[field] <= 0)
          ) {
            errors.push(`${where}: expected.${field} должен быть положительным числом`);
          }
        }
        if (data.expected.note !== undefined && typeof data.expected.note !== "string") {
          errors.push(`${where}: expected.note должен быть строкой`);
        }
      }
    }
    if (data.ingredients !== undefined) {
      if (!Array.isArray(data.ingredients)) {
        errors.push(`${where}: ingredients должен быть массивом`);
      } else {
        data.ingredients.forEach((item, index) => {
          if (!item || typeof item !== "object" || Array.isArray(item)) {
            errors.push(`${where}: ингредиент ${index + 1} должен быть объектом`);
            return;
          }
          if (typeof item.name !== "string" || !item.name.trim()) {
            errors.push(`${where}: у ингредиента ${index + 1} нет name`);
          }
          if (typeof item.amount !== "string" || !item.amount.trim()) {
            errors.push(`${where}: у ингредиента ${index + 1} нет amount`);
          }
        });
      }
    }
    if (!Array.isArray(data.steps) || data.steps.length === 0) {
      errors.push(`${where}: нужен непустой массив steps`);
      return;
    }
    data.steps.forEach((step, index) => {
      if (!step || typeof step !== "object" || Array.isArray(step)) {
        errors.push(`${where}: шаг ${index + 1} должен быть объектом`);
        return;
      }
      if (typeof step.title !== "string" || !step.title.trim()) {
        errors.push(`${where}: у шага ${index + 1} нет title`);
      }
      if (
        step.afterDays !== undefined &&
        (!Number.isInteger(step.afterDays) || step.afterDays < 0)
      ) {
        errors.push(`${where}: afterDays шага ${index + 1} должен быть целым числом ≥ 0`);
      }
      if (step.wikiId !== undefined && (typeof step.wikiId !== "string" || !step.wikiId.trim())) {
        errors.push(`${where}: wikiId шага ${index + 1} должен быть непустой строкой`);
      }
    });
    recipeTemplates.push({ where, data });
  };

  for (const rel of walkFiles(path.join(contentDir, "recipes"))) {
    if (!rel.endsWith(".json")) continue;
    const full = path.join(contentDir, "recipes", rel);
    const expectedId = rel.slice(0, -".json".length);
    try {
      const parsed = JSON.parse(fs.readFileSync(full, "utf8"));
      validateRecipe(parsed, `recipes/${rel}`, expectedId);
      addObjects(parsed, `recipes/${rel}`, objects.recipe);
    } catch (error) {
      errors.push(`recipes/${rel}: не разбирается как JSON (${error.message})`);
    }
  }

  const calcFile = path.join(contentDir, "calculators.json");
  if (fs.existsSync(calcFile)) {
    try {
      addObjects(JSON.parse(fs.readFileSync(calcFile, "utf8")), "calculators.json", objects.calc);
    } catch (error) {
      errors.push(`calculators.json: не разбирается как JSON (${error.message})`);
    }
  }

  for (const table of referenceTables) {
    if (typeof table.calc === "string" && !objects.calc.has(table.calc)) {
      errors.push(`${table.where}: calc "${table.calc}" не найден в calculators.json`);
    }
  }
  objects.recipes = recipeTemplates;
  return objects;
}

function resolveLink(target, ids, redirects, objects) {
  if (target.startsWith("calc:")) {
    return objects.calc.has(target.slice("calc:".length));
  }
  if (target.startsWith("ref:")) {
    const key = target.slice("ref:".length);
    return objects.reference.has(key) || ids.has(`reference/${key}`);
  }
  if (target.startsWith("recipe:")) {
    const key = target.slice("recipe:".length);
    return objects.recipe.has(key) || ids.has(`recipes/${key}`);
  }
  if (target.startsWith("/articles/")) {
    return Object.prototype.hasOwnProperty.call(redirects, target);
  }
  if (ids.has(target)) return true;
  if (Object.prototype.hasOwnProperty.call(redirects, target)) return true;
  if (Object.prototype.hasOwnProperty.call(redirects, `/articles/${target}`)) return true;
  return false;
}

function checkMedia(article, contentDir, errors) {
  const imageRe = /!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g;
  for (const match of article.body.matchAll(imageRe)) {
    const rawUrl = match[2];
    if (/^(https?:|data:|\/\/)/i.test(rawUrl)) {
      errors.push(`${article.packagePath}: внешняя картинка запрещена (${rawUrl})`);
      continue;
    }
    let url;
    try {
      url = decodeURIComponent(rawUrl);
    } catch {
      url = rawUrl;
    }
    if (url.split("/").includes("..")) {
      errors.push(`${article.packagePath}: путь картинки выходит за пределы пакета (${rawUrl})`);
      continue;
    }
    const clean = url.replace(/^\.\//, "");
    const candidates = url.startsWith("/")
      ? [clean.replace(/^\/+/, "")]
      : [
          POSIX.normalize(POSIX.join(POSIX.dirname(article.packagePath), clean)),
          POSIX.normalize(clean),
        ];
    if (!candidates.some((rel) => fs.existsSync(path.join(contentDir, rel)))) {
      errors.push(`${article.packagePath}: не найдена картинка ${rawUrl}`);
    }
  }
}

const TREE_ID_RE = /^[a-z0-9][a-z0-9/_-]*$/;

/**
 * Дерево навигации хранится отдельно от статей, чтобы:
 * - менять разделы и порядок, не переименовывая id статей;
 * - держать в дереве произвольные названия, а не только слаг пути;
 * - разрешить редактору быть настоящим конструктором.
 *
 * articles — массив id статей. Одна статья может стоять в нескольких
 * разделах: это удобно для навигации без дублирования текста. Внутри одного
 * раздела повторять id нельзя.
 */
export function loadTree(contentDir, articleIds, errors, warnings = []) {
  const file = path.join(contentDir, TREE_FILE);
  if (!fs.existsSync(file)) return null;

  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    errors.push(`${TREE_FILE}: не разбирается как JSON (${error.message})`);
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    errors.push(`${TREE_FILE}: ожидался объект {schemaVersion, roots}`);
    return null;
  }
  if (data.schemaVersion !== TREE_SCHEMA_VERSION) {
    errors.push(
      `${TREE_FILE}: schemaVersion ${data.schemaVersion}, ожидается ${TREE_SCHEMA_VERSION}`,
    );
  }
  if (!Array.isArray(data.roots)) {
    errors.push(`${TREE_FILE}: roots должен быть массивом`);
    return null;
  }

  const nodeIds = new Set();
  const placed = new Set();
  let nodeCount = 0;
  let placementCount = 0;

  const walk = (node, where, depth) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      errors.push(`${where}: раздел должен быть объектом`);
      return;
    }
    if (depth > 4) {
      errors.push(`${where}: больше четырёх уровней вложенности`);
    }
    nodeCount += 1;

    const id = typeof node.id === "string" ? node.id.trim() : "";
    const nodeWhere = id ? `${TREE_FILE}: раздел "${id}"` : where;
    if (!id) {
      errors.push(`${where}: у раздела нет строкового id`);
    } else if (!TREE_ID_RE.test(id)) {
      errors.push(
        `${nodeWhere}: id раздела — строчные латинские буквы, цифры, «-», «_» и «/»`,
      );
    } else if (nodeIds.has(id)) {
      errors.push(`${TREE_FILE}: дубль id раздела "${id}"`);
    } else {
      nodeIds.add(id);
    }

    if (typeof node.title !== "string" || !node.title.trim()) {
      errors.push(`${nodeWhere}: пустой title раздела`);
    }

    const articles = node.articles === undefined ? [] : node.articles;
    if (!Array.isArray(articles)) {
      errors.push(`${nodeWhere}: articles должен быть массивом id статей`);
    } else {
      const seenHere = new Set();
      for (const item of articles) {
        if (typeof item !== "string" || !item.trim()) {
          errors.push(`${nodeWhere}: в articles есть пустое значение`);
          continue;
        }
        const articleId = item.trim();
        if (!articleIds.has(articleId)) {
          errors.push(`${nodeWhere}: статья "${articleId}" не найдена`);
          continue;
        }
        if (seenHere.has(articleId)) {
          errors.push(`${nodeWhere}: статья "${articleId}" повторяется в одном разделе`);
          continue;
        }
        seenHere.add(articleId);
        placed.add(articleId);
        placementCount += 1;
      }
    }

    const children = node.children === undefined ? [] : node.children;
    if (!Array.isArray(children)) {
      errors.push(`${nodeWhere}: children должен быть массивом`);
      return;
    }
    children.forEach((child, index) => {
      walk(child, `${nodeWhere} → child ${index + 1}`, depth + 1);
    });
  };

  data.roots.forEach((node, index) => {
    walk(node, `${TREE_FILE}: root ${index + 1}`, 1);
  });

  const unplaced = [...articleIds].filter((id) => !placed.has(id));
  if (unplaced.length) {
    warnings.push(
      `${TREE_FILE}: вне дерева ${unplaced.length} статей (${unplaced.slice(0, 5).join(", ")}${
        unplaced.length > 5 ? ", …" : ""
      })`,
    );
  }

  return {
    ...data,
    schemaVersion: TREE_SCHEMA_VERSION,
    roots: data.roots,
    stats: {
      nodes: nodeCount,
      articles: placed.size,
      placements: placementCount,
      unplaced,
    },
  };
}

export function analyzeContent(contentDir) {
  const errors = [];
  const warnings = [];
  const articles = loadArticles(contentDir, errors, warnings);
  const redirects = loadRedirects(contentDir, errors);
  const objects = loadTypedObjects(contentDir, errors);
  const articleIds = new Set(articles.map((article) => article.id));
  const tree = loadTree(contentDir, articleIds, errors, warnings);

  const ids = new Set();
  for (const article of articles) {
    if (ids.has(article.id)) errors.push(`дубль id: ${article.id}`);
    ids.add(article.id);
  }

  for (const recipe of objects.recipes) {
    recipe.data.steps?.forEach((step, index) => {
      if (typeof step.wikiId === "string" && !ids.has(step.wikiId)) {
        errors.push(
          `${recipe.where}: шаг ${index + 1} ссылается на несуществующую статью "${step.wikiId}"`,
        );
      }
    });
  }

  for (const [from, to] of Object.entries(redirects)) {
    if (ids.has(from)) {
      errors.push(`redirects.json: "${from}" — это существующий id, редирект не нужен`);
    }
    if (!ids.has(to)) {
      errors.push(`redirects.json: "${from}" ведёт на несуществующий id "${to}"`);
    } else if (Object.prototype.hasOwnProperty.call(redirects, to)) {
      errors.push(`redirects.json: цепочка редиректов "${from}" → "${to}"`);
    }
  }

  let linkCount = 0;
  for (const article of articles) {
    for (const match of article.body.matchAll(/\[\[([^\]]+)\]\]/g)) {
      linkCount++;
      const raw = match[1];
      const target = raw.split("|")[0].trim();
      if (!target) {
        errors.push(`${article.packagePath}: пустая ссылка [[…]]`);
        continue;
      }
      if (!resolveLink(target, ids, redirects, objects)) {
        errors.push(`${article.packagePath}: битая ссылка [[${raw}]]`);
      }
    }

    for (const match of article.body.matchAll(/\]\(\/articles\/[^)]+\)/g)) {
      errors.push(
        `${article.packagePath}: старая ссылка ${match[0]} — перезапустите импортёр`,
      );
    }
    checkMedia(article, contentDir, errors);
  }

  const imported = articles.filter((article) => article.data.source === "moonshinewiki").length;
  const manual = articles.filter((article) => article.data.source === "manual").length;
  const withoutSources = articles
    .filter(
      (article) =>
        !Array.isArray(article.data.sources) || article.data.sources.length === 0,
    )
    .map((article) => article.id);

  const stats = {
    total: articles.length,
    imported,
    manual,
    other: articles.length - imported - manual,
    withoutSources,
    redirects: Object.keys(redirects).length,
    links: linkCount,
    tables: objects.reference.size,
    recipes: objects.recipe.size,
    files: 0,
    treeNodes: tree?.stats.nodes ?? 0,
    treeArticles: tree?.stats.articles ?? 0,
    unplaced: tree?.stats.unplaced ?? [],
  };

  return { errors, warnings, articles, redirects, objects, tree, stats };
}

