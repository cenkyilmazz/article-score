exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const { content } = JSON.parse(event.body || "{}");
  if (!content) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "content is required" }) };
  }

  const SYSTEM_PROMPT = `Sen bir Medium makale editörü ve içerik stratejistisin. Sana verilen makaleyi veya makale URL'sini analiz edip aşağıdaki formatta JSON döndür.

Değerlendirme kriterleri:
- Başlık çekiciliği ve SEO uyumu
- Giriş paragrafının gücü (hook)
- Akış ve okunabilirlik
- Derinlik ve özgünlük
- Pratik değer ve uygulanabilirlik
- Görsel yapı (başlıklar, paragraflar, listeler)
- Sonuç ve call-to-action
- Dil ve ton tutarlılığı

SADECE şu JSON formatında yanıt ver, başka hiçbir şey yazma:
{
  "score": <0-100 arası sayı>,
  "grade": "<A+/A/A-/B+/B/B-/C+/C/C-/D/F>",
  "summary": "<2 cümlelik genel değerlendirme>",
  "strengths": [
    {"title": "<güçlü yön başlığı>", "detail": "<açıklama>"},
    {"title": "<güçlü yön başlığı>", "detail": "<açıklama>"},
    {"title": "<güçlü yön başlığı>", "detail": "<açıklama>"},
    {"title": "<güçlü yön başlığı>", "detail": "<açıklama>"}
  ],
  "improvements": [
    {"title": "<geliştirme başlığı>", "detail": "<nasıl geliştirilebilir>"},
    {"title": "<geliştirme başlığı>", "detail": "<nasıl geliştirilebilir>"},
    {"title": "<geliştirme başlığı>", "detail": "<nasıl geliştirilebilir>"},
    {"title": "<geliştirme başlığı>", "detail": "<nasıl geliştirilebilir>"}
  ]
}`;

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        max_tokens: 1000,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content },
        ],
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      return { statusCode: response.status, headers, body: JSON.stringify({ error: data.error?.message || "OpenAI error" }) };
    }

    const text = data.choices?.[0]?.message?.content || "";
    const clean = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);

    return { statusCode: 200, headers, body: JSON.stringify(parsed) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
