#!/usr/bin/env node
// Сборка пакета контента одной командой:
//   node tools/build-content.mjs
//
// Вход:  content/ (wiki/, reference/, recipes/, media/, redirects.json)
// Выход: dist/content/ (распакованный пакет с manifest.json)
//        dist/content-pack.zip
//        dist/manifest.json (манифест релиза с packSize и packSha256)
//        dist/build-report.json
//
// Битая ссылка, дубль id, отсутствующий файл или неверный sha256 — сборка падает.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SCHEMA_VERSION, formatBytes, rmrf } from "./lib/content.mjs";
import {
  createPack,
  writePackage,
  writeReleaseManifest,
} from "./lib/package.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const options = {
    contentDir: path.join(ROOT, "content"),
    outDir: path.join(ROOT, "dist"),
    contentVersion: undefined,
    minAppVersion: undefined,
    released: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const take = () => {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`для ${arg} нужно значение`);
      }
      i++;
      return value;
    };
    if (arg === "--content-dir") options.contentDir = path.resolve(take());
    else if (arg === "--out-dir") options.outDir = path.resolve(take());
    else if (arg === "--content-version") options.contentVersion = take();
    else if (arg === "--min-app-version") options.minAppVersion = take();
    else if (arg === "--released") options.released = take();
    else if (arg === "--help" || arg === "-h") {
      console.log(
        [
          "Сборка пакета контента.",
          "",
          "  --content-dir <путь>       исходный контент (по умолчанию content/)",
          "  --out-dir <путь>           куда собрать (по умолчанию dist/)",
          "  --content-version <вер.>   по умолчанию из content/version.json",
          "  --min-app-version <вер.>   по умолчанию из content/version.json",
          "  --released <ГГГГ-ММ-ДД>    по умолчанию из content/version.json",
        ].join("\n"),
      );
      process.exit(0);
    } else {
      throw new Error(`неизвестный аргумент: ${arg}`);
    }
  }

  // Версия и дата релиза — часть исходников, а не момента сборки:
  // иначе один и тот же контент давал бы разный sha256 на разных машинах.
  const versionFile = path.join(options.contentDir, "version.json");
  let declared = {};
  if (fs.existsSync(versionFile)) {
    try {
      declared = JSON.parse(fs.readFileSync(versionFile, "utf8"));
    } catch (error) {
      throw new Error(`content/version.json: ${error.message}`);
    }
  }
  if (
    declared.schemaVersion !== undefined &&
    declared.schemaVersion !== SCHEMA_VERSION
  ) {
    throw new Error(
      `content/version.json: schemaVersion ${declared.schemaVersion}, код поддерживает ${SCHEMA_VERSION}`,
    );
  }
  options.contentVersion ??= declared.contentVersion ?? "2026.10.1";
  options.minAppVersion ??= declared.minAppVersion ?? "0.1.0";
  options.released ??= declared.released ?? new Date().toISOString().slice(0, 10);
  return options;
}

function printProblems(errors) {
  console.error(`Ошибок: ${errors.length}`);
  for (const error of errors) console.error(`  ✗ ${error}`);
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`Ошибка аргументов: ${error.message}`);
    process.exit(1);
  }

  const outContentDir = path.join(options.outDir, "content");
  const zipPath = path.join(options.outDir, "content-pack.zip");
  const manifestPath = path.join(options.outDir, "manifest.json");

  // Старые артефакты не должны пережить неудачную сборку.
  rmrf(outContentDir);
  rmrf(zipPath);
  rmrf(manifestPath);

  console.log(`Источник: ${options.contentDir}`);
  const result = writePackage(options.contentDir, outContentDir, {
    contentVersion: options.contentVersion,
    minAppVersion: options.minAppVersion,
    released: options.released,
  });

  if (!result.ok) {
    console.error("Сборка пакета не удалась.");
    printProblems(result.errors);
    process.exit(1);
  }

  const pack = createPack(outContentDir, zipPath);
  const manifest = writeReleaseManifest(result.manifest, pack, manifestPath);

  const report = {
    contentVersion: manifest.contentVersion,
    schemaVersion: manifest.schemaVersion,
    minAppVersion: manifest.minAppVersion,
    released: manifest.released,
    generatedAt: new Date().toISOString(),
    articles: result.stats.total,
    imported: result.stats.imported,
    manual: result.stats.manual,
    other: result.stats.other,
    files: result.stats.files,
    links: result.stats.links,
    tables: result.stats.tables,
    recipes: result.stats.recipes,
    redirects: result.stats.redirects,
    treeNodes: result.stats.treeNodes,
    treeArticles: result.stats.treeArticles,
    unplaced: result.stats.unplaced,
    withoutSources: result.stats.withoutSources,
    packSize: pack.size,
    packSha256: pack.sha256,
    packFiles: pack.files,
  };
  fs.writeFileSync(
    path.join(options.outDir, "build-report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );

  console.log("");
  console.log("Пакет собран.");
  console.log(`  contentVersion: ${manifest.contentVersion}`);
  console.log(`  schemaVersion:  ${manifest.schemaVersion}`);
  console.log(`  minAppVersion:  ${manifest.minAppVersion}`);
  console.log(`  released:       ${manifest.released}`);
  console.log(
    `  Статей: ${result.stats.total} ` +
      `(импортированных ${result.stats.imported}, ручных ${result.stats.manual}, прочих ${result.stats.other})`,
  );
  console.log(`  Файлов в манифесте: ${result.stats.files}`);
  console.log(`  Ссылок проверено: ${result.stats.links}`);
  console.log(`  Справочных таблиц: ${result.stats.tables}`);
  console.log(`  Редиректов: ${result.stats.redirects}`);
  console.log(
    `  Дерево: разделов ${result.stats.treeNodes}, статей ${result.stats.treeArticles}` +
      (result.stats.unplaced?.length ? `, вне дерева ${result.stats.unplaced.length}` : ""),
  );
  console.log(`  Размер пакета: ${formatBytes(pack.size)} (${pack.size} Б)`);
  console.log(`  sha256 пакета: ${pack.sha256}`);
  console.log(`  Статей без источников: ${result.stats.withoutSources.length}`);
  for (const id of result.stats.withoutSources) {
    console.log(`    - ${id}`);
  }
  if (result.warnings.length) {
    console.log(`  Предупреждений: ${result.warnings.length}`);
    for (const warning of result.warnings) console.log(`    ! ${warning}`);
  }
  console.log("");
  console.log(`  Пакет:    ${path.relative(process.cwd(), zipPath)}`);
  console.log(`  Манифест: ${path.relative(process.cwd(), manifestPath)}`);
  console.log(`  Отчёт:    ${path.relative(process.cwd(), path.join(options.outDir, "build-report.json"))}`);
}

main();
