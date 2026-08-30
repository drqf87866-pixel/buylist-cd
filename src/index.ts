import { handleLogin, handleLogout, handleMe, handleRegister } from "./auth";
import { handleCreateList, handleDeleteList, handleGetLists, handleInvite, handleJoin, handleSnapshot, isMember } from "./lists";
import { handleLeaveList, handleGetMembers, handleRemoveMember, handleTransferOwner } from "./members";
import { handleGetPreferences, handleSavePreferences } from "./preferences";
import { handleSubscribe, handleUnsubscribe, handleVapidKey } from "./push";
import {
  handleAddItems,
  handleDeleteRecipe,
  handleGenerate,
  handleGetAllRecipes,
  handleGetRecipes,
  handleSaveRecipe,
} from "./recipes";
import { getSessionUser } from "./session";
import {
  handleCreateRecurring,
  handleDeleteRecurring,
  handleGetRecurring,
  runRecurringCron,
} from "./recurring";
import { json } from "./util";
import type { Env } from "./types";

export { ShoppingListDO } from "./do/shopping-list";
export { RateLimiterDO } from "./do/rate-limiter";

export default {
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    // Täglicher Lauf: fällige wiederkehrende Items auf die Listen legen
    await runRecurringCron(env);
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      try {
        return await routeApi(request, env, url);
      } catch (err) {
        console.error("API-Fehler:", err);
        return json({ error: "Interner Serverfehler." }, 500);
      }
    }

    // Alle Nicht-API-Requests: statische Assets, bei Nicht-Treffer SPA-Fallback
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

const LIST_ROUTE_RE = /^\/api\/list\/([A-Za-z0-9-]+)\/(snapshot|ws|invite|generate|recipes|items|recurring|members|owner|leave)$/;
const LIST_DELETE_RE = /^\/api\/list\/([A-Za-z0-9-]+)$/;
const RECIPE_ROUTE_RE = /^\/api\/list\/([A-Za-z0-9-]+)\/recipes\/([A-Za-z0-9-]+)$/;
const RECURRING_ROUTE_RE = /^\/api\/list\/([A-Za-z0-9-]+)\/recurring\/([A-Za-z0-9-]+)$/;

async function routeApi(request: Request, env: Env, url: URL): Promise<Response> {
  const { pathname } = url;
  const method = request.method;

  if (pathname === "/api/auth/register" && method === "POST") return handleRegister(request, env);
  if (pathname === "/api/auth/login" && method === "POST") return handleLogin(request, env);
  if (pathname === "/api/auth/logout" && method === "POST") return handleLogout(request, env);
  if (pathname === "/api/auth/me" && method === "GET") return handleMe(request, env);
  if (pathname === "/api/preferences" && method === "GET") return handleGetPreferences(request, env);
  if (pathname === "/api/preferences" && method === "PUT") return handleSavePreferences(request, env);
  if (pathname === "/api/push/subscribe" && method === "POST") return handleSubscribe(request, env);
  if (pathname === "/api/push/unsubscribe" && method === "POST") return handleUnsubscribe(request, env);
  if (pathname === "/api/push/vapid-key" && method === "GET") return handleVapidKey(request, env);

  if (pathname === "/api/lists") {
    if (method === "GET") return handleGetLists(request, env);
    if (method === "POST") return handleCreateList(request, env);
  }

  if (pathname === "/api/join" && method === "POST") return handleJoin(request, env);
  if (pathname === "/api/recipes" && method === "GET") return handleGetAllRecipes(request, env);

  // Liste löschen: DELETE direkt auf /api/list/:id (ohne Action-Segment)
  const listDeleteMatch = pathname.match(LIST_DELETE_RE);
  if (listDeleteMatch && method === "DELETE") return handleDeleteList(request, env, listDeleteMatch[1]);

  const match = pathname.match(LIST_ROUTE_RE);
  if (match) {
    const [, listId, action] = match;
    if (action === "snapshot" && method === "GET") return handleSnapshot(request, env, listId);
    if (action === "invite" && method === "GET") return handleInvite(request, env, listId);
    if (action === "ws" && method === "GET") return handleWs(request, env, listId);
    if (action === "generate" && method === "POST") return handleGenerate(request, env, listId);
    if (action === "recipes" && method === "GET") return handleGetRecipes(request, env, listId);
    if (action === "recipes" && method === "POST") return handleSaveRecipe(request, env, listId);
    if (action === "items" && method === "POST") return handleAddItems(request, env, listId);
    if (action === "recurring" && method === "GET") return handleGetRecurring(request, env, listId);
    if (action === "recurring" && method === "POST") return handleCreateRecurring(request, env, listId);
    if (action === "members" && method === "GET") return handleGetMembers(request, env, listId);
    if (action === "members" && method === "DELETE") return handleRemoveMember(request, env, listId);
    if (action === "owner" && method === "POST") return handleTransferOwner(request, env, listId);
    if (action === "leave" && method === "POST") return handleLeaveList(request, env, listId);
  }

  const recurringMatch = pathname.match(RECURRING_ROUTE_RE);
  if (recurringMatch) {
    const [, listId, ruleId] = recurringMatch;
    if (method === "DELETE") return handleDeleteRecurring(request, env, listId, ruleId);
  }

  const recipeMatch = pathname.match(RECIPE_ROUTE_RE);
  if (recipeMatch) {
    const [, listId, recipeId] = recipeMatch;
    if (method === "DELETE") return handleDeleteRecipe(request, env, listId, recipeId);
  }

  return json({ error: "Nicht gefunden." }, 404);
}

/**
 * WebSocket-Upgrade: erst Session und Mitgliedschaft prüfen, dann an das DO
 * weiterreichen. Der User-Kontext wird serverseitig als Header übergeben
 * (eingehende gleichnamige Header werden entfernt – kein Spoofing).
 */
async function handleWs(request: Request, env: Env, listId: string): Promise<Response> {
  const session = await getSessionUser(env.DB, request);
  if (!session) return json({ error: "Nicht eingeloggt." }, 401);

  if ((request.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") {
    return json({ error: "WebSocket-Upgrade erwartet." }, 426);
  }

  const meta = await env.DB.prepare("SELECT name FROM lists WHERE id = ?").bind(listId).first<{ name: string }>();
  if (!meta || !(await isMember(env.DB, listId, session.user.id))) {
    return json({ error: "Liste nicht gefunden." }, 404);
  }

  const stub = env.SHOPPING_LIST_DO.get(env.SHOPPING_LIST_DO.idFromName(listId));
  const doUrl = new URL(request.url);
  doUrl.pathname = "/ws";
  doUrl.search = `?id=${encodeURIComponent(listId)}&name=${encodeURIComponent(meta.name)}`;

  const headers = new Headers(request.headers);
  headers.delete("x-user-id");
  headers.delete("x-display-name");
  headers.set("x-user-id", session.user.id);
  headers.set("x-display-name", session.user.displayName);

  return stub.fetch(new Request(doUrl, { method: "GET", headers }));
}
