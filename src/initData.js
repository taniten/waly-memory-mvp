"use strict";

const fs = require("fs");
const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..");
const DEFAULT_DATA_DIR = path.join(ROOT_DIR, "data");
const DEFAULT_EXAMPLES_DIR = path.join(ROOT_DIR, "examples");
const EXAMPLE_SUFFIX = ".example.json";

function initData(options = {}) {
  const dataDir = options.dataDir || DEFAULT_DATA_DIR;
  const examplesDir = options.examplesDir || DEFAULT_EXAMPLES_DIR;
  const logger = options.logger || console.log;

  fs.mkdirSync(dataDir, { recursive: true });

  const exampleFiles = fs
    .readdirSync(examplesDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(EXAMPLE_SUFFIX))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  const created = [];
  const skipped = [];

  exampleFiles.forEach((exampleFile) => {
    const targetFile = exampleFile.slice(0, -EXAMPLE_SUFFIX.length) + ".json";
    const sourcePath = path.join(examplesDir, exampleFile);
    const targetPath = path.join(dataDir, targetFile);

    if (fs.existsSync(targetPath)) {
      skipped.push(targetFile);
      return;
    }

    fs.copyFileSync(sourcePath, targetPath);
    created.push(targetFile);
  });

  logger("init-data");
  logger("");
  logger("Creados:");
  if (created.length === 0) {
    logger("- Ningun archivo nuevo.");
  } else {
    created.forEach((fileName) => logger(`- data/${fileName}`));
  }

  logger("");
  logger("Intactos:");
  if (skipped.length === 0) {
    logger("- Ningun archivo existente.");
  } else {
    skipped.forEach((fileName) => logger(`- data/${fileName}`));
  }

  return {
    created,
    dataDir,
    examplesDir,
    skipped
  };
}

module.exports = {
  initData
};
