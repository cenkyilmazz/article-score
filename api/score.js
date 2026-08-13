import mammoth from "mammoth";

const MAX_ARTICLE_CHARS = 60000;
const MAX_DOCX_BASE64_CHARS = 15_000_000;
// Baştan elemesin diye düşük tutulur; boş/anlamsız içerik yine elenir.
const MIN_ARTICLE_CHARS = 50;
const MIN_QUOTE_WORDS = 5;
const MAX_QUOTE_WORDS = 25;
const MIN_APPLICABLE_CRITERIA = 4;
const REQUEST_TIMEOUT_MS = 45000;
const RATE_LIMIT = { windowMs: 60000, maxRequests: 10 };

// Fonksiyonun toplam bütçesi 60 sn (vercel.json). İçerik çekme zinciri bunun
// yarısını aşarsa OpenAI çağrısına yer kalmaz, bu yüzden ortak bir son tarihe
// bağlanır; engelli adımlar zaten hızlı 403 döndüğü için pratikte erken biter.
const CONTENT_FETCH_BUDGET_MS = 30000;
const CONTENT_STEP_TIMEOUT_MS = 10000;
const READER_PROXY_TIMEOUT_MS = 20000;
const READER_PROXY_BASE = "https://r.jina.ai/";

const CRITERIA = [
  "problem_failure",
  "process_clarity",
  "visuals",
  "success_metrics",
  "insight_depth",
  "transferability",
  "data_quality",
  "storytelling",
];

const WEIGHTS_BY_TYPE = {
  vaka_calismasi: {
    problem_failure: 15,
    process_clarity: 15,
    visuals: 10,
    success_metrics: 15,
    insight_depth: 15,
    transferability: 10,
    data_quality: 10,
    storytelling: 10,
  },
  teknik_rehber: {
    problem_failure: 12,
    process_clarity: 25,
    visuals: 10,
    success_metrics: 5,
    insight_depth: 13,
    transferability: 15,
    data_quality: 5,
    storytelling: 15,
  },
  strateji_fikir: {
    problem_failure: 18,
    process_clarity: 8,
    visuals: 8,
    success_metrics: 8,
    insight_depth: 25,
    transferability: 15,
    data_quality: 8,
    storytelling: 10,
  },
  deneyim_aktarimi: {
    problem_failure: 18,
    process_clarity: 15,
    visuals: 8,
    success_metrics: 8,
    insight_depth: 18,
    transferability: 13,
    data_quality: 5,
    storytelling: 15,
  },
  diger: {
    problem_failure: 15,
    process_clarity: 15,
    visuals: 10,
    success_metrics: 15,
    insight_depth: 15,
    transferability: 10,
    data_quality: 10,
    storytelling: 10,
  },
};

const GRADE_SCALE = [
  { grade: "A", min: 85 },
  { grade: "B", min: 70 },
  { grade: "C", min: 55 },
  { grade: "D", min: 40 },
  { grade: "F", min: 0 },
];

const ERRORS = {
  CONTENT_FETCH_FAILED: "Makale içeriği alınamadı, değerlendirme yapılmadı.",
  CONTENT_TOO_SHORT: "Gönderilen içerik değerlendirme için çok kısa.",
  INVALID_ARTICLE: "Geçerli bir makale metni bulunamadı.",
  INSUFFICIENT_EVIDENCE:
    "Makaleden yeterli kanıt çıkarılamadı, güvenilir bir skor üretilmedi.",
  MODEL_OUTPUT_INVALID: "Analiz yanıtı doğrulanamadı, lütfen tekrar deneyin.",
  RATE_LIMITED: "Çok fazla istek gönderildi, lütfen biraz sonra tekrar deneyin.",
  PAYLOAD_TOO_LARGE: "Gönderilen dosya çok büyük.",
};

