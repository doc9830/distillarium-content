import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ContentStore, nextContentVersion, slugifyTitle } from "./store.mjs";

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

test("slugifyTitle: транслитерация заголовка в id", () => {
  assert.equal(slugifyTitle("Новая статья"), "novaya-statya");
  assert.equal(slugifyTitle("Ёмкость для брожения"), "emkost-dlya-brozheniya");
  assert.equal(slugifyTitle("  Мёд & сахар  "), "med-sahar");
  assert.equal(slugifyTitle("Пластик/стекло"), "plastik-steklo");
  assert.equal(slugifyTitle("EC-1118 — дрожжи"), "ec-1118-drozhzhi");
  assert.equal(slugifyTitle("⚗️"), "");
});


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
  assert.throws(() => store.createArticle({ title: "   " }), /title не может быть пустым/);

  const auto = store.createArticle({ title: "Новая статья" });
  assert.equal(auto.article.id, "articles/novaya-statya");
  assert.equal(auto.article.title, "Новая статья");
  assert.equal(auto.article.short, "Новая статья");
  assert.deepEqual(auto.validation.errors, []);
  const autoAgain = store.createArticle({ title: "Новая статья" });
  assert.equal(autoAgain.article.id, "articles/novaya-statya-2");
  const autoEmptyId = store.createArticle({ id: "   ", title: "Новая статья" });
  assert.equal(autoEmptyId.article.id, "articles/novaya-statya-3");
  const autoTranslit = store.createArticle({ title: "Ёмкость для брожения" });
  assert.equal(autoTranslit.article.id, "articles/emkost-dlya-brozheniya");
  assert.equal(
    store.nextArticleId("Новая статья", { "articles/novaya-statya-3": "start" }),
    "articles/novaya-statya-4",
  );
  assert.equal(store.nextArticleId("⚗️"), "articles/article");

  const created = store.createArticle({
    id: "problems/new",
    title: "Новая проблема",
    short: "Проблема",
    tags: ["новичок", "новичок"],
    calc: ["abv"],
    body: "Ссылка на [[processes/run]].",
  });
  assert.equal(created.article.id, "problems/new");
  assert.deepEqual(created.article.tags, ["новичок"]);
  assert.equal(created.article.calc, undefined);
  assert.equal(created.article.data.calc, undefined);
  assert.doesNotMatch(readFileSync(store.articleFile("problems/new"), "utf8"), /^calc:/m);
  assert.deepEqual(store.state().tags, ["новичок"]);
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

test("ContentStore: дерево сохраняется, проверяется и следует за статьёй", () => {
  const root = makeRepo();
  const store = new ContentStore(root);
  assert.deepEqual(store.readTree().roots, []);

  const saved = store.saveTree({
    schemaVersion: 1,
    roots: [
      {
        id: "knowledge",
        title: "Знания",
        articles: ["start"],
        children: [
          {
            id: "knowledge/processes",
            title: "Процессы",
            articles: ["processes/run"],
            children: [],
          },
        ],
      },
    ],
  });
  assert.equal(saved.validation.errors.length, 0);
  assert.equal(store.readTree().roots[0].title, "Знания");
  assert.equal(store.readTree().roots[0].children[0].title, "Процессы");

  assert.throws(
    () =>
      store.saveTree({
        schemaVersion: 1,
        roots: [{ id: "bad", title: "Плохо", articles: ["missing"], children: [] }],
      }),
    /дерево не прошло проверку/,
  );
  assert.equal(store.readTree().roots[0].title, "Знания");

  const duplicate = store.saveTree({
    schemaVersion: 1,
    roots: [
      { id: "one", title: "Один", articles: ["start"], children: [] },
      { id: "two", title: "Два", articles: ["start"], children: [] },
    ],
  });
  assert.deepEqual(duplicate.validation.errors, []);
  assert.deepEqual(store.readTree().roots[0].articles, ["start"]);
  assert.deepEqual(store.readTree().roots[1].articles, ["start"]);
  assert.equal(duplicate.validation.stats.treeArticles, 1);

  assert.throws(
    () =>
      store.saveTree({
        schemaVersion: 1,
        roots: [{ id: "one", title: "Один", articles: ["start", "start"], children: [] }],
      }),
    /дерево не прошло проверку/,
  );

  store.renameArticle("start", "start-new");
  assert.deepEqual(store.readTree().roots[0].articles, ["start-new"]);
  assert.deepEqual(store.readTree().roots[1].articles, ["start-new"]);

  store.deleteArticle("start-new");
  assert.deepEqual(store.readTree().roots[0].articles, []);
  assert.deepEqual(store.readTree().roots[1].articles, []);
});

