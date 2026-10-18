// DATABASE_URL байвал Postgres, үгүй бол локал JSON файл.

const path = require("path");
const { createPgStore } = require("./store-pg");
const { createFileStore } = require("./store-file");

function createStore() {
  if (process.env.DATABASE_URL) return createPgStore(process.env.DATABASE_URL);
  if (process.env.VERCEL === "1") {
    throw new Error("Vercel дээр DATABASE_URL заавал хэрэгтэй (файл store хадгалагдахгүй).");
  }
  console.warn("DATABASE_URL алга — локал data/db.json файл ашиглаж байна.");
  return createFileStore(path.join(__dirname, "..", "data", "db.json"));
}

module.exports = { createStore };
