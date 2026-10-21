// Supabase Edge Function (Deno): re-hash an uploaded document server-side.
//
// Event-driven serverless: a Database Webhook on public.project_documents
// (UPDATE) calls this function. When a version becomes `ready`, it downloads
// the object from Storage, recomputes SHA-256 and records whether it matches
// the checksum the browser declared (verification = ok | mismatch | missing).
//
// Deploy:  npx supabase functions deploy verify-document --no-verify-jwt
// Secret:  npx supabase secrets set DOCUMENT_WEBHOOK_SECRET=<random>
// Webhook: Database → Webhooks → table project_documents, event UPDATE,
//          HTTP POST to https://<ref>.supabase.co/functions/v1/verify-document
//          with header x-webhook-secret: <same random>
import { createClient } from "jsr:@supabase/supabase-js@2";

interface DocumentRecord {
  readonly id: string;
  readonly status: string;
  readonly storage_key: string;
  readonly sha256: string;
}

interface WebhookPayload {
  readonly type: string;
  readonly table: string;
  readonly record: DocumentRecord | null;
  readonly old_record: DocumentRecord | null;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  const secret = Deno.env.get("DOCUMENT_WEBHOOK_SECRET") ?? "";
  if (!secret || !timingSafeEqual(req.headers.get("x-webhook-secret") ?? "", secret)) {
    return new Response("unauthorized", { status: 401 });
  }

  const payload = (await req.json()) as WebhookPayload;
  const doc = payload.record;
  // Only act on the transition to ready (the finalize step)
  if (payload.table !== "project_documents" || !doc || doc.status !== "ready" || payload.old_record?.status === "ready") {
    return Response.json({ skipped: true });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data: blob, error } = await supabase.storage.from("project-documents").download(doc.storage_key);
  const verification = error || !blob
    ? "missing"
    : (await sha256Hex(await blob.arrayBuffer())) === doc.sha256
      ? "ok"
      : "mismatch";

  await supabase
    .from("project_documents")
    .update({ verification, verified_at: new Date().toISOString() })
    .eq("id", doc.id);

  // A corrupted or substituted upload must never be served publicly
  if (verification !== "ok") {
    await supabase.from("project_documents").update({ visibility: "private" }).eq("id", doc.id);
  }

  return Response.json({ id: doc.id, verification });
});