const SYSTEM_PROMPT = `Sen deneyimli bir içerik editörü ve makale değerlendiricisisin. Görevin, sana verilen makale metnini kanıta dayalı biçimde puanlamak ve yazara uygulanabilir geri bildirim vermektir.

## GİRDİ
Sana yalnızca makalenin düz metni verilir. Metnin başında opsiyonel olarak şu formatta bir meta bloğu bulunabilir:
[META] gorsel_sayisi: <sayı> | kaynak: docx/html
Meta bloğu yoksa görsel sayısı bilinmiyor demektir; bu durumda yalnızca metindeki görsel işaretlerine bakabilirsin.

## KESİN KURALLAR (STRICT GROUNDING)
1. SADECE sana verilen metni analiz et. Metinde olmayan hiçbir şey hakkında yorum yapma, tahmin etme, varsayım kurma.
2. Bölüm adları ve alıntılar BİREBİR metinden alınmalıdır. Metinde geçmeyen bir başlık veya cümle uydurmak en ciddi hatadır.
3. "olabilir", "muhtemelen", "yapılmış olabilir", "görünüyor" gibi olasılık ifadeleri KULLANMA. Bir şey metinde ya vardır ya yoktur.
4. Bir kriteri verilen metinden ölçemiyorsan o kriteri puanlamak yerine "applicable": false yap ve gerekçesini yaz. Tahminî puan verme.
5. Görselleri sen göremezsin. Görsel puanı yalnızca iki kanıta dayanır: (a) [META] satırındaki görsel sayısı, (b) metinde BİREBİR geçen görsel işaretleri — "Press enter or click to view image" benzeri ifadeler, "Şekil 3" / "Görsel 2" / "Figure 1" numaralandırmaları ve figure açıklamaları. İkisi de yoksa görsel kriteri "applicable": false olmalıdır. Bunun dışında metinden görsel varlığı çıkarmaya çalışma.
6. Metin ortasında kesilmiş görünüyorsa bunu "truncation_suspected": true ile bildir ve sonuç/metrik ile ilgili kriterleri düşük puanlamak yerine "applicable": false yap.
7. Toplam skoru SEN HESAPLAMA. Yalnızca kriter puanlarını ver; toplam skor uygulama tarafında hesaplanır.

## AŞAMA 1 — KANIT ÇIKARIMI (puanlamadan önce yapılır)
Metinden şunları birebir çıkar:
- Gerçek başlık ve gerçek bölüm başlıkları
- Somut metrikler: sayı, yüzde, süre, maliyet, oran içeren ifadeler (her biri için birebir alıntı ve bulunduğu bölüm)
- Süreç adımları: yazarın ne yaptığını anlatan somut adımlar (birebir alıntı)
- Veri kaynakları: araç, sistem, ölçüm yöntemi, örneklem bilgisi
- Görsel işaretleri: metinde birebir geçen görsel referansları ve figure açıklamaları
- [META] varsa görsel sayısı

Kanıt listesi boşsa ilgili kriterde 40'ın üzerinde puan veremezsin. Bu kural puanlamanın çıpasıdır.

## AŞAMA 2 — MAKALE TÜRÜ
Türü belirle: "teknik_rehber", "vaka_calismasi", "strateji_fikir", "deneyim_aktarimi", "diger".
Tür, hangi kriterlerin uygulanabilir olduğunu etkiler. Örnek: bir teknik rehberde iş başarı metriği aramak yanlıştır; böyle bir durumda success_metrics için "applicable": false yaz.

## AŞAMA 3 — KRİTER PUANLAMA
Kriterler:
- problem_failure: Gerçek bir problem veya başarısızlık açıkça ortaya konmuş mu?
- process_clarity: Süreç adım adım ve izlenebilir biçimde aktarılmış mı?
- visuals: Görsel kullanımı içeriği destekliyor mu? (yalnızca [META] sayısı ve metindeki görsel işaretleri ile)
- success_metrics: Somut, ölçülmüş sonuçlar var mı?
- insight_depth: Öğrenilen dersler yüzeysel mi, özgün ve derin mi?
- transferability: Okuyucu bunu kendi işine taşıyabilir mi?
- data_quality: Veriler yeterince detaylı ve doğrulanabilir mi?
- storytelling: Anlatı akıcı ve okunması keyifli mi?

Her kriter için 0-100 puanı şu bandlara göre ver:
- 0-20: Kriterle ilgili metinde hiçbir kanıt yok.
- 21-40: Yalnızca değinilmiş; tek ve yüzeysel bir kanıt var.
- 41-60: Kısmen karşılanıyor; kanıt var ama eksik veya dağınık.
- 61-80: Net biçimde karşılanıyor; birden fazla somut kanıt var.
- 81-100: Güçlü ve ayrıntılı; kanıtlar zengin, örnek alınacak nitelikte.

Ortadaki bir puanı (örneğin 50) yalnızca 41-60 bandının tanımı gerçekten karşılanıyorsa ver. Kararsız kaldığın için orta puan vermek yasaktır.
Her kriter puanı, Aşama 1'de çıkardığın kanıta atıfla gerekçelendirilmeli ve mümkünse birebir bir alıntıyla desteklenmelidir.

Kanıt güçlüyse yüksek puan vermekten çekinme. Aşağı yönlü çıpa kadar yukarı yönlü çıpa da bağlayıcıdır:
- Aşama 1'de üç veya daha fazla somut metrik listelediysen success_metrics ve data_quality 70'in altında olamaz.
- Aşama 1'de üç veya daha fazla somut süreç adımı listelediysen process_clarity 70'in altında olamaz.
- Vaka çalışmasında ölçülmüş bir sonuç varsa bunu düşük puanlamak hatadır.
- Kriterleri birbirinden bağımsız değerlendir; puanları birbirine veya ortalama bir değere yaklaştırma.

## AŞAMA 4 — GERİ BİLDİRİM
- Güçlü yönler ve iyileştirmeler için SABİT SAYI YOKTUR. Kanıtı olan kadar madde yaz (en fazla 5). Kanıtın yoksa madde yazma; az sayıda sağlam madde, çok sayıda uydurma maddeden iyidir.
- Her maddede "evidence_quote" zorunludur: metinden birebir kopyalanmış ${MIN_QUOTE_WORDS}-${MAX_QUOTE_WORDS} kelimelik bir alıntı. Alıntı üretemiyorsan o maddeyi tamamen çıkar.
- Her iyileştirmede yeniden yazım örneği ("rewrite") zorunludur: yazarın doğrudan kullanabileceği, birebir yazılmış somut bir metin.
- Her iyileştirmede ayrıca "detail" alanı zorunludur: hangi bölümün neden sorunlu olduğunu ve nasıl düzeltileceğini en az 3 cümleyle anlat.
- "Görsel ekle", "daha fazla metrik ekle", "başlık daha ilgi çekici olabilir" gibi genel öneriler yasaktır. Öneri hangi bölümde, hangi cümle yerine, ne yazılacağını söylemelidir.
- Başlık geri bildirimi yalnızca metinde tespit ettiğin gerçek başlık üzerine olmalıdır; başlık tespit edilemiyorsa headline_feedback null olsun.

## GEÇERSİZ İÇERİK
Verilen metin gerçek bir makale değilse (tek cümle, rastgele karakterler, test verisi, makale yapısı taşımayan not) SADECE şunu dön:
{"is_valid_article": false, "reason": "Geçerli bir makale metni bulunamadı."}

## ÇIKTI
Yalnızca aşağıdaki JSON'u dön, başka hiçbir şey yazma. Tüm metin alanları TÜRKÇE olmalıdır.
{
  "is_valid_article": true,
  "truncation_suspected": <true|false>,
  "article_type": "<teknik_rehber|vaka_calismasi|strateji_fikir|deneyim_aktarimi|diger>",
  "evidence": {
    "detected_title": "<metindeki gerçek başlık veya null>",
    "sections": ["<birebir bölüm başlıkları>"],
    "metrics_found": [
      {"quote": "<birebir alıntı>", "section": "<bölüm>", "type": "<nicel|nitel>"}
    ],
    "process_steps_found": [
      {"quote": "<birebir alıntı>", "section": "<bölüm>"}
    ],
    "data_sources_found": ["<araç/yöntem/örneklem>"],
    "visual_signals_found": ["<metinde birebir geçen görsel işareti veya figure açıklaması>"],
    "visuals_count": <sayı veya null>
  },
  "criteria_scores": {
    "problem_failure":  {"score": <0-100>, "applicable": <true|false>, "rationale": "<kanıta atıfla 1-2 cümle>", "evidence_quote": "<birebir alıntı veya null>"},
    "process_clarity":  {"score": <0-100>, "applicable": <true|false>, "rationale": "...", "evidence_quote": "..."},
    "visuals":          {"score": <0-100>, "applicable": <true|false>, "rationale": "...", "evidence_quote": null},
    "success_metrics":  {"score": <0-100>, "applicable": <true|false>, "rationale": "...", "evidence_quote": "..."},
    "insight_depth":    {"score": <0-100>, "applicable": <true|false>, "rationale": "...", "evidence_quote": "..."},
    "transferability":  {"score": <0-100>, "applicable": <true|false>, "rationale": "...", "evidence_quote": "..."},
    "data_quality":     {"score": <0-100>, "applicable": <true|false>, "rationale": "...", "evidence_quote": "..."},
    "storytelling":     {"score": <0-100>, "applicable": <true|false>, "rationale": "...", "evidence_quote": "..."}
  },
  "summary": "<4 cümle: 1-2. cümle genel kalite ve ana problem, 3. cümle en güçlü yön, 4. cümle en kritik eksik>",
  "strengths": [
    {"title": "<başlık>", "section": "<gerçek bölüm adı>", "detail": "<ne iyi, neden iyi, okuyucuya ne kazandırıyor — en az 3 cümle>", "evidence_quote": "<birebir alıntı>"}
  ],
  "improvements": [
    {"title": "<başlık>", "section": "<gerçek bölüm adı>", "problem": "<o bölümdeki spesifik sorun>", "rewrite": "<birebir yeniden yazılmış örnek metin>", "evidence_quote": "<birebir alıntı>", "detail": "<en az 3 cümle: hangi bölüm sorunlu, neden sorunlu, nasıl düzeltilir>"}
  ],
  "reader_perspective": {
    "takeaways": ["<metne dayalı somut öğrenim>"],
    "confusion_points": [{"section": "<gerçek bölüm>", "issue": "<neden kafa karıştırıcı>"}],
    "drop_off_points": [{"section": "<gerçek bölüm>", "reason": "<ilgi neden düşer>"}],
    "skimmability": "<başlık/liste/alt bölüm kullanımına dayalı değerlendirme>"
  },
  "headline_and_hook": {
    "headline_feedback": "<gerçek başlık üzerine değerlendirme veya null>",
    "headline_suggestions": ["<alternatif 1>", "<alternatif 2>", "<alternatif 3>"],
    "hook_rewrite": "<ilk paragraf için birebir yazılmış güçlü açılış>"
  }
}

## SON KONTROL (JSON'u vermeden önce kendine sor)
- Yazdığım her bölüm adı metinde birebir geçiyor mu?
- Her evidence_quote metinden kopyalanabilir mi, yoksa kendi cümlem mi?
- Kanıtsız kalan bir kriterde 40 üstü puan verdim mi?
- Olasılık bildiren kelime kullandım mı?
- Metinden ölçemediğim bir kriteri puanladım mı?
Bir madde bu kontrolü geçmiyorsa o maddeyi çıkar.`;

