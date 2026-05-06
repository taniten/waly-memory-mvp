"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT_DIR = path.resolve(__dirname, "..");
const TARGET_DIRS = [
  path.join(ROOT_DIR, "src"),
  path.join(ROOT_DIR, "src", "connectors")
];

function getJavaScriptFiles(directory) {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => path.join(directory, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

function runSyntaxCheck(filePath) {
  execFileSync(process.execPath, ["--check", filePath], {
    stdio: "inherit"
  });
}

TARGET_DIRS
  .flatMap((directory) => getJavaScriptFiles(directory))
  .forEach((filePath) => runSyntaxCheck(filePath));

console.log("Syntax check OK.");
