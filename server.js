// MyStyle AI — backend server
// API key-г энд бичихгүй. .env файлд ANTHROPIC_API_KEY тавина.

// .env файлыг уншина (Node 20.6+ built-in). Хуучин Node дээр энэ мөрийг
// устгаад `npm i dotenv` хийж `require("dotenv").config()` болгож болно.
try { process.loadEnvFile(); } catch (e) { /* .env байхгүй эсвэл хуучин Node — алгасна */ }

const express = require("express");
const path = require("path");

const app = express();
app.use(express.json({ limit: "8mb" })); // selfie зураг багтаахаар лимит өндөр
app.use(express.static(path.join(__dirname, "public")));

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.MYSTYLE_MODEL || "claude-sonnet-4-6";

// Стилийн тайлан гаргах endpoint
app.post("/api/style", async (req, res) => {
  if (!API_KEY) {
    return res.status(500).json({ error: "Серверт ANTHROPIC_API_KEY тохируулаагүй байна." });
  }

  const a = req.body || {};
  const season = a.season || "тодорхойгүй улирал";
  const hasPhoto = a.selfie && a.selfie.b64;

  const profile = `Хүйс: ${a.gender || "?"}
Өндөр: ${a.height || "?"} см, Жин: ${a.weight || "хэлээгүй"} кг
Биеийн хэлбэр: ${a.body || "?"}
Нүүрний хэлбэр: ${hasPhoto ? "(selfie зургаас тодорхойл)" : (a.face || "хэлээгүй")}
Арьсны өнгө: ${a.skin || "хэлээгүй"}, Өнгөлөг: ${a.undertone || "хэлээгүй"}
Дуртай стиль: ${a.style || "хэлээгүй"}
Нөхцөл: ${a.occasion || "?"}
Байршил: Улаанбаатар. Одоогийн улирал: ${season}`;

  const promptText = `Чи бол туршлагатай, эелдэг хувийн стилист. Доорх хүний мэдээлэлд тулгуурлан Монгол хэлээр хувийн стилийн зөвлөгөө гаргана уу.${hasPhoto ? " Хавсаргасан selfie зургаас нүүрний хэлбэр болон арьсны өнгөлгийг ажиглан тооцоонд аваарай." : ""}

ЧУХАЛ ДҮРЭМ:
- Эерэг, өөртөө итгэлтэй болгох өнгө аяс. "Туранхай харагдуул", "доголдлоо нуу" гэх мэт сөрөг үг ХЭРЭГЛЭХГҮЙ. "Юу нь чамд илүү зохимжтой, тав тухтай харагдана" гэсэн өнцгөөр бич.
- Бодит, хэрэгжүүлж болохуйц зөвлөгөө. Ерөнхий үг бүү хэл.
- Өндөр, жингийн тоог ашиглан биеийн пропорцид тохирсон нарийвчилсан зөвлөгөө өг.
- Зөвхөн доорх JSON форматаар, өөр юм бичихгүйгээр (markdown, тайлбар, код блок ашиглахгүй) хариул.

Хүний мэдээлэл:
${profile}

JSON бүтэц:
{
  "tovch":"2-3 өгүүлбэр эерэг танилцуулга, давуу талыг онцолсон",
  "udur":{"tsag_agaar":"${season} гэдгийг товч дурдсан","sanal":"өнөөдөр УБ-д өмсөхөд тохирох бүрэн хослолын санал, улиралд тохирсон"},
  "siluet":["тохирох хэлбэр/silhouette талаар 3-4 тодорхой зөвлөгөө"],
  "songoh":["илүү зохимжтой, нөхцөлд (${a.occasion}) тохирсон 2-3 зөвлөгөө"],
  "bolgoomj":["эерэгээр бичсэн, заавал биш гэдгийг сануулсан 2-3 зөвлөгөө"],
  "ongo":[{"ner":"өнгөний нэр","hex":"#XXXXXX"}],
  "us":["нүүрний хэлбэрт тохирох үсний засалтын 2-3 зөвлөгөө"],
  "outfit":[{"nohtsol":"нөхцөл","tailbar":"бүрэн хослолын тайлбар"}],
  "shopping":[{"zuil":"авбал зохих хувцасны төрөл","yagaad":"яагаад тохирохыг товч"}],
  "gutal":["биеийн хэлбэр, нөхцөлд тохирох гутлын зөвлөгөө"],
  "accessor":["нүүрний хэлбэр, стильд тохирох чихэвч, цүнх, аксессуарын зөвлөгөө"],
  "goo":["арьсны өнгөлөг, нүүрний онцлогт тохирох будалтын өнгө, хэлбэрийн зөвлөгөө"],
  "uliral":["одоогийн улиралд давхарлах, wardrobe-оо бэлтгэх зөвлөгөө"],
  "delguur":[{"ner":"Монголд байдаг дэлгүүр буюу зах зээлийн нэр","turul":"ямар хэрэгцээнд, ямар хувцас авахад тохиромжтой"}]
}
ongo дотор яг 6 өнгө, outfit дотор 2-3, shopping болон delguur дотор 3, gutal/accessor/goo/uliral дотор 2-3 зүйл байг.`;

  let content;
  if (hasPhoto) {
    content = [
      { type: "image", source: { type: "base64", media_type: a.selfie.mime || "image/jpeg", data: a.selfie.b64 } },
      { type: "text", text: promptText },
    ];
  } else {
    content = promptText;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 55000);
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model: MODEL, max_tokens: 4000, messages: [{ role: "user", content }] }),
    });
    clearTimeout(timeout);

    const data = await r.json();
    if (data.error) {
      console.error("Anthropic error:", data.error);
      return res.status(502).json({ error: "AI зөвлөгөө гаргахад алдаа гарлаа." });
    }

    let text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
    text = text.replace(/```json/g, "").replace(/```/g, "").trim();
    const s = text.indexOf("{"), e = text.lastIndexOf("}");
    if (s >= 0 && e >= 0) text = text.slice(s, e + 1);

    const report = JSON.parse(text);
    res.json(report);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Серверийн алдаа. Дахин оролдоно уу." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`MyStyle сервер аслаа: http://localhost:${PORT}`));