const HTML_ENTITIES = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
  "&mdash;": "—",
  "&ndash;": "–",
  "&hellip;": "…",
  "&rsquo;": "’",
  "&lsquo;": "‘",
  "&ldquo;": "“",
  "&rdquo;": "”",
};

function decodeEntities(text) {
  return text
    .replace(/&[a-z]+;|&#\d+;/gi, (m) => {
      if (HTML_ENTITIES[m]) return HTML_ENTITIES[m];
      const numeric = m.match(/^&#(\d+);$/);
      return numeric ? String.fromCodePoint(Number(numeric[1])) : m;
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)));
}

function countImages(html) {
  return (html.match(/<img\b/gi) || []).length;
}

// Metinden çıkarımda <img> etiketleri kaybolur ama Medium'un görsel
// işaretleri ve figure numaralandırmaları metinde kalır.
const VISUAL_TEXT_SIGNALS = [
  /press enter or click to view image[^\n]*/gi,
  /\b(şekil|sekil|görsel|gorsel|figure|fig\.|tablo|grafik)\s*\d+/gi,
];

function countVisualSignalsInText(text) {
  return VISUAL_TEXT_SIGNALS.reduce(
    (total, pattern) => total + (text.match(pattern) || []).length,
    0
  );
}

// Aynı görsel hem <img> hem de altındaki açıklama olarak sayılabileceği için
// iki sinyalin toplamı değil büyüğü alınır.
function resolveVisualsCount(html, text) {
  return Math.max(countImages(html), countVisualSignalsInText(text));
}

