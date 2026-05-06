"use strict";

const fs = require("fs");
const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT_DIR, "data");
const REPORTS_DIR = path.join(ROOT_DIR, "reports");

function readJson(fileName) {
  const filePath = path.join(DATA_DIR, fileName);
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

function writeJson(fileName, value) {
  const filePath = path.join(DATA_DIR, fileName);
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function ensureReportsDir() {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
}

function writeReport(fileName, markdown) {
  ensureReportsDir();
  const reportPath = path.join(REPORTS_DIR, fileName);
  fs.writeFileSync(reportPath, markdown, "utf8");
  return reportPath;
}

module.exports = {
  DATA_DIR,
  REPORTS_DIR,
  readJson,
  writeJson,
  writeReport
};
