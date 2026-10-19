import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { startServer } from "./server.mjs";

let started;
let root;

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function write(relative, value) {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
}

function article(id, title) {
  return [
    "---",
    `id: ${id}`,
    `title: "${title}"`,
    `short: "${title}"`,
    "category: processes",
    "created: 2026-01-01",
    "updated: 2026-01-01",
    "sources: []",
    "---",
    "",
    `Текст статьи ${title}.`,
    "",
  ].join("\n");
}

before(async () => {
  root = mkdtempSync(path.join(tmpdir(), "distillarium-editor-server-"));
  write("content/wiki/processes/run.md", article("processes/run", "Запуск"));
  write("content/reference/yeast.json", {
    id: "yeast",
    title: "Дрожжи",
    short: "Виды дрожжей",
    columns: [{ key: "name", title: "Название" }],
    rows: [{ name: "EC-1118" }],
  });
  write("content/recipes/test.json", {
    id: "test",
    title: "Тестовый рецепт",
    short: "Тест",
    type: "wine",
    volume: 10,
    ingredients: [{ name: "Вода", amount: "10", unit: "л" }],
    steps: [{ title: "Запустить", wikiId: "processes/run" }],
  });
  write("content/redirects.json", {});
  write("content/calculators.json", { schemaVersion: 1, items: [{ id: "abv", title: "Крепость" }] });
  write("content/version.json", {
    contentVersion: "2026.10.4",
    schemaVersion: 1,
    minAppVersion: "0.1.0",
    released: "2026-10-18",
  });
  write("package.json", { name: "distillarium-content", version: "2026.10.4", private: true });
  started = await startServer({ root, port: 0 });
});

after(async () => {
  if (started) await new Promise((resolve) => started.server.close(resolve));
  if (root) rmSync(root, { recursive: true, force: true });
});

async function call(pathname, options = {}) {
  const response = await fetch(`${started.url}${pathname}`, {
    headers: options.body ? { "content-type": "application/json" } : undefined,
    ...options,
  });
  const text = await response.text();
  let payload = text;
  try {
    payload = JSON.parse(text);
  } catch {
    // static files are plain text
  }
  return { status: response.status, headers: response.headers, payload };
}

test("GET /api/health и /api/state отдают состояние репозитория", async () => {
  const health = await call("/api/health");
  assert.equal(health.status, 200);
  assert.equal(health.payload.ok, true);
  assert.equal(health.payload.root, root);

  const state = await call("/api/state");
  assert.equal(state.status, 200);
  assert.equal(state.payload.articles.length, 1);
  assert.equal(state.payload.contentVersion, "2026.10.4");
  assert.deepEqual(state.payload.validation.errors, []);
});

test("CRUD статьи, переименование с редиректом и удаление", async () => {
  const created = await call("/api/articles", {
    method: "POST",
    body: JSON.stringify({
      id: "problems/new",
      title: "Новая проблема",
      short: "Проблема",
      category: "problems",
      created: "2026-01-01",
      updated: "2026-01-01",
      body: "Ссылка на [[processes/run]].",
    }),
  });
  assert.equal(created.status, 201);
  assert.equal(created.payload.article.id, "problems/new");
  assert.equal(created.payload.article.title, "Новая проблема");

  const read = await call(`/api/articles/${encodeURIComponent("problems/new")}`);
  assert.equal(read.status, 200);
  assert.match(read.payload.body, /processes\/run/);

  const updated = await call(`/api/articles/${encodeURIComponent("problems/new")}`, {
    method: "PUT",
    body: JSON.stringify({ title: "Обновлено", short: "Обновлено", body: "Новый текст." }),
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.payload.article.title, "Обновлено");
  assert.equal(updated.payload.article.created, "2026-01-01");

  const renamed = await call(`/api/articles/${encodeURIComponent("processes/run")}/rename`, {
    method: "POST",
    body: JSON.stringify({ newId: "processes/start" }),
  });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.payload.article.id, "processes/start");

  const state = await call("/api/state");
  assert.equal(state.payload.data.redirects["processes/run"], "processes/start");
  assert.equal(state.payload.data.recipes[0].data.steps[0].wikiId, "processes/start");

  const removed = await call(
    `/api/articles/${encodeURIComponent("problems/new")}?redirect=${encodeURIComponent("processes/start")}`,
    { method: "DELETE" },
  );
  assert.equal(removed.status, 200);
  assert.equal((await call("/api/state")).payload.data.redirects["problems/new"], "processes/start");

  const again = await call(`/api/articles/${encodeURIComponent("problems/new")}`);
  assert.equal(again.status, 404);
});

