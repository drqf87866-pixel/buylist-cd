export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

/** 404 statt 403, damit die Existenz fremder Listen nicht aufscheint. */
export function listNotFound(): Response {
  return json({ error: "Liste nicht gefunden." }, 404);
}

/** Meldungstext für fehlende Server-Secrets – eine Quelle für alle Fehlermeldungen. */
export function missingSecretMessage(name: string): string {
  return `Der Server hat ${name} nicht konfiguriert.`;
}

/** Antwort mit klarer Meldung, welches Server-Secret nicht konfiguriert ist. */
export function missingSecret(name: string, status = 500): Response {
  return json({ error: missingSecretMessage(name) }, status);
}

/** Liest einen JSON-Body (max. 10 KB) sicher ein; null bei ungültigem/too großem Body. */
export async function readJson<T>(request: Request): Promise<T | null> {
  const len = Number(request.headers.get("content-length") ?? "0");
  if (len > 10_000) return null;
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

/** Normalisierter Vergleichsschlüssel für Freitext (Namen, Gerichte, …): „  Milch “ == „milch“. */
export function normKey(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

export function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return null;
}