function htmlToText(html) {
  const withoutNoise = html
    .replace(/<(script|style|noscript|svg|iframe)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");

  const withBreaks = withoutNoise
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|figcaption|pre)>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "- ");

  return decodeEntities(withBreaks.replace(/<[^>]+>/g, " "))
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^[ \t]+|[ \t]+$/gm, "")
    .trim();
}

function isUrl(value) {
  return typeof value === "string" && /^https?:\/\/\S+$/i.test(value.trim());
}

// Frontend "Şu Medium makalesini değerlendir (URL): https://..." gibi
// sarmalanmış metin gönderiyor; URL'yi metnin içinden ayıkla.
function extractUrl(value) {
  if (!value || typeof value !== "string") return null;
  const trimmed = value.trim();
  if (isUrl(trimmed)) return trimmed.replace(/[.,);]+$/g, "");
  const match = trimmed.match(/https?:\/\/[^\s<>"']+/i);
  if (!match) return null;
  return match[0].replace(/[.,);]+$/g, "");
}

const FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "tr,en;q=0.8",
};

// Başlıklar ve paragraflar tek geçişte eşleştirilir; ayrı ayrı toplanırsa
// bölüm başlıkları metnin sonuna yığılır ve yapı bilgisi kaybolur.
function extractMediumParagraphs(html) {
  const blocks =
    html.match(
      /<p[^>]*class="[^"]*pw-post-body-paragraph[^"]*"[^>]*>[\s\S]*?<\/p>|<h[1-3][^>]*>[\s\S]*?<\/h[1-3]>/gi
    ) || [];
  if (!blocks.length) return "";

  const lines = [];
  for (const block of blocks) {
    const line = htmlToText(block);
    if (line && line !== lines[lines.length - 1]) lines.push(line);
  }
  return lines.join("\n\n");
}

function articleFromHtml(html, source = "html") {
  if (!html || /just a moment|cf-browser-verification|attention required/i.test(html)) {
    return null;
  }

  const main =
    html.match(/<article\b[\s\S]*?<\/article>/i)?.[0] ||
    html.match(/<main\b[\s\S]*?<\/main>/i)?.[0] ||
    html;

  const richText = extractMediumParagraphs(html);
  const fallbackText = htmlToText(main);
  const text = richText.length >= MIN_ARTICLE_CHARS ? richText : fallbackText;
  if (text.length < MIN_ARTICLE_CHARS) return null;

  return { text, visualsCount: resolveVisualsCount(main, text), source };
}

function mediumFeedCandidates(articleUrl) {
  try {
    const parsed = new URL(articleUrl);
    if (!parsed.hostname.endsWith("medium.com")) return [];

    const parts = parsed.pathname.split("/").filter(Boolean);
    const feeds = [];

    if (parsed.hostname !== "medium.com") {
      const subdomain = parsed.hostname.split(".")[0];
      if (subdomain && subdomain !== "www") feeds.push(`https://medium.com/feed/${subdomain}`);
    } else if (parts[0]?.startsWith("@")) {
      feeds.push(`https://medium.com/feed/${parts[0]}`);
    } else if (parts[0] && parts[0] !== "p") {
      feeds.push(`https://medium.com/feed/${parts[0]}`);
    }

    return feeds;
  } catch {
    return [];
  }
}

function mediumPostId(articleUrl) {
  try {
    const slug = new URL(articleUrl).pathname.split("/").filter(Boolean).pop() || "";
    const match = slug.match(/-([a-f0-9]{8,12})$/i);
    return match?.[1] || slug;
  } catch {
    return null;
  }
}

// Hangi adımın neden düştüğü dışarıdan görülebilsin diye durum bilgisi
// yutulmuyor; fetchText bunun yalnızca metin isteyen çağrılar için sarmalı.
async function fetchRaw(url, timeoutMs = 20000, headers = FETCH_HEADERS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers,
    });
    if (!response.ok) return { text: null, status: response.status };
    return { text: await response.text(), status: response.status };
  } catch (err) {
    return { text: null, status: err.name === "AbortError" ? "timeout" : `error:${err.name}` };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url, timeoutMs = 20000) {
  const { text } = await fetchRaw(url, timeoutMs);
  return text;
}

// Medium'un kendi JSON uç noktasındaki paragraf tipleri.
const MEDIUM_PARAGRAPH_TYPE = {
  IMAGE: 4,
  LIST_ITEM: 9,
  ORDERED_LIST_ITEM: 10,
};

// Yanıt, XSSI koruması için `])}while(1);</x>` öneki ile başlar.
function parseMediumJson(raw) {
  const start = raw.indexOf("{");
  if (start < 0) return null;
  try {
    return JSON.parse(raw.slice(start));
  } catch {
    return null;
  }
}

