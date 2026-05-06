"use strict";

const http = require("http");
const https = require("https");
const { URL } = require("url");

const SENSITIVE_QUERY_KEYS = new Set([
  "access_token",
  "api_key",
  "apikey",
  "key",
  "secret",
  "token"
]);

function buildUrl(rawUrl, query = {}) {
  const url = new URL(rawUrl);

  Object.entries(query).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") {
      return;
    }

    url.searchParams.set(key, String(value));
  });

  return url;
}

function redactUrl(rawUrl) {
  const target = rawUrl instanceof URL ? new URL(rawUrl.toString()) : new URL(rawUrl);

  Array.from(target.searchParams.keys()).forEach((key) => {
    if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) {
      target.searchParams.set(key, "[REDACTED]");
    }
  });

  return target.toString();
}

function request(url, options = {}) {
  const {
    headers = {},
    method = "GET",
    query,
    timeoutMs = 15000
  } = options;
  const target = buildUrl(url, query);
  const redactedTarget = redactUrl(target);
  const transport = target.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const req = transport.request(
      target,
      {
        headers,
        method
      },
      (response) => {
        const chunks = [];

        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");

          if (response.statusCode >= 400) {
            const error = new Error(`HTTP ${response.statusCode} for ${redactedTarget}`);
            error.body = body;
            error.statusCode = response.statusCode;
            reject(error);
            return;
          }

          resolve({
            body,
            headers: response.headers,
            statusCode: response.statusCode,
            url: redactedTarget
          });
        });
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Timeout after ${timeoutMs}ms for ${redactedTarget}`));
    });

    req.on("error", reject);
    req.end();
  });
}

async function requestJson(url, options = {}) {
  const response = await request(url, {
    ...options,
    headers: {
      Accept: "application/json",
      ...(options.headers || {})
    }
  });

  return {
    ...response,
    json: JSON.parse(response.body)
  };
}

async function requestText(url, options = {}) {
  return request(url, options);
}

module.exports = {
  redactUrl,
  requestJson,
  requestText
};
