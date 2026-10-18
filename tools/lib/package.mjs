// Сборка пакета контента: нормализация статей, индекс поиска, манифест, zip.
// Пакет собирается детерминированно: одинаковый вход → одинаковый sha256.

import fs from "node:fs";
import path from "node:path";
import {
  SCHEMA_VERSION,
  analyzeContent,
  extractHeadings,
  formatBytes,
  plainText,
  rmrf,
  sha256,
  stringifyFrontmatter,
  walkFiles,
} from "./content.mjs";
import { createZip } from "./zip.mjs";

export const DEFAULT_RELEASED = new Date().toISOString().slice(0, 10);

export function buildSearchIndex(articles) {
  const entries = [...articles]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((article) => ({
      id: article.id,
      title: article.title,
      short: article.short,
      category: typeof article.data.category === "string" ? article.data.category : "",
      tags: Array.isArray(article.data.tags) ? article.data.tags : [],
      tech: Array.isArray(article.data.tech) ? article.data.tech : [],
      equipment: Array.isArray(article.data.equipment) ? article.data.equipment : [],
      headings: extractHeadings(article.body),
      text: plainText(article.body),
    }));
  return { schemaVersion: SCHEMA_VERSION, count: entries.length, entries };
}

function copyAssets(sourceDir, outDir, dir, errors) {
  const srcDir = path.join(sourceDir, dir);
  for (const rel of walkFiles(srcDir)) {
    if (rel.split("/").some((part) => part.startsWith("."))) continue;
    const target = path.join(outDir, dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try {
      fs.copyFileSync(path.join(srcDir, rel), target);
    } catch (error) {
      errors.push(`${dir}/${rel}: не скопирован (${error.message})`);
    }
  }
}

/**
 * Собирает пакет в outDir. Возвращает результат анализа и проверки пакета.
 * При ошибках пакет не является валидным — сборщик обязан упасть.
 */
export function writePackage(sourceDir, outDir, options = {}) {
  const analysis = analyzeContent(sourceDir);
  if (analysis.errors.length) {
    return { ok: false, analysis, errors: analysis.errors, warnings: [] };
  }

  const contentVersion = options.contentVersion;
  const minAppVersion = options.minAppVersion;
  const released = options.released || DEFAULT_RELEASED;
  if (!contentVersion) throw new Error("не задан contentVersion");
  if (!minAppVersion) throw new Error("не задан minAppVersion");

  rmrf(outDir);
  fs.mkdirSync(outDir, { recursive: true });

  for (const article of analysis.articles) {
    const data = {
      ...article.data,
      id: article.id,
      title: article.title,
      short: article.short,
    };
    const text = `${stringifyFrontmatter(data)}${article.body}\n`;
    const target = path.join(outDir, "wiki", `${article.id}.md`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text, "utf8");
  }

  fs.writeFileSync(
    path.join(outDir, "redirects.json"),
    `${JSON.stringify(analysis.redirects, null, 2)}\n`,
    "utf8",
  );

  const assetErrors = [];
  for (const dir of ["reference", "recipes", "media"]) {
    copyAssets(sourceDir, outDir, dir, assetErrors);
  }

  const searchIndex = buildSearchIndex(analysis.articles);
  const searchDir = path.join(outDir, "search");
  fs.mkdirSync(searchDir, { recursive: true });
  const searchBytes = Buffer.from(
    `${JSON.stringify(searchIndex, null, 2)}\n`,
    "utf8",
  );
  fs.writeFileSync(path.join(searchDir, "index.json"), searchBytes);

  const files = walkFiles(outDir)
    .filter((rel) => rel !== "manifest.json")
    .map((rel) => {
      const data = fs.readFileSync(path.join(outDir, rel));
      return { path: rel, sha256: sha256(data), size: data.length };
    });

  const manifest = {
    contentVersion,
    schemaVersion: SCHEMA_VERSION,
    minAppVersion,
    released,
    files,
    searchIndex: "search/index.json",
    searchIndexSha256: sha256(searchBytes),
    redirects: "redirects.json",
  };
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );

  const checked = validatePackage(outDir);
  const errors = [...assetErrors, ...checked.errors];
  return {
    ok: errors.length === 0,
    analysis,
    manifest: checked.manifest,
    stats: checked.stats,
    errors,
    warnings: checked.warnings,
  };
}

export function createPack(outContentDir, zipPath) {
  const entries = walkFiles(outContentDir).map((rel) => ({
    name: rel,
    data: fs.readFileSync(path.join(outContentDir, rel)),
  }));
  const zip = createZip(entries);
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  fs.writeFileSync(zipPath, zip);
  return {
    size: zip.length,
    sha256: sha256(zip),
    files: entries.length,
  };
}

