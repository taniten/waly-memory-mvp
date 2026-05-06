"use strict";

const fs = require("fs");
const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT_DIR, "data");
const REPORTS_DIR = path.join(ROOT_DIR, "reports");

function formatRelativePath(filePath) {
  return path.relative(ROOT_DIR, filePath).split(path.sep).join("/");
}

function writeFileAtomic(filePath, contents) {
  const directory = path.dirname(filePath);
  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  );

  fs.mkdirSync(directory, { recursive: true });

  try {
    if (fs.existsSync(filePath)) {
      fs.copyFileSync(filePath, `${filePath}.bak`);
    }

    fs.writeFileSync(tempPath, contents, "utf8");
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }

    throw error;
  }
}

function readJson(fileName) {
  const filePath = path.join(DATA_DIR, fileName);

  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new Error(`Falta ${formatRelativePath(filePath)}. Corré npm run init-data.`);
    }

    if (error instanceof SyntaxError) {
      throw new Error(`JSON invalido en ${formatRelativePath(filePath)}: ${error.message}`);
    }

    throw error;
  }
}

function writeJson(fileName, value) {
  const filePath = path.join(DATA_DIR, fileName);
  writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function ensureReportsDir() {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
}

function writeReport(fileName, markdown) {
  ensureReportsDir();
  const reportPath = path.join(REPORTS_DIR, fileName);
  writeFileAtomic(reportPath, markdown);
  return reportPath;
}

module.exports = {
  DATA_DIR,
  REPORTS_DIR,
  readJson,
  writeJson,
  writeReport
};