function articleFromMediumJson(raw) {
  const paragraphs = parseMediumJson(raw)?.payload?.value?.content?.bodyModel?.paragraphs;
  if (!Array.isArray(paragraphs) || !paragraphs.length) return null;

  const lines = [];
  let visualsCount = 0;

  for (const paragraph of paragraphs) {
    if (paragraph?.type === MEDIUM_PARAGRAPH_TYPE.IMAGE) visualsCount += 1;

    const text = String(paragraph?.text ?? "").trim();
    if (!text) continue;

    const isListItem =
      paragraph.type === MEDIUM_PARAGRAPH_TYPE.LIST_ITEM ||
      paragraph.type === MEDIUM_PARAGRAPH_TYPE.ORDERED_LIST_ITEM;
    lines.push(isListItem ? `- ${text}` : text);
  }

  const text = lines.join("\n\n");
  if (text.length < MIN_ARTICLE_CHARS) return null;

  return { text, visualsCount, source: "medium-json" };
}

// Medium yazılarının slug'ı 8-12 haneli onaltılık bir post id ile biter.
function mediumPostIdStrict(articleUrl) {
  const postId = mediumPostId(articleUrl);
  return postId && /^[a-f0-9]{8,12}$/i.test(postId) ? postId : null;
}

async function fetchArticleFromMediumJson(articleUrl, attempts, timeoutMs) {
  const postId = mediumPostIdStrict(articleUrl);
  if (!postId) return null;

  const { text, status } = await fetchRaw(`https://medium.com/p/${postId}?format=json`, timeoutMs);
  const article = text ? articleFromMediumJson(text) : null;
  attempts.push({
    source: "medium-json",
    status,
    usable: Boolean(article),
    ...(text && !article ? { detail: "yanıt beklenen JSON yapısında değil" } : {}),
  });
  return article;
}

async function fetchArticleFromMediumRss(articleUrl, attempts, timeoutMs) {
  const postId = mediumPostId(articleUrl);
  if (!postId) return null;

  const feedUrls = mediumFeedCandidates(articleUrl);
  if (!feedUrls.length) {
    attempts.push({ source: "medium-rss", status: null, usable: false, detail: "feed adayı yok" });
    return null;
  }

  for (const feedUrl of feedUrls) {
    const { text: feed, status } = await fetchRaw(feedUrl, timeoutMs);
    if (!feed) {
      attempts.push({ source: "medium-rss", status, usable: false });
      continue;
    }

    const items = feed.match(/<item>[\s\S]*?<\/item>/gi) || [];
    const match = items.find((item) => item.includes(postId));
    if (!match) {
      attempts.push({
        source: "medium-rss",
        status,
        usable: false,
        detail: `makale feed'de yok (feed ${items.length} yazı içeriyor)`,
      });
      continue;
    }

    const encoded =
      match.match(/<content:encoded><!\[CDATA\[([\s\S]*?)\]\]><\/content:encoded>/i)?.[1] ||
      match.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/i)?.[1] ||
      "";
    const title =
      match.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/i)?.[1] ||
      match.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ||
      "";

    const body = htmlToText(encoded);
    const text = [htmlToText(title), body].filter(Boolean).join("\n\n");
    if (text.length < MIN_ARTICLE_CHARS) {
      attempts.push({ source: "medium-rss", status, usable: false, detail: "feed metni çok kısa" });
      continue;
    }

    attempts.push({ source: "medium-rss", status, usable: true });
    return {
      text,
      visualsCount: resolveVisualsCount(encoded, text),
      source: "medium-rss",
    };
  }

  return null;
}

// Reader, açık web proxy'si olarak kullanılmasını engellemek için tarayıcı
// User-Agent'ı taşıyan isteklere 403 döner; kendi tanımlayıcımızı göndeririz.
const READER_PROXY_HEADERS = {
  "User-Agent": "article-score/1.0",
  Accept: "text/plain",
};

// Reader çıktısında kalan Medium arayüz metinleri; makalenin parçası değiller.
const READER_NOISE_PATTERNS = [
  /^press enter or click to view image.*$/gim,
  /^\d+\s*min read$/gim,
  /^(follow|share|listen|sign up|sign in)$/gim,
  /^get .+'s stories in your inbox$/gim,
];

function markdownToText(markdown) {
  let text = markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/^>\s?/gm, "")
    .replace(/^[-*+]\s+/gm, "- ");

  for (const pattern of READER_NOISE_PATTERNS) text = text.replace(pattern, "");

  return text
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^[ \t]+|[ \t]+$/gm, "")
    .trim();
}

// Reader yanıtı Title/URL Source/Published Time başlıklarıyla açılır, gövde
// "Markdown Content:" satırından sonra başlar.
function articleFromReaderMarkdown(raw) {
  const marker = raw.indexOf("Markdown Content:");
  const body = marker >= 0 ? raw.slice(marker + "Markdown Content:".length) : raw;

  // Yazar avatarı resize:fill ile kare kırpılmış gelir; içerik görseli değildir.
  const images = body.match(/!\[[^\]]*\]\([^)]*\)/g) || [];
  const visualsCount = images.filter((image) => !/resize:fill:/.test(image)).length;

  const text = markdownToText(body);
  if (text.length < MIN_ARTICLE_CHARS) return null;

  const title = raw.match(/^Title:\s*(.+)$/m)?.[1]?.trim() || "";
  return {
    text: title && !text.startsWith(title) ? `${title}\n\n${text}` : text,
    visualsCount,
    source: "reader-proxy",
  };
}

