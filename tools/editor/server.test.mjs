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