test("POST /api/articles без id генерирует id из заголовка", async () => {
  const suggested = await call(`/api/article-id?title=${encodeURIComponent("Ёмкость для брожения")}`);
  assert.equal(suggested.status, 200);
  assert.equal(suggested.payload.id, "articles/emkost-dlya-brozheniya");

  const originalRedirects = (await call("/api/state")).payload.data.redirects;
  const reserved = await call("/api/data/redirects", {
    method: "PUT",
    body: JSON.stringify({
      data: { ...originalRedirects, "articles/avtomaticheskiy-id": "processes/start" },
    }),
  });
  assert.equal(reserved.status, 200);
  assert.deepEqual(reserved.payload.validation.errors, []);

  const reservedSuggestion = await call(
    `/api/article-id?title=${encodeURIComponent("Автоматический id")}`,
  );
  assert.equal(reservedSuggestion.status, 200);
  assert.equal(reservedSuggestion.payload.id, "articles/avtomaticheskiy-id-2");

  const first = await call("/api/articles", {
    method: "POST",
    body: JSON.stringify({
      title: "Автоматический id",
      body: "## Коротко\n\nТестовая статья.",
    }),
  });
  assert.equal(first.status, 201);
  assert.equal(first.payload.article.id, "articles/avtomaticheskiy-id-2");
  assert.equal(first.payload.article.title, "Автоматический id");
  assert.equal(first.payload.article.short, "Автоматический id");

  const second = await call("/api/articles", {
    method: "POST",
    body: JSON.stringify({ title: "Автоматический id" }),
  });
  assert.equal(second.status, 201);
  assert.equal(second.payload.article.id, "articles/avtomaticheskiy-id-3");

  const third = await call("/api/articles", {
    method: "POST",
    body: JSON.stringify({ id: "   ", title: "Автоматический id", sections: [] }),
  });
  assert.equal(third.status, 201);
  assert.equal(third.payload.article.id, "articles/avtomaticheskiy-id-4");

  for (const id of [
    "articles/avtomaticheskiy-id-2",
    "articles/avtomaticheskiy-id-3",
    "articles/avtomaticheskiy-id-4",
  ]) {
    const removed = await call(`/api/articles/${encodeURIComponent(id)}`, { method: "DELETE" });
    assert.equal(removed.status, 200);
  }
  const restored = await call("/api/data/redirects", {
    method: "PUT",
    body: JSON.stringify({ data: originalRedirects }),
  });
  assert.equal(restored.status, 200);
});