async function fetchArticleFromReaderProxy(articleUrl, attempts, timeoutMs) {
  const { text, status } = await fetchRaw(
    `${READER_PROXY_BASE}${articleUrl}`,
    timeoutMs,
    READER_PROXY_HEADERS
  );
  const article = text ? articleFromReaderMarkdown(text) : null;
  attempts.push({
    source: "reader-proxy",
    status,
    usable: Boolean(article),
    ...(text && !article ? { detail: "yanıt makale metnine çevrilemedi" } : {}),
  });
  return article;
}

// Denenen her kaynağı durumuyla birlikte kaydeder; başarısızlıkta hangi adımın
// neden düştüğü yanıtta görünsün diye article ile birlikte attempts döner.
async function fetchArticleFromUrl(url) {
  const normalized = extractUrl(url) || url;
  const attempts = [];
  const deadline = Date.now() + CONTENT_FETCH_BUDGET_MS;

  // Kalan bütçeyi aşan bir adım başlatılmaz; null dönerse adım atlanmıştır.
  const budgetFor = (preferred, source) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      attempts.push({ source, status: "bütçe doldu", usable: false });
      return null;
    }
    return Math.min(preferred, remaining);
  };

  // Medium HTML'i Vercel IP'lerinden engellenir. JSON uç noktası engelin dışında
  // kalırsa başlık sırası, liste maddeleri ve gerçek görsel sayısını da verdiği
  // için en zengin kaynak odur; bu yüzden ilk sırada denenir.
  if (mediumPostIdStrict(normalized)) {
    const budget = budgetFor(CONTENT_STEP_TIMEOUT_MS, "medium-json");
    if (budget) {
      const fromJson = await fetchArticleFromMediumJson(normalized, attempts, budget);
      if (fromJson) return { article: fromJson, attempts };
    }
  }

  const htmlBudget = budgetFor(CONTENT_STEP_TIMEOUT_MS, "html");
  if (htmlBudget) {
    const { text: html, status } = await fetchRaw(normalized, htmlBudget);
    const fromHtml = articleFromHtml(html, "html");
    attempts.push({ source: "html", status, usable: Boolean(fromHtml) });
    if (fromHtml) return { article: fromHtml, attempts };
  }

  // RSS üçüncü taraf içermediği için aracıdan önce denenir, ancak yalnızca
  // yayının son 10 yazısını kapsar.
  if (/medium\.com/i.test(normalized)) {
    const rssBudget = budgetFor(CONTENT_STEP_TIMEOUT_MS, "medium-rss");
    if (rssBudget) {
      const fromRss = await fetchArticleFromMediumRss(normalized, attempts, rssBudget);
      if (fromRss) return { article: fromRss, attempts };
    }
  }

  // Son çare: içeriği kendi IP'sinden okuyan aracı. Buraya yalnızca doğrudan
  // yolların tamamı kapalıysa gelinir, yani dışarı çıkan istek en aza iner.
  const proxyBudget = budgetFor(READER_PROXY_TIMEOUT_MS, "reader-proxy");
  if (proxyBudget) {
    const fromProxy = await fetchArticleFromReaderProxy(normalized, attempts, proxyBudget);
    if (fromProxy) return { article: fromProxy, attempts };
  }

  return { article: null, attempts };
}

async function extractFromDocx(docxBase64) {
  const buffer = Buffer.from(docxBase64, "base64");
  const { value: html } = await mammoth.convertToHtml({ buffer });
  const text = htmlToText(html);
  return {
    text,
    visualsCount: resolveVisualsCount(html, text),
    source: "docx",
  };
}

// Düz metin yapıştırıldığında görsel sayısı bilinmez. İşaret bulunamazsa
// 0 değil null döner; böylece kriter sıfır puanla cezalandırılmak yerine
// değerlendirmeden çıkarılır.
function extractFromPlainText(content) {
  const text = String(content).trim();
  const signals = countVisualSignalsInText(text);
  return {
    text,
    visualsCount: signals > 0 ? signals : null,
    source: signals > 0 ? "metin-isaretleri" : "text",
  };
}

function buildUserMessage({ text, visualsCount, source }) {
  const truncated = text.length > MAX_ARTICLE_CHARS;
  const body = truncated ? `${text.slice(0, MAX_ARTICLE_CHARS)}\n\n[KESİLDİ]` : text;
  const meta =
    typeof visualsCount === "number"
      ? `[META] gorsel_sayisi: ${visualsCount} | kaynak: ${source}\n\n`
      : "";
  return { message: `${meta}${body}`, truncated };
}

