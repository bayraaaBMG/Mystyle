// Бодит Claude-оор 3 профайлын тайлан гаргаж, token, хугацаа, зардлыг хэмжинэ.
// Ажиллуулах: node scripts/bench.js [model1,model2,...]
// Анхаар: Claude API-г бодитоор дууддаг тул бага зэрэг мөнгө зарцуулна (Sonnet 4.6 дээр нэг тайлан ~$0.05–0.10).

try { process.loadEnvFile(); } catch (e) { /* .env байхгүй */ }
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY алга. .env файлд тохируулна уу.");
  process.exit(1);
}

const { callClaude, PRICES } = require("../server");
const { buildContent } = require("../lib/prompt");

const PROFILES = [
  { name: "Эмэгтэй, ажил", gender: "Эмэгтэй", height: "162", weight: "55", body: "Лийртэн", face: "Зууван", skin: "Цайвар", undertone: "Хүйтэн", style: "Цэвэрхэн / Minimal", occasion: "Ажил", chest: "86", waist: "68", hips: "96" },
  { name: "Эрэгтэй, болзоо", gender: "Эрэгтэй", height: "178", weight: "80", body: "Алимтан", face: "Дөрвөлжин", skin: "Дунд зэрэг", undertone: "Дулаан", style: "Энгийн / Casual", occasion: "Болзоо" },
  { name: "Мэдээлэл бага", gender: "Эмэгтэй", height: "170", body: "Мэдэхгүй", occasion: "Өдөр тутам" },
];
const SECTIONS = ["tovch", "ongo_tovch", "ongo", "razmer", "outfit", "us", "gutal", "delguur"];

(async () => {
  const models = (process.argv[2] || process.env.MYSTYLE_MODEL || "claude-sonnet-4-6").split(",");
  const rows = [];
  for (const model of models) {
    for (const p of PROFILES) {
      const { content } = buildContent({ ...p, season: "сэрүүсэж буй намар" });
      const t0 = Date.now();
      try {
        const r = await callClaude(content, model);
        const sec = (Date.now() - t0) / 1000;
        const [pi, po] = PRICES[model] || [0, 0];
        const cost = (r.usage.input_tokens * pi + r.usage.output_tokens * po) / 1e6;
        const missing = SECTIONS.filter((k) => !r.report[k]);
        const colorsOk = (r.report.ongo || []).every((c) => c.yagaad && c.ilerhiilel && c.setgegdel);
        rows.push({ model, profile: p.name, sec: sec.toFixed(1), in: r.usage.input_tokens, out: r.usage.output_tokens, cost: "$" + cost.toFixed(4), missing: missing.join(",") || "-", colorsOk });
        require("fs").mkdirSync("bench-out", { recursive: true });
        require("fs").writeFileSync(`bench-out/${model}-${p.name.replace(/[^\wА-яӨөҮүЁё]+/g, "_")}.json`, JSON.stringify(r.report, null, 2));
      } catch (err) {
        rows.push({ model, profile: p.name, sec: ((Date.now() - t0) / 1000).toFixed(1), error: err.message.slice(0, 120) });
      }
    }
  }
  console.table(rows);
  console.log("Тайлангууд: bench-out/ хавтаст хадгалагдлаа.");
})();
