const ALLOWED_ORIGINS = new Set([
  "https://appassets.androidplatform.net",
  "https://florenciaamor36-ship-it.github.io"
]);
const ALLOWED_MODELS = new Set(["gemini-2.5-flash", "gemini-2.5-pro"]);
const MAX_BODY_CHARS = 32_000;
const MAX_PROMPT_CHARS = 20_000;
const REQUESTS_PER_MINUTE = 12;

// Best-effort per-isolate protection. Keep the upstream key on the server and
// also restrict it to the Generative Language API and a modest quota in Google AI Studio.
const requestWindows = new Map();

function jsonResponse(body, status, origin) {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, max-age=0",
    "X-Content-Type-Options": "nosniff"
  });
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
    headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
    headers.set("Access-Control-Max-Age", "600");
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function rateLimited(ip, now) {
  const current = requestWindows.get(ip);
  if (!current || now - current.startedAt >= 60_000) {
    requestWindows.set(ip, { startedAt: now, count: 1 });
    if (requestWindows.size > 5_000) {
      for (const [key, value] of requestWindows) {
        if (now - value.startedAt >= 60_000) requestWindows.delete(key);
      }
    }
    return false;
  }
  current.count += 1;
  return current.count > REQUESTS_PER_MINUTE;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const url = new URL(request.url);

    if (!ALLOWED_ORIGINS.has(origin)) {
      return jsonResponse({ error: { message: "Origen no permitido." } }, 403, "");
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Authorization, Content-Type",
          "Access-Control-Max-Age": "600",
          "Vary": "Origin"
        }
      });
    }

    if (url.pathname === "/health" && request.method === "GET") {
      return jsonResponse({ ok: true, service: "gemini-proxy" }, 200, origin);
    }
    if (url.pathname !== "/v1/generate") {
      return jsonResponse({ error: { message: "Ruta no encontrada." } }, 404, origin);
    }
    if (request.method !== "POST") {
      return jsonResponse({ error: { message: "Método no permitido." } }, 405, origin);
    }
    if (!env.GEMINI_API_KEY || !env.APP_ACCESS_TOKEN) {
      return jsonResponse({ error: { message: "El servicio no está configurado." } }, 503, origin);
    }

    const authorization = request.headers.get("Authorization") || "";
    if (authorization !== `Bearer ${env.APP_ACCESS_TOKEN}`) {
      return jsonResponse({ error: { message: "Código de acceso incorrecto." } }, 401, origin);
    }

    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (rateLimited(ip, Date.now())) {
      return jsonResponse({ error: { message: "Demasiadas consultas. Esperá un minuto y probá de nuevo." } }, 429, origin);
    }

    const declaredLength = Number(request.headers.get("Content-Length") || 0);
    if (declaredLength > MAX_BODY_CHARS) {
      return jsonResponse({ error: { message: "La consulta supera el tamaño permitido." } }, 413, origin);
    }

    let input;
    try {
      const raw = await request.text();
      if (raw.length > MAX_BODY_CHARS) {
        return jsonResponse({ error: { message: "La consulta supera el tamaño permitido." } }, 413, origin);
      }
      input = JSON.parse(raw);
    } catch (_) {
      return jsonResponse({ error: { message: "La solicitud no contiene JSON válido." } }, 400, origin);
    }

    const model = typeof input.model === "string" ? input.model : "";
    const prompt = typeof input.prompt === "string" ? input.prompt : "";
    const temperature = Number(input.temperature);
    if (!ALLOWED_MODELS.has(model)) {
      return jsonResponse({ error: { message: "Modelo no permitido." } }, 400, origin);
    }
    if (!prompt.trim() || prompt.length > MAX_PROMPT_CHARS) {
      return jsonResponse({ error: { message: "La consulta está vacía o supera el límite permitido." } }, 400, origin);
    }

    const upstreamUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const upstreamBody = {
      contents: [{ parts: [{ text: prompt }] }],
      tools: [{ googleSearch: {} }],
      generationConfig: {
        temperature: Number.isFinite(temperature) ? Math.max(0, Math.min(1, temperature)) : 0.1
      }
    };

    let upstream;
    try {
      upstream = await fetch(upstreamUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": env.GEMINI_API_KEY
        },
        body: JSON.stringify(upstreamBody),
        signal: AbortSignal.timeout(45_000)
      });
    } catch (_) {
      return jsonResponse({ error: { message: "No se pudo conectar con Gemini." } }, 502, origin);
    }

    let body;
    try {
      body = await upstream.text();
      JSON.parse(body);
    } catch (_) {
      return jsonResponse({ error: { message: "Gemini devolvió una respuesta inválida." } }, 502, origin);
    }
    const headers = new Headers({
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Vary": "Origin"
    });
    return new Response(body, { status: upstream.status, headers });
  }
};