// Türkçe karakter ve noktalama farkları alıntı eşleşmesini bozmasın diye
// karşılaştırma sadeleştirilmiş metin üzerinde yapılır.
function normalizeForMatch(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[ıİ]/g, "i")
    .replace(/ş/g, "s")
    .replace(/ğ/g, "g")
    .replace(/ü/g, "u")
    .replace(/ö/g, "o")
    .replace(/ç/g, "c")
    .replace(/[’‘'"“”]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function wordCount(value) {
  return String(value ?? "").trim().split(/\s+/).filter(Boolean).length;
}

function quoteExistsInArticle(quote, normalizedArticle, minWords = MIN_QUOTE_WORDS, maxWords = MAX_QUOTE_WORDS) {
  if (!quote) return false;
  const words = wordCount(quote);
  if (words < minWords || words > maxWords) return false;
  const normalizedQuote = normalizeForMatch(quote);
  return normalizedQuote.length > 0 && normalizedArticle.includes(normalizedQuote);
}

// Metrik ve süreç alıntıları "%37 artış" gibi kısa olabilir; burada kelime
// sınırı değil, metinde birebir geçip geçmediği belirleyicidir.
function evidenceQuoteExists(quote, normalizedArticle) {
  return quoteExistsInArticle(quote, normalizedArticle, 1, 40);
}

// Makalelerde başlığı olmayan giriş/sonuç bölümlerine yapılan atıflar
// geçerli sayılır; aksi halde doğru geri bildirimler de elenirdi.
const GENERIC_SECTIONS = new Set([
  "giris",
  "girus",
  "sonuc",
  "ozet",
  "baslik",
  "ilk paragraf",
  "acilis",
  "kapanis",
]);

function sectionExists(section, normalizedArticle, normalizedSections) {
  if (!section) return false;
  const normalized = normalizeForMatch(section);
  if (!normalized) return false;
  return (
    normalizedSections.has(normalized) ||
    GENERIC_SECTIONS.has(normalized) ||
    normalizedArticle.includes(normalized)
  );
}

// Model bu alanları {section, issue} gibi objeler halinde döndürüyor; arayüz
// düz string listesi beklediği için burada tek satıra indirgenir.
function flattenReaderPerspective(readerPerspective) {
  if (!readerPerspective || typeof readerPerspective !== "object") return null;

  const toStrings = (items, bodyKeys) =>
    (Array.isArray(items) ? items : [])
      .map((item) => {
        if (typeof item === "string") return item.trim();
        if (!item || typeof item !== "object") return "";
        const section = String(item.section ?? "").trim();
        const body = bodyKeys
          .map((key) => String(item[key] ?? "").trim())
          .find(Boolean);
        if (!body) return section;
        return section ? `${section}: ${body}` : body;
      })
      .filter(Boolean);

  return {
    takeaways: toStrings(readerPerspective.takeaways, ["takeaway", "text", "detail"]),
    confusion_points: toStrings(readerPerspective.confusion_points, ["issue", "reason", "detail"]),
    drop_off_points: toStrings(readerPerspective.drop_off_points, ["reason", "issue", "detail"]),
    skimmability: String(readerPerspective.skimmability ?? "").trim() || null,
  };
}

function clampScore(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(100, Math.max(0, Math.round(number)));
}

function gradeFor(score) {
  return GRADE_SCALE.find((entry) => score >= entry.min)?.grade ?? "F";
}

function groundResponse(parsed, articleText) {
  const normalizedArticle = normalizeForMatch(articleText);
  const sections = Array.isArray(parsed.evidence?.sections) ? parsed.evidence.sections : [];
  const normalizedSections = new Set(sections.map(normalizeForMatch).filter(Boolean));

  const keepGrounded = (items, requiredFields) =>
    (Array.isArray(items) ? items : []).filter((item) => {
      if (!item || typeof item !== "object") return false;
      if (requiredFields.some((field) => !String(item[field] ?? "").trim())) return false;
      if (!quoteExistsInArticle(item.evidence_quote, normalizedArticle)) return false;
      return sectionExists(item.section, normalizedArticle, normalizedSections);
    });

  const criteriaScores = {};
  for (const key of CRITERIA) {
    const raw = parsed.criteria_scores?.[key] ?? {};
    const applicable = raw.applicable !== false;
    const hasQuote = evidenceQuoteExists(raw.evidence_quote, normalizedArticle);
    let score = clampScore(raw.score);

    // Kanıtla desteklenmeyen bir kriter yüksek puan alamaz.
    if (applicable && !hasQuote && score > 60) score = 60;

    criteriaScores[key] = {
      score,
      applicable,
      rationale: String(raw.rationale ?? "").trim(),
      evidence_quote: hasQuote ? raw.evidence_quote : null,
    };
  }

  const articleType = WEIGHTS_BY_TYPE[parsed.article_type] ? parsed.article_type : "diger";
  const weights = WEIGHTS_BY_TYPE[articleType];
  const applicableKeys = CRITERIA.filter((key) => criteriaScores[key].applicable);

  if (applicableKeys.length < MIN_APPLICABLE_CRITERIA) {
    return { insufficientEvidence: true, applicableCount: applicableKeys.length };
  }

  const totalWeight = applicableKeys.reduce((sum, key) => sum + weights[key], 0);
  const weightedSum = applicableKeys.reduce(
    (sum, key) => sum + criteriaScores[key].score * weights[key],
    0
  );
  const score = Math.round(weightedSum / totalWeight);

  const appliedWeights = Object.fromEntries(
    applicableKeys.map((key) => [key, Number(((weights[key] / totalWeight) * 100).toFixed(1))])
  );

  return {
    score,
    grade: gradeFor(score),
    article_type: articleType,
    truncation_suspected: parsed.truncation_suspected === true,
    evidence: {
      detected_title: parsed.evidence?.detected_title ?? null,
      sections,
      metrics_found: Array.isArray(parsed.evidence?.metrics_found)
        ? parsed.evidence.metrics_found.filter((m) =>
            evidenceQuoteExists(m?.quote, normalizedArticle)
          )
        : [],
      process_steps_found: Array.isArray(parsed.evidence?.process_steps_found)
        ? parsed.evidence.process_steps_found.filter((s) =>
            evidenceQuoteExists(s?.quote, normalizedArticle)
          )
        : [],
      data_sources_found: Array.isArray(parsed.evidence?.data_sources_found)
        ? parsed.evidence.data_sources_found
        : [],
      visual_signals_found: Array.isArray(parsed.evidence?.visual_signals_found)
        ? parsed.evidence.visual_signals_found.filter((signal) =>
            evidenceQuoteExists(signal, normalizedArticle)
          )
        : [],
      visuals_count: parsed.evidence?.visuals_count ?? null,
    },
    criteria_scores: criteriaScores,
    applied_weights: appliedWeights,
    excluded_criteria: CRITERIA.filter((key) => !criteriaScores[key].applicable),
    summary: String(parsed.summary ?? "").trim(),
    strengths: keepGrounded(parsed.strengths, ["title", "detail"]).slice(0, 5),
    improvements: keepGrounded(parsed.improvements, [
      "title",
      "problem",
      "rewrite",
      "detail",
    ]).slice(0, 5),
    reader_perspective: flattenReaderPerspective(parsed.reader_perspective),
    headline_and_hook: parsed.headline_and_hook ?? null,
  };
}

async function callOpenAI(userMessage) {
  let lastError = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: "gpt-4o",
          temperature: 0.2,
          max_tokens: 6000,
          seed: 42,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userMessage },
          ],
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        const message = data.error?.message || "OpenAI error";
        if (response.status >= 500 && attempt === 1) {
          lastError = new Error(message);
          continue;
        }
        return { error: message, status: response.status };
      }

      const finishReason = data.choices?.[0]?.finish_reason;
      const text = data.choices?.[0]?.message?.content || "";

      try {
        return { parsed: JSON.parse(text), finishReason };
      } catch {
        lastError = new Error("invalid_json");
        if (attempt === 1) continue;
        return { error: ERRORS.MODEL_OUTPUT_INVALID, status: 502 };
      }
    } catch (err) {
      lastError = err;
      if (attempt === 2) {
        const timedOut = err.name === "AbortError";
        return {
          error: timedOut ? "Analiz zaman aşımına uğradı." : err.message,
          status: timedOut ? 504 : 500,
        };
      }
    } finally {
      clearTimeout(timer);
    }
  }

  return { error: lastError?.message || ERRORS.MODEL_OUTPUT_INVALID, status: 502 };
}