test("POST/PUT статьи размещают её в разделах дерева и отдают теги", async () => {
  const tree = {
    schemaVersion: 1,
    roots: [
      { id: "test-a", title: "Раздел А", articles: [], children: [] },
      { id: "test-b", title: "Раздел Б", articles: [], children: [] },
    ],
  };
  const saved = await call("/api/tree", { method: "PUT", body: JSON.stringify({ tree }) });
  assert.equal(saved.status, 200);

  const created = await call("/api/articles", {
    method: "POST",
    body: JSON.stringify({
      id: "problems/placed",
      title: "Размещённая",
      tags: ["Новичок", "новичок"],
      sections: ["test-a", "test-a"],
    }),
  });
  assert.equal(created.status, 201);
  assert.deepEqual(created.payload.article.tags, ["Новичок"]);
  assert.deepEqual(created.payload.validation.stats.treeArticles, 1);

  const taggedAgain = await call("/api/articles", {
    method: "POST",
    body: JSON.stringify({
      id: "problems/placed-2",
      title: "Ещё размещённая",
      tags: ["НОВИЧОК"],
    }),
  });
  assert.equal(taggedAgain.status, 201);
  assert.deepEqual(taggedAgain.payload.article.tags, ["НОВИЧОК"]);

  let state = await call("/api/state");
  assert.deepEqual(state.payload.tree.roots[0].articles, ["problems/placed"]);
  assert.deepEqual(state.payload.tree.roots[1].articles, []);
  assert.deepEqual(
    state.payload.tags.filter((tag) => tag.toLocaleLowerCase("ru") === "новичок"),
    ["Новичок"],
  );

  const removedTwin = await call(`/api/articles/${encodeURIComponent("problems/placed-2")}`, {
    method: "DELETE",
  });
  assert.equal(removedTwin.status, 200);

  const updated = await call(`/api/articles/${encodeURIComponent("problems/placed")}`, {
    method: "PUT",
    body: JSON.stringify({ title: "Размещённая заново", sections: ["test-b"] }),
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.payload.article.title, "Размещённая заново");

  state = await call("/api/state");
  assert.deepEqual(state.payload.tree.roots[0].articles, []);
  assert.deepEqual(state.payload.tree.roots[1].articles, ["problems/placed"]);

  const unplaced = await call(`/api/articles/${encodeURIComponent("problems/placed")}`, {
    method: "PUT",
    body: JSON.stringify({ sections: [] }),
  });
  assert.equal(unplaced.status, 200);
  state = await call("/api/state");
  assert.deepEqual(state.payload.tree.roots[0].articles, []);
  assert.deepEqual(state.payload.tree.roots[1].articles, []);

  const invalid = await call(`/api/articles/${encodeURIComponent("problems/placed")}`, {
    method: "PUT",
    body: JSON.stringify({ sections: ["test-missing"] }),
  });
  assert.equal(invalid.status, 400);
  assert.match(invalid.payload.error, /не найден в дереве/);

  await call(`/api/articles/${encodeURIComponent("problems/placed")}`, { method: "DELETE" });
  await call("/api/tree", {
    method: "PUT",
    body: JSON.stringify({ tree: { schemaVersion: 1, roots: [] } }),
  });
});

test("JSON-данные, медиа и проверка контента", async () => {
  const reference = (await call("/api/state")).payload.data.reference[0].data;
  reference.rows.push({ name: "K1-V1116" });
  const saved = await call("/api/data/reference/yeast", {
    method: "PUT",
    body: JSON.stringify({ data: reference }),
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.payload.validation.errors, []);

  const version = await call("/api/data/version", {
    method: "PUT",
    body: JSON.stringify({ data: { contentVersion: "2026.10.5", released: "2026-10-19" } }),
  });
  assert.equal(version.status, 200);
  assert.equal((await call("/api/state")).payload.contentVersion, "2026.10.5");

  const media = await call("/api/media", {
    method: "POST",
    body: JSON.stringify({ name: "Схема бака.png", mime: "image/png", base64: PNG }),
  });
  assert.equal(media.status, 201);
  assert.match(media.payload.path, /^media\/.+\.png$/);
  assert.match(media.payload.markdown, /^!\[.+\]\(media\/.+\.png\)$/);

  const check = await call("/api/check", { method: "POST", body: "{}" });
  assert.equal(check.status, 200);
  assert.deepEqual(check.payload.validation.errors, []);
});


test("GET/PUT дерева навигации", async () => {
  const before = await call("/api/state");
  assert.deepEqual(before.payload.tree.roots, []);
  const articleId = before.payload.articles[0].id;

  const saved = await call("/api/tree", {
    method: "PUT",
    body: JSON.stringify({
      tree: {
        schemaVersion: 1,
        roots: [
          {
            id: "knowledge",
            title: "Знания",
            articles: [],
            children: [
              {
                id: "knowledge/run",
                title: "Запуск",
                articles: [articleId],
                children: [],
              },
            ],
          },
        ],
      },
    }),
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.payload.validation.errors, []);
  assert.equal(saved.payload.tree.roots[0].children[0].articles[0], articleId);

  const state = await call("/api/state");
  assert.equal(state.payload.tree.roots[0].title, "Знания");

  const duplicate = await call("/api/tree", {
    method: "PUT",
    body: JSON.stringify({
      tree: {
        schemaVersion: 1,
        roots: [
          { id: "one", title: "Один", articles: [articleId], children: [] },
          { id: "two", title: "Два", articles: [articleId], children: [] },
        ],
      },
    }),
  });
  assert.equal(duplicate.status, 200);
  assert.deepEqual(duplicate.payload.validation.errors, []);
  assert.equal(duplicate.payload.validation.stats.treeArticles, 1);

  const invalid = await call("/api/tree", {
    method: "PUT",
    body: JSON.stringify({
      tree: {
        schemaVersion: 1,
        roots: [{ id: "broken", title: "Битая", articles: ["missing"], children: [] }],
      },
    }),
  });
  assert.equal(invalid.status, 422);
  assert.match(invalid.payload.error, /дерево/);
});

test("статика и защита локального API", async () => {
  const page = await call("/");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /text\/html/);
  assert.match(page.payload, /id="articleList"/);

  const script = await call("/app.js");
  assert.equal(script.status, 200);
  assert.match(script.headers.get("content-type"), /text\/javascript/);

  const traversal = await call("/..%2fpackage.json");
  assert.equal(traversal.status, 403);

  const foreign = await call("/api/check", {
    method: "POST",
    headers: { origin: "https://evil.example", "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(foreign.status, 403);
  assert.match(foreign.payload.error, /localhost/);

  const local = await call("/api/check", {
    method: "POST",
    headers: { origin: "http://127.0.0.1:4173", "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(local.status, 200);

  const badJson = await call("/api/articles", { method: "POST", body: "{" });
  assert.equal(badJson.status, 400);
  assert.match(badJson.payload.error, /JSON/);

  const badId = await call(`/api/articles/${encodeURIComponent("../escape")}`);
  assert.equal(badId.status, 400);

  const missing = await call(`/api/articles/${encodeURIComponent("processes/missing")}`);
  assert.equal(missing.status, 404);

  const unknown = await call("/api/unknown");
  assert.equal(unknown.status, 404);

  const badMedia = await call("/api/media", {
    method: "POST",
    body: JSON.stringify({ name: "evil.svg", mime: "image/svg+xml", base64: PNG }),
  });
  assert.equal(badMedia.status, 400);
  assert.match(badMedia.payload.error, /WebP/);
});

