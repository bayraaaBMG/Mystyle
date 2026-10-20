// DATABASE_URL байвал Postgres, үгүй бол локал JSON файл.

const path = require("path");
const { createPgStore } = require("./store-pg");
const { createFileStore } = require("./store-file");

// Тохиргоо дутуу үед API 503 буцаана (server.js-ийн wrap). Статик хуудас, PWA ажилласаар байна.
const notConfigured = (msg) => Object.assign(new Error(msg), { code: "NOT_CONFIGURED" });

function createStore() {
  if (process.env.DATABASE_URL) return createPgStore(process.env.DATABASE_URL);
  if (process.env.VERCEL === "1") {
    throw notConfigured("Vercel дээр DATABASE_URL заавал хэрэгтэй (файл store хадгалагдахгүй).");
  }
  console.warn("DATABASE_URL алга — локал data/db.json файл ашиглаж байна.");
  return createFileStore(path.join(__dirname, "..", "data", "db.json"));
}

// Store үүсгэж чадахгүй бол функцийг бүхэлд нь унагахгүй — дуудлага бүр NOT_CONFIGURED алдаа шиднэ.
function createStoreOrUnavailable() {
  try {
    return createStore();
  } catch (e) {
    console.error(e.message);
    return new Proxy({ kind: "unavailable" }, {
      get: (t, p) => (p in t || p === "then" ? t[p] : async () => { throw notConfigured(e.message); }),
    });
  }
}

module.exports = { createStore, createStoreOrUnavailable, notConfigured };
