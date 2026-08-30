export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
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