export function writeReleaseManifest(internalManifest, pack, file) {
  const manifest = {
    contentVersion: internalManifest.contentVersion,
    schemaVersion: internalManifest.schemaVersion,
    minAppVersion: internalManifest.minAppVersion,
    released: internalManifest.released,
    packSize: pack.size,
    packSha256: pack.sha256,
    files: internalManifest.files,
    searchIndex: internalManifest.searchIndex,
    searchIndexSha256: internalManifest.searchIndexSha256,
    redirects: internalManifest.redirects,
  };
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

/**
 * Проверяет уже распакованный пакет: манифест, размеры, sha256, ссылки,
 * обязательные поля, индекс поиска. Это тот же валидатор, что запускается в CI.
 */
export function validatePackage(packageDir) {
  const errors = [];
  const warnings = [];
  const manifestPath = path.join(packageDir, "manifest.json");

  let manifest = null;
  if (!fs.existsSync(manifestPath)) {
    errors.push("manifest.json: файл не найден");
  } else {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch (error) {
      errors.push(`manifest.json: не разбирается как JSON (${error.message})`);
    }
  }

  if (manifest) {
    if (
      typeof manifest.contentVersion !== "string" ||
      !/^\d{4}\.\d{1,2}\.\d+$/.test(manifest.contentVersion)
    ) {
      errors.push("manifest.json: contentVersion должен быть вида 2026.10.1");
    }
    if (manifest.schemaVersion !== SCHEMA_VERSION) {
      errors.push(
        `manifest.json: schemaVersion ${manifest.schemaVersion}, ожидается ${SCHEMA_VERSION}`,
      );
    }
    if (
      typeof manifest.minAppVersion !== "string" ||
      !/^\d+\.\d+\.\d+$/.test(manifest.minAppVersion)
    ) {
      errors.push("manifest.json: minAppVersion должен быть вида 0.1.0");
    }
    if (
      typeof manifest.released !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(manifest.released)
    ) {
      errors.push("manifest.json: released должен быть датой ГГГГ-ММ-ДД");
    }
    if (manifest.searchIndex !== "search/index.json") {
      errors.push('manifest.json: searchIndex должен быть "search/index.json"');
    }
    if (manifest.redirects !== "redirects.json") {
      errors.push('manifest.json: redirects должен быть "redirects.json"');
    }

    if (!Array.isArray(manifest.files)) {
      errors.push("manifest.json: files должен быть массивом");
    } else {
      const listed = new Set();
      for (const entry of manifest.files) {
        if (!entry || typeof entry.path !== "string") {
          errors.push("manifest.json: в files есть запись без path");
          continue;
        }
        if (listed.has(entry.path)) {
          errors.push(`manifest.json: файл ${entry.path} указан дважды`);
        }
        listed.add(entry.path);
        const full = path.join(packageDir, entry.path);
        if (!fs.existsSync(full)) {
          errors.push(`manifest.json: файл ${entry.path} отсутствует в пакете`);
          continue;
        }
        const data = fs.readFileSync(full);
        if (data.length !== entry.size) {
          errors.push(
            `manifest.json: ${entry.path} — размер ${data.length}, в манифесте ${entry.size}`,
          );
        }
        if (sha256(data) !== entry.sha256) {
          errors.push(`manifest.json: ${entry.path} — sha256 не совпадает`);
        }
      }
      const actual = walkFiles(packageDir).filter((rel) => rel !== "manifest.json");
      for (const rel of actual) {
        if (!listed.has(rel)) {
          errors.push(`manifest.json: файл ${rel} есть в пакете, но не указан в files`);
        }
      }
    }

    const searchFile = path.join(packageDir, "search/index.json");
    if (fs.existsSync(searchFile)) {
      if (sha256(fs.readFileSync(searchFile)) !== manifest.searchIndexSha256) {
        errors.push("manifest.json: searchIndexSha256 не совпадает");
      }
    }
  }

  const analysis = analyzeContent(packageDir);
  errors.push(...analysis.errors);
  warnings.push(...analysis.warnings);

  const searchFile = path.join(packageDir, "search/index.json");
  if (fs.existsSync(searchFile)) {
    let index = null;
    try {
      index = JSON.parse(fs.readFileSync(searchFile, "utf8"));
    } catch (error) {
      errors.push(`search/index.json: не разбирается как JSON (${error.message})`);
    }
    if (index) {
      if (index.schemaVersion !== SCHEMA_VERSION) {
        errors.push(
          `search/index.json: schemaVersion ${index.schemaVersion}, ожидается ${SCHEMA_VERSION}`,
        );
      }
      if (!Array.isArray(index.entries)) {
        errors.push("search/index.json: нет массива entries");
      } else {
        if (index.count !== index.entries.length) {
          errors.push("search/index.json: count не совпадает с числом entries");
        }
        const indexIds = new Set();
        for (const entry of index.entries) {
          if (!entry || typeof entry.id !== "string" || !entry.id) {
            errors.push("search/index.json: запись без id");
            continue;
          }
          if (indexIds.has(entry.id)) {
            errors.push(`search/index.json: дубль id ${entry.id}`);
          }
          indexIds.add(entry.id);
          if (!entry.title || !entry.short) {
            errors.push(`search/index.json: у ${entry.id} пустые title/short`);
          }
        }
        const articleIds = new Set(analysis.articles.map((article) => article.id));
        for (const id of articleIds) {
          if (!indexIds.has(id)) errors.push(`search/index.json: нет статьи ${id}`);
        }
        for (const id of indexIds) {
          if (!articleIds.has(id)) errors.push(`search/index.json: лишняя запись ${id}`);
        }
      }
    }
  } else {
    errors.push("search/index.json: файл не найден");
  }

  const stats = {
    ...analysis.stats,
    files: manifest && Array.isArray(manifest.files) ? manifest.files.length : 0,
  };

  return { errors, warnings, manifest, articles: analysis.articles, stats };
}

export { formatBytes };
