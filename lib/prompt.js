// Стилистийн prompt болон Claude-д илгээх content-ийг бэлтгэнэ.

const MAX_WARDROBE = 20;

function buildContent(a) {
  const season = a.season || "тодорхойгүй улирал";
  const hasPhoto = !!(a.selfie && a.selfie.b64);
  const wardrobe = Array.isArray(a.wardrobe) ? a.wardrobe.filter((w) => w && w.b64).slice(0, MAX_WARDROBE) : [];
  const hasWardrobe = wardrobe.length > 0;

  const profile = `Хүйс: ${a.gender || "?"}
Өндөр: ${a.height || "?"} см, Жин: ${a.weight || "хэлээгүй"} кг
Биеийн хэлбэр: ${a.body || "?"}
Нүүрний хэлбэр: ${hasPhoto ? "(selfie зургаас тодорхойл)" : (a.face || "хэлээгүй")}
Арьсны өнгө: ${a.skin || "хэлээгүй"}, Өнгөлөг: ${a.undertone || "хэлээгүй"}
Дуртай стиль: ${a.style || "хэлээгүй"}
Нөхцөл: ${a.occasion || "?"}
Байршил: Улаанбаатар. Одоогийн улирал: ${season}`;

  const wardrobeNote = hasWardrobe
    ? ` Хавсаргасан "Хувцасны зураг #N" гэж тэмдэглэсэн ${wardrobe.length} зураг бол хэрэглэгчийн өөрийнх нь эзэмшдэг хувцас, гутал, аксессуар юм. Зураг бүрийг тус тусад нь ажиглаж, тухайн зурагны дугаарыг ("index") ашиглан төрөл (жишээ нь цамц, футболк, өмд, юбка, куртка, гутал, цүнх гэх мэт), үндсэн өнгө, материал/стилийг тодорхойл. Дараа нь ЗӨВХӨН эдгээр бодит хувцаснуудыг ашиглан (шинэ хувцас зохиомлоор нэмэхгүйгээр) хэрэглэгчийн нөхцөл, улиралд тохирсон бодит хослол (look) санал болго. Хослол бүрд аль зурагнуудыг ашигласнаа "indexuud" массивт дугаарлаж бич.`
    : "";

  const promptText = `Чи бол туршлагатай, эелдэг хувийн стилист. Доорх хүний мэдээлэлд тулгуурлан Монгол хэлээр хувийн стилийн зөвлөгөө гаргана уу.${hasPhoto ? " Хавсаргасан selfie зургаас нүүрний хэлбэр болон арьсны өнгөлгийг ажиглан тооцоонд аваарай." : ""}${wardrobeNote}

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
  "delguur":[{"ner":"Монголд байдаг дэлгүүр буюу зах зээлийн нэр","turul":"ямар хэрэгцээнд, ямар хувцас авахад тохиромжтой"}],
  "wardrobe":[{"index":"Хувцасны зураг #N дэх N тоо","torol":"хувцасны төрөл (жишээ нь цамц, өмд, гутал)","ongo":"үндсэн өнгө","tailbar":"материал/стилийн 3-5 үгэн тайлбар"}],
  "wardrobe_outfit":[{"nohtsol":"ямар үед өмсөхөд тохирох","indexuud":[ашигласан зурагны дугаарууд],"tailbar":"хослолын тайлбар, дутуу зүйл байвал юу нэмж авбал сайжрахыг товч дурд"}]
}
ongo дотор яг 6 өнгө, outfit дотор 2-3, shopping болон delguur дотор 3, gutal/accessor/goo/uliral дотор 2-3 зүйл байг. ${hasWardrobe ? "wardrobe массивт хавсаргасан хувцасны зураг тус бүрд яг нэг элемент байх ёстой (нийт " + wardrobe.length + " ширхэг), wardrobe_outfit дотор боломжит хослолын тоогоор (ихдээ 5) бич." : "Хувцасны зураг ирээгүй тул wardrobe болон wardrobe_outfit-ийг хоосон массив ([]) байлга."}`;

  let content;
  if (hasPhoto || hasWardrobe) {
    content = [];
    if (hasPhoto) {
      content.push({ type: "image", source: { type: "base64", media_type: a.selfie.mime || "image/jpeg", data: a.selfie.b64 } });
    }
    wardrobe.forEach((w, i) => {
      content.push({ type: "text", text: `Хувцасны зураг #${i + 1}:` });
      content.push({ type: "image", source: { type: "base64", media_type: w.mime || "image/jpeg", data: w.b64 } });
    });
    content.push({ type: "text", text: promptText });
  } else {
    content = promptText;
  }

  return { promptText, content, hasImages: hasPhoto || hasWardrobe, hasPhoto, wardrobeCount: wardrobe.length };
}

// Зураггүй хадгалах асуулгын хариултууд (тайлангийн жагсаалтад харуулах, дахин бөглөхөд)
function storableInput(a) {
  const keep = ["gender", "height", "weight", "body", "face", "skin", "undertone", "style", "occasion", "season"];
  const out = {};
  keep.forEach((k) => { if (a[k] !== undefined && a[k] !== null && a[k] !== "") out[k] = String(a[k]).slice(0, 100); });
  return out;
}

module.exports = { buildContent, storableInput, MAX_WARDROBE };