test("ContentStore: статья размещается в выбранных разделах дерева", () => {
  const root = makeRepo();
  const store = new ContentStore(root);
  store.saveTree({
    schemaVersion: 1,
    roots: [
      {
        id: "a",
        title: "А",
        articles: [],
        children: [{ id: "a/b", title: "Б", articles: [], children: [] }],
      },
      { id: "b", title: "В", articles: [], children: [] },
    ],
  });

  const created = store.createArticle({
    id: "problems/new",
    title: "Новая",
    tags: ["Новичок", "новичок", " новичок "],
    sections: ["a", "a/b", "a"],
  });
  assert.deepEqual(created.article.tags, ["Новичок"]);
  assert.deepEqual(store.readTree().roots[0].articles, ["problems/new"]);
  assert.deepEqual(store.readTree().roots[0].children[0].articles, ["problems/new"]);

  const empty = store.createArticle({ id: "problems/other", title: "Другая", sections: [] });
  assert.equal(empty.article.id, "problems/other");
  assert.deepEqual(store.readTree().roots[1].articles, []);

  store.updateArticle("problems/other", { sections: ["b"] });
  store.updateArticle("problems/new", {
    sections: ["b", "a"],
    tags: ["Новичок", "другой", "ДРУГОЙ"],
  });
  assert.deepEqual(store.readTree().roots[1].articles, ["problems/other", "problems/new"]);
  assert.deepEqual(store.readTree().roots[0].articles, ["problems/new"]);
  assert.deepEqual(store.readTree().roots[0].children[0].articles, []);
  assert.deepEqual(store.readArticle("problems/new").tags, ["Новичок", "другой"]);
  assert.ok(store.state().tags.includes("другой"));

  const withoutSections = store.updateArticle("problems/new", { title: "Новая статья" });
  assert.equal(withoutSections.article.title, "Новая статья");
  assert.deepEqual(store.readTree().roots[1].articles, ["problems/other", "problems/new"]);
  assert.deepEqual(store.readTree().roots[0].articles, ["problems/new"]);

  store.updateArticle("problems/new", { sections: [] });
  assert.deepEqual(store.readTree().roots[0].articles, []);
  assert.deepEqual(store.readTree().roots[1].articles, ["problems/other"]);

  assert.throws(
    () => store.updateArticle("problems/other", { sections: ["missing"] }),
    /раздел missing не найден/,
  );
  assert.deepEqual(store.readTree().roots[1].articles, ["problems/other"]);
});

test("ContentStore: удаление чистит рецепты и ссылки в других статьях", () => {
  const root = makeRepo();
  const store = new ContentStore(root);

  const removed = store.deleteArticle("processes/run");
  assert.deepEqual(removed.validation.errors, []);
  assert.doesNotMatch(store.readArticle("start").body, /\[\[processes\/run\]\]/);
  assert.match(store.readArticle("start").body, /Запуск/);
  const recipe = store.readData().recipes[0].data;
  assert.equal(recipe.steps[0].wikiId, undefined);
});

test("ContentStore: удаление с редиректом перенаправляет wikiId в рецептах", () => {
  const root = makeRepo();
  const store = new ContentStore(root);

  const removed = store.deleteArticle("processes/run", "start");
  assert.deepEqual(removed.validation.errors, []);
  assert.equal(store.readData().redirects["processes/run"], "start");
  assert.equal(store.readData().recipes[0].data.steps[0].wikiId, "start");
  assert.match(store.readArticle("start").body, /\[\[processes\/run\]\]/);
});

test("nextContentVersion: текущий месяц, новый месяц и мусор", () => {
  const now = new Date();
  const period = `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, "0")}`;
  assert.equal(nextContentVersion(`${period}.4`), `${period}.5`);
  assert.equal(nextContentVersion("1999.01.9"), `${period}.1`);
  assert.equal(nextContentVersion(""), `${period}.1`);
  assert.equal(nextContentVersion("не версия"), `${period}.1`);
});
