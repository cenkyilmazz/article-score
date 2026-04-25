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

  const SYSTEM_PROMPT = `Sen bir Medium makale editörü ve içerik stratejistisin. Sana bir makale metni veya Medium URL'si verilecek.

ÖNEMLİ - İçerik doğrulama:
Önce verilen içeriğin gerçek bir makale veya Medium URL'si olup olmadığını değerlendir.
Eğer içerik:
- Anlamsız, rastgele veya çok kısa bir metin ise (tek cümle, birkaç kelime, test verisi vb.)
- Gerçek bir makale yapısı taşımıyorsa (giriş, gelişme, sonuç, başlık vb. yoksa)
- Geçerli bir Medium URL'si değilse ve makale metni de değilse
O zaman SADECE şu JSON'u döndür ve başka hiçbir şey yazma:
{"score": 0, "grade": "F", "summary": "Geçerli bir makale veya Medium linki bulunamadı.", "strengths": [], "improvements": []}

Eğer içerik bir URL ise: O URL'deki makalenin başlığını ve konusunu URL'den çıkar, Medium platformundaki genel makale yapısını ve olası içeriği göz önünde bulundurarak değerlendirme yap. URL'yi ziyaret edemediğini belirtme, direkt analiz et.

Eğer makale metni verilirse: Metni doğrudan analiz et.

Aşağıdaki kriterlere ve ağırlıklara göre değerlendir:

Değerlendirme kriterleri ve ağırlıkları:
- Problem & Failure (%15): Makale gerçek bir problemi veya başarısızlığı açıkça ortaya koyuyor mu?
- Süreç & Açıklık (%15): Süreç adım adım, anlaşılır biçimde aktarılmış mı?
- Görseller (%10): Görsel kullanımı yeterli ve destekleyici mi?
- Başarı Metrikleri (%15): Somut başarı ölçütleri ve veriler var mı?
- Insight Derinliği (%15): Öğrenilen dersler derin ve özgün mü?
- Transfer Edilebilirlik (%10): Okuyucu bu deneyimden kendi işine bir şey taşıyabilir mi?
- Veri Kalitesi (%10): Kullanılan veriler güvenilir ve yeterince detaylı mı?
- Hikaye & Okunabilirlik (%10): Akıcı bir anlatı var mı, okumak keyifli mi?

Her kriterin puanını 0-100 arasında ver, ardından ağırlıklı ortalama ile toplam skoru hesapla.

ÇOK ÖNEMLİ - Geri bildirim kuralları:
- Geliştirilebilir yönlerde ASLA genel tavsiye verme ("daha iyi yazabilirsin", "görseller ekle" gibi).
- Her geliştirme önerisinde makaledeki SPESIFIK bir bölümü, cümleyi veya paragrafı belirt.
- Somut ve uygulanabilir ol: "X bölümündeki Y cümlesi şu şekilde yeniden yazılabilir: [örnek]" formatında ver.
- Güçlü yönlerde de spesifik ol: hangi bölüm, hangi yaklaşım, neden işe yarıyor.
- Her "detail" alanı en az 3 cümle olmalı. Kısa ve yüzeysel açıklamalar kabul edilmez.
- Güçlü yönlerde: ne iyi, neden iyi, okuyucuya ne kazandırıyor — üçünü de yaz.
- Geliştirme önerilerinde: hangi bölüm sorunlu, neden sorunlu, nasıl düzeltilebilir — üçünü de yaz ve mutlaka somut bir yeniden yazma örneği ver.

SADECE şu JSON formatında yanıt ver, başka hiçbir şey yazma:
{
  "score": <ağırlıklı ortalama 0-100>,
  "grade": "<A+/A/A-/B+/B/B-/C+/C/C-/D/F>",
  "summary": "<2 cümlelik genel değerlendirme>",
  "strengths": [
    {"title": "<güçlü yön başlığı>", "detail": "<makaledeki spesifik bölüm veya cümleye referans vererek açıkla>"},
    {"title": "<güçlü yön başlığı>", "detail": "<makaledeki spesifik bölüm veya cümleye referans vererek açıkla>"},
    {"title": "<güçlü yön başlığı>", "detail": "<makaledeki spesifik bölüm veya cümleye referans vererek açıkla>"},
    {"title": "<güçlü yön başlığı>", "detail": "<makaledeki spesifik bölüm veya cümleye referans vererek açıkla>"}
  ],
  "improvements": [
    {"title": "<geliştirme başlığı>", "detail": "<hangi bölüm/cümle, neden sorunlu, nasıl yeniden yazılabilir — somut örnek ver>"},
    {"title": "<geliştirme başlığı>", "detail": "<hangi bölüm/cümle, neden sorunlu, nasıl yeniden yazılabilir — somut örnek ver>"},
    {"title": "<geliştirme başlığı>", "detail": "<hangi bölüm/cümle, neden sorunlu, nasıl yeniden yazılabilir — somut örnek ver>"},
    {"title": "<geliştirme başlığı>", "detail": "<hangi bölüm/cümle, neden sorunlu, nasıl yeniden yazılabilir — somut örnek ver>"}
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
        model: "gpt-4o",
        max_tokens: 2000,
        temperature: 1.0,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content },
        ],
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      console.error("OpenAI error:", JSON.stringify(data));
      return { statusCode: response.status, headers, body: JSON.stringify({ error: data.error?.message || "OpenAI error" }) };
    }

    const text = data.choices?.[0]?.message?.content || "";
    console.log("OpenAI raw response:", text);
    
    // Extract JSON from response - handle markdown code blocks
    let jsonStr = text;
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1];
    } else {
      // Try to find raw JSON object
      const objMatch = text.match(/\{[\s\S]*\}/);
      if (objMatch) jsonStr = objMatch[0];
    }
    
    const parsed = JSON.parse(jsonStr.trim());

    return { statusCode: 200, headers, body: JSON.stringify(parsed) };
  } catch (err) {
    console.error("Function error:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
