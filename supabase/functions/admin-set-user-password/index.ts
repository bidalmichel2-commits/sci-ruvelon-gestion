import { createClient } from "npm:@supabase/supabase-js@2.119.2";

const ADMIN_EMAIL = "bidal.michel2@gmail.com";
const allowedOrigins = new Set([
  "https://bidalmichel2-commits.github.io",
  "http://localhost:8787",
  "http://127.0.0.1:8787",
]);

function json(body: Record<string, unknown>, status: number, origin: string) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Vary": "Origin",
    },
  });
}

Deno.serve(async (req: Request) => {
  const requestOrigin = req.headers.get("Origin") || "";
  const origin = allowedOrigins.has(requestOrigin) ? requestOrigin : "null";
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS", "Vary": "Origin" } });
  if (req.method !== "POST" || origin === "null") return json({ error: "Requête non autorisée." }, 403, origin);

  const authorization = req.headers.get("Authorization") || "";
  const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return json({ error: "Session administrateur requise." }, 401, origin);

  try {
    const projectUrl = Deno.env.get("SUPABASE_URL");
    const publishableKeys = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const publishableKey = publishableKeys ? JSON.parse(publishableKeys).default : anonKey;
    if (!projectUrl || !publishableKey || !serviceRoleKey) throw new Error("Configuration serveur indisponible.");

    const authClient = createClient(projectUrl, publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data: authData, error: authError } = await authClient.auth.getUser(token);
    if (authError || authData.user?.email?.toLowerCase() !== ADMIN_EMAIL) {
      return json({ error: "Action réservée à l’administrateur SCI RUVELON." }, 403, origin);
    }

    const { data: profile, error: profileError } = await authClient
      .from("app_users")
      .select("role,actif")
      .eq("email", ADMIN_EMAIL)
      .maybeSingle();
    if (profileError || profile?.role !== "admin" || profile.actif !== true) {
      return json({ error: "Droits administrateur invalides." }, 403, origin);
    }

    const { email, password } = await req.json();
    const targetEmail = String(email || "").trim().toLowerCase();
    const newPassword = String(password || "");
    if (!targetEmail || newPassword.length < 12 || newPassword.length > 128) {
      return json({ error: "Adresse ou mot de passe invalide (12 à 128 caractères)." }, 400, origin);
    }

    const { data: targetProfile, error: targetProfileError } = await authClient
      .from("app_users")
      .select("email,actif")
      .eq("email", targetEmail)
      .maybeSingle();
    if (targetProfileError || !targetProfile || targetProfile.actif !== true) {
      return json({ error: "Utilisateur actif introuvable." }, 404, origin);
    }

    const adminClient = createClient(projectUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    let targetUser = null;
    for (let page = 1; page <= 10 && !targetUser; page++) {
      const { data, error } = await adminClient.auth.admin.listUsers({ page, perPage: 1000 });
      if (error) throw error;
      targetUser = data.users.find((user) => user.email?.toLowerCase() === targetEmail) || null;
      if (data.users.length < 1000) break;
    }
    if (!targetUser) return json({ error: "Compte de connexion Supabase introuvable." }, 404, origin);

    const { error: updateError } = await adminClient.auth.admin.updateUserById(targetUser.id, { password: newPassword });
    if (updateError) throw updateError;
    return json({ ok: true }, 200, origin);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Erreur serveur." }, 500, origin);
  }
});