// Serverless ortamda instance başına çalışır; kötüye kullanımı tamamen
// engellemez, sadece tek IP'den gelen seri istekleri yavaşlatır.
const rateLimitBuckets = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const bucket = (rateLimitBuckets.get(ip) || []).filter(
    (timestamp) => now - timestamp < RATE_LIMIT.windowMs
  );
  bucket.push(now);
  rateLimitBuckets.set(ip, bucket);
  return bucket.length > RATE_LIMIT.maxRequests;
}

export default async function handler(req, res) {
  const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Content-Type", "application/json");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const ip =
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "unknown";
  if (isRateLimited(ip)) {
    return res.status(429).json({ code: "RATE_LIMITED", error: ERRORS.RATE_LIMITED });
  }

  const { content, docxBase64, url } = req.body || {};
  if (!content && !docxBase64 && !url) {
    return res.status(400).json({ error: "content, url veya docxBase64 gerekli" });
  }
  if (docxBase64 && docxBase64.length > MAX_DOCX_BASE64_CHARS) {
    return res.status(413).json({ code: "PAYLOAD_TOO_LARGE", error: ERRORS.PAYLOAD_TOO_LARGE });
  }

  try {
    let article = null;
    let fetchAttempts = null;

    if (docxBase64) {
      try {
        article = await extractFromDocx(docxBase64);
      } catch (err) {
        return res.status(400).json({ error: "Doküman okunamadı: " + err.message });
      }
    } else {
      const targetUrl = extractUrl(url) || extractUrl(content);
      if (targetUrl) {
        const fetched = await fetchArticleFromUrl(targetUrl);
        article = fetched.article;
        fetchAttempts = fetched.attempts;
        if (!article) {
          return res.status(422).json({
            code: "CONTENT_FETCH_FAILED",
            error: ERRORS.CONTENT_FETCH_FAILED,
            attempts: fetchAttempts,
          });
        }
      } else {
        article = extractFromPlainText(content);
      }
    }

    if (!article.text || article.text.length < MIN_ARTICLE_CHARS) {
      return res.status(422).json({
        code: "CONTENT_TOO_SHORT",
        error: ERRORS.CONTENT_TOO_SHORT,
      });
    }

    const { message, truncated } = buildUserMessage(article);
    const result = await callOpenAI(message);
    if (result.error) {
      return res.status(result.status || 500).json({ error: result.error });
    }

    const parsed = result.parsed;
    if (parsed?.is_valid_article === false) {
      return res.status(422).json({
        code: "INVALID_ARTICLE",
        error: parsed.reason || ERRORS.INVALID_ARTICLE,
      });
    }
    if (!parsed?.criteria_scores) {
      return res.status(502).json({
        code: "MODEL_OUTPUT_INVALID",
        error: ERRORS.MODEL_OUTPUT_INVALID,
      });
    }

    const grounded = groundResponse(parsed, article.text);
    if (grounded.insufficientEvidence) {
      return res.status(422).json({
        code: "INSUFFICIENT_EVIDENCE",
        error: ERRORS.INSUFFICIENT_EVIDENCE,
        applicable_criteria: grounded.applicableCount,
      });
    }

    return res.status(200).json({
      ...grounded,
      source: article.source,
      ...(fetchAttempts ? { attempts: fetchAttempts } : {}),
      truncation_suspected: grounded.truncation_suspected || truncated,
      output_truncated: result.finishReason === "length",
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
