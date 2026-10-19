import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ContentStore, nextContentVersion } from "./store.mjs";

const roots = [];

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function write(root, relative, value) {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
}

function article({ id, title, link, updated = "2026-01-01" }) {
  return [
    "---",
    `id: ${id}`,
    `title: "${title}"`,
    `short: "${title}"`,
    "category: processes",
    "created: 2026-01-01",
    `updated: ${updated}`,
    "sources: []",
    "---",
    "",
    `Текст статьи. См. [[${link}]].`,
    "",
  ].join("\n");
}

function makeRepo() {
  const root = mkdtempSync(path.join(tmpdir(), "distillarium-editor-"));
  roots.push(root);
  write(root, "content/wiki/processes/run.md", article({
    id: "processes/run",
    title: "Запуск",
    link: "start",
  }));
  write(root, "content/wiki/start.md", article({
    id: "start",
    title: "Старт",
    link: "processes/run",
  }));
  write(root, "content/reference/yeast.json", {
    id: "yeast",
    title: "Дрожжи",
    short: "Виды дрожжей",
    intro: "Виды дрожжей.",
    columns: [{ key: "name", title: "Название", type: "text" }],
    rows: [{ name: "EC-1118" }],
    updated: "2026-01-01",
  });
  write(root, "content/recipes/test.json", {
    id: "test",
    title: "Тестовый рецепт",
    short: "Тест",
    type: "wine",
    volume: 10,
    ingredients: [{ name: "Вода", amount: "10", unit: "л" }],
    steps: [{ title: "Запустить", wikiId: "processes/run" }],
    updated: "2026-01-01",
  });
  write(root, "content/redirects.json", {});
  write(root, "content/calculators.json", {
    schemaVersion: 1,
    items: [{ id: "abv", title: "Крепость", description: "Расчёт" }],
  });
  write(root, "content/version.json", {
    contentVersion: "2026.10.4",
    schemaVersion: 1,
    minAppVersion: "0.1.0",
    released: "2026-10-18",
  });
  write(root, "package.json", { name: "distillarium-content", version: "2026.10.4", private: true });
  write(root, "tools/build-content.mjs", "// build\n");
  write(root, "tools/validate-content.mjs", "// validate\n");
  mkdirSync(path.join(root, "content/media"), { recursive: true });
  return root;
}

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";


test("ContentStore: состояние, статьи, редиректы и данные", () => {
  const root = makeRepo();
  const store = new ContentStore(root);

  const initial = store.state();
  assert.deepEqual(initial.validation.errors, [], initial.validation.errors.join("\n"));
  assert.equal(initial.articles.length, 2);
  assert.equal(initial.contentVersion, "2026.10.4");
  assert.equal(initial.validation.errors.length, 0);
  assert.deepEqual(initial.categories, ["processes"]);
  assert.equal(initial.media.length, 0);

  const read = store.readArticle("start");
  assert.equal(read.title, "Старт");
  assert.match(read.body, /\[\[processes\/run\]\]/);

  const updated = store.updateArticle("start", {
    title: "Новый старт",
    short: "Новый старт",
    body: "Обновлённый текст.",
  });
  assert.equal(updated.article.title, "Новый старт");
  assert.equal(updated.article.created, "2026-01-01");
  assert.equal(store.readArticle("start").data.short, "Новый старт");

  assert.throws(() => store.readArticle("../escape"), /id статьи/);
  assert.throws(() => store.createArticle({ id: "processes/run", title: "Дубль" }), /уже существует/);
  assert.throws(() => store.createArticle({ id: "плохой id", title: "Нет" }), /id статьи/);
  assert.throws(() => store.createArticle({ title: "Без id" }), /id статьи/);

  const created = store.createArticle({
    id: "problems/new",
    title: "Новая проблема",
    short: "Проблема",
    tags: ["новичок", "новичок"],
    body: "Ссылка на [[processes/run]].",
  });
  assert.equal(created.article.id, "problems/new");
  assert.equal(created.validation.errors.length, 0);
  assert.throws(
    () => store.createArticle({ id: "problems/new", title: "Ещё" }),
    /уже существует/,
  );

  const legacy = { ...store.readData().redirects, "legacy/run": "processes/run" };
  assert.equal(store.saveRedirects(legacy).errors.length, 0);

  const renamed = store.renameArticle("processes/run", "problems/start");
  assert.equal(renamed.article.id, "problems/start");
  assert.equal(store.readData().redirects["processes/run"], "problems/start");
  assert.equal(store.readData().redirects["legacy/run"], "problems/start");
  assert.equal(store.readData().recipes[0].data.steps[0].wikiId, "problems/start");
  assert.equal(renamed.validation.errors.length, 0);

  const beforeDelete = { ...store.readData().redirects, "ancient/new": "problems/new" };
  assert.equal(store.saveRedirects(beforeDelete).errors.length, 0);
  const removed = store.deleteArticle("problems/new", "start");
  assert.equal(removed.validation.errors.length, 0);
  assert.equal(store.readData().redirects["problems/new"], "start");
  assert.equal(store.readData().redirects["ancient/new"], "start");
  assert.throws(() => store.deleteArticle("problems/new"), /не найдена/);

  const reference = store.readData().reference[0].data;
  reference.rows.push({ name: "K1-V1116" });
  assert.equal(store.saveReference("yeast", reference).errors.length, 0);
  assert.equal(store.state().data.reference[0].data.rows.length, 2);

  const calculators = { schemaVersion: 1, items: [{ id: "abv", title: "Крепость" }] };
  assert.equal(store.saveCalculators(calculators).errors.length, 0);
  assert.equal(store.saveRedirects({ "old/start": "start" }).errors.length, 0);

  assert.equal(store.saveVersion({ contentVersion: "2099.01.7", released: "2026-01-02" }).errors.length, 0);
  assert.equal(store.state().contentVersion, "2099.01.7");
  assert.equal(store.state().data.version.released, "2026-01-02");
  assert.equal(store.saveVersion({ contentVersion: "2099.01.8" }).errors.length, 0);
  assert.match(store.state().data.version.released, /^\d{4}-\d{2}-\d{2}$/);
  assert.throws(() => store.saveVersion({ contentVersion: "2026.1" }), /ГГГГ.ММ.N/);

  const media = store.saveMedia({ name: "Схема бака.png", mime: "image/png", base64: PNG });
  assert.deepEqual(store.listMedia().map((item) => item.path), [media.path]);
  assert.match(media.markdown, /^!\[.+\]\(media\/.+\.png\)$/);
  assert.throws(
    () => store.saveMedia({ name: "evil.svg", mime: "image/svg+xml", base64: PNG }),
    /WebP, PNG и JPEG/,
  );
  assert.throws(() => store.saveMedia({ name: "evil.png", base64: "" }), /нет данных/);
});

test("nextContentVersion: текущий месяц, новый месяц и мусор", () => {
  const now = new Date();
  const period = `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, "0")}`;
  assert.equal(nextContentVersion(`${period}.4`), `${period}.5`);
  assert.equal(nextContentVersion("1999.01.9"), `${period}.1`);
  assert.equal(nextContentVersion(""), `${period}.1`);
  assert.equal(nextContentVersion("не версия"), `${period}.1`);
});
