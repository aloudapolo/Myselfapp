// Assistant IA de Myself : Claude Haiku 5.5, appelé uniquement depuis le Worker.
// La clé API vit dans le secret Cloudflare ANTHROPIC_API_KEY (jamais dans le code ni dans le navigateur).
// L'IA ne modifie rien elle-même : elle PROPOSE des tâches, que l'appli fait confirmer à Alou avant de les ajouter.
import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-haiku-5-5";
const MAX_TURNS = 20; // derniers messages de la conversation envoyés à l'IA
const MAX_CHARS = 4000; // par message
const DAILY_LIMIT = 300; // garde-fou budget : appels IA par jour

const TOOLS = [
  {
    name: "proposer_tache",
    description:
      "Propose une nouvelle tâche à ajouter dans Myself. La tâche n'est PAS créée tout de suite : Alou voit une carte et confirme ou refuse. " +
      "Appelle cet outil une fois par tâche dès qu'Alou demande d'ajouter, noter, planifier ou se rappeler quelque chose. " +
      "Convertis les dates relatives (demain, vendredi, dans 3 jours) en date AAAA-MM-JJ à partir de la date du jour.",
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["title", "date", "time", "projectId", "priority", "repeat", "notes"],
      properties: {
        title: { type: "string", description: "Titre court et actionnable, commence par un verbe. Ex. « Appeler le comptable »." },
        date: { type: ["string", "null"], description: "AAAA-MM-JJ, ou null si aucune date n'est évoquée." },
        time: { type: ["string", "null"], description: "HH:MM sur 24 h, ou null." },
        projectId: { type: ["string", "null"], description: "id d'un projet existant de la liste fournie, ou null." },
        priority: { type: "integer", enum: [0, 1, 2], description: "0 normale, 1 importante, 2 urgente." },
        repeat: { type: "string", enum: ["none", "daily", "weekdays", "weekly", "monthly"] },
        notes: { type: "string", description: "Détails utiles, ou chaîne vide." },
      },
    },
  },
];

const clip = (s, n) => (typeof s === "string" ? (s.length > n ? s.slice(0, n) + "…" : s) : "");

async function readDoc(db, path) {
  try {
    const r = await db.prepare("SELECT data FROM docs WHERE path = ?").bind(path).first();
    return r ? JSON.parse(r.data) : null;
  } catch {
    return null;
  }
}

// Résumé compact des données connectées, envoyé à l'IA comme contexte.
async function buildContext(env, client, binvio) {
  const parts = [];
  const projects = Array.isArray(client.projects) ? client.projects.slice(0, 50) : [];
  const tasks = Array.isArray(client.tasks) ? client.tasks.slice(0, 300) : [];
  parts.push(
    "## Projets\n" +
      (projects.length ? projects.map((p) => `- ${clip(p.name, 80)} (id: ${clip(p.id, 40)}, catégorie: ${clip(p.cat, 20)})`).join("\n") : "Aucun projet."),
  );
  const pname = Object.fromEntries(projects.map((p) => [p.id, p.name]));
  const line = (t) =>
    `- ${clip(t.title, 160)}` +
    (t.date ? ` | ${t.date}${t.time ? " " + t.time : ""}` : " | sans date") +
    (t.projectId && pname[t.projectId] ? ` | projet: ${clip(pname[t.projectId], 60)}` : "") +
    (t.priority ? ` | ${t.priority === 2 ? "urgente" : "importante"}` : "") +
    (t.repeat && t.repeat !== "none" ? ` | répète: ${t.repeat}` : "") +
    (t.notes ? ` | notes: ${clip(t.notes, 200)}` : "");
  const todo = tasks.filter((t) => !t.done);
  const done = tasks.filter((t) => t.done).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0)).slice(0, 15);
  parts.push("## Tâches à faire\n" + (todo.length ? todo.map(line).join("\n") : "Aucune."));
  if (done.length) parts.push("## Tâches terminées récemment\n" + done.map(line).join("\n"));

  // MyGym : profil et programme
  const [profile, plan] = await Promise.all([readDoc(env.DB, "data/users/me/profile"), readDoc(env.DB, "data/users/me/plan")]);
  if (profile || plan) {
    let g = "## MyGym (sport et nutrition)\n";
    if (profile) {
      const { name, createdAt, updatedAt, ...rest } = profile;
      g += "Profil : " + clip(JSON.stringify(rest), 1200) + "\n";
    }
    if (plan && Array.isArray(plan.templates)) {
      g += "Programme :\n" + plan.templates
        .map((t) => `- Séance ${t.name || t.id} : ` + (t.items || []).map((i) => `${i.name} ${i.sets}x${i.reps}`).join(", "))
        .join("\n");
    }
    parts.push(clip(g, 3000));
  }

  // MyBrief : dernier brief d'actu
  try {
    const r = await env.DB.prepare("SELECT data FROM docs WHERE col = 'briefs' ORDER BY id DESC LIMIT 1").first();
    if (r) {
      const b = JSON.parse(r.data);
      let s = `## MyBrief (actu du ${b.date})\n${clip(b.title, 200)}\n`;
      (b.essentiel || []).forEach((e) => (s += `- ${clip(e, 300)}\n`));
      (b.sections || []).forEach((sec) => {
        s += `### ${clip(sec.label, 60)}\n`;
        (sec.items || []).slice(0, 4).forEach((it) => (s += `- ${clip(it.title, 140)} : ${clip(it.text, 260)}\n`));
      });
      parts.push(clip(s, 6000));
    }
  } catch {}

  // Binvio : uniquement des totaux (passés par la fonction de résumé du Worker)
  if (binvio) parts.push("## Binvio (son entreprise, montants en centimes d'euro)\n" + clip(JSON.stringify(binvio), 4000));

  return parts.join("\n\n");
}

function systemPrompt(now) {
  return `Tu es l'assistant personnel intégré à Myself, le dashboard perso d'Alou (étudiant en gestion d'entreprise à Vannes, entrepreneur avec Binvio, sportif).
Tu parles comme un pote : tutoiement, phrases courtes, ton détendu. Sur le fond tu es précis et cash.
Alou te parle souvent en dictée vocale : le texte peut contenir des fautes de transcription, devine le sens.

Ce que tu sais faire :
- Répondre à ses questions sur ses tâches, projets, son sport (MyGym), son actu (MyBrief) et Binvio, à partir des données ci-dessous. Si l'info n'y est pas, dis-le simplement, n'invente jamais.
- Proposer des tâches avec l'outil proposer_tache. Appelle l'outil directement, sans texte avant. Rien n'est ajouté sans sa confirmation : après l'appel, dis en une phrase « Je te la propose, valide en dessous » ou équivalent.
- L'aider à prioriser, planifier sa journée, réfléchir à une idée.

Réponses courtes (2 à 6 phrases en général), pas de titres Markdown. Les montants Binvio sont en centimes : convertis-les en euros.
Tu ne peux pas encore cocher, modifier ou supprimer une tâche : explique que ça se fait directement dans l'appli.

Maintenant : ${now}.`;
}

async function underDailyLimit(db) {
  const day = new Date().toISOString().slice(0, 10);
  const row = await db.prepare("SELECT v FROM meta WHERE k = 'ai_usage'").first();
  const u = row ? JSON.parse(row.v) : { day, n: 0 };
  if (u.day !== day) { u.day = day; u.n = 0; }
  if (u.n >= DAILY_LIMIT) return false;
  u.n += 1;
  await db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('ai_usage', ?)").bind(JSON.stringify(u)).run();
  return true;
}

// Valide une proposition de tâche avant de l'envoyer à l'appli.
function cleanTask(input, projectIds) {
  if (!input || typeof input.title !== "string" || !input.title.trim()) return null;
  const date = typeof input.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.date) ? input.date : null;
  const time = typeof input.time === "string" && /^\d{2}:\d{2}$/.test(input.time) ? input.time : null;
  return {
    title: input.title.trim().slice(0, 200),
    date,
    time,
    projectId: projectIds.has(input.projectId) ? input.projectId : null,
    priority: [0, 1, 2].includes(input.priority) ? input.priority : 0,
    repeat: ["none", "daily", "weekdays", "weekly", "monthly"].includes(input.repeat) ? input.repeat : "none",
    notes: typeof input.notes === "string" ? input.notes.slice(0, 1000) : "",
  };
}

export async function handleAi(body, env, json, fail, getBinvio) {
  if (!env.ANTHROPIC_API_KEY) return fail(503, "ai_not_configured");

  const history = (Array.isArray(body.messages) ? body.messages : [])
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .slice(-MAX_TURNS)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_CHARS) }));
  while (history.length && history[0].role !== "user") history.shift();
  if (!history.length || history[history.length - 1].role !== "user") return fail(400, "bad_messages");

  if (!(await underDailyLimit(env.DB))) return fail(429, "ai_daily_limit");

  const client = body.context && typeof body.context === "object" ? body.context : {};
  const projectIds = new Set((client.projects || []).map((p) => p.id));
  const now = clip(typeof client.now === "string" ? client.now : new Date().toISOString(), 80);
  let binvio = null;
  try { binvio = getBinvio ? await getBinvio() : null; } catch {}
  const context = await buildContext(env, client, binvio);

  const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 1, timeout: 45000 });
  const system = systemPrompt(now) + "\n\n# Données connectées\n" + context;
  const messages = [...history];
  const proposals = [];
  let reply = "";

  try {
    for (let i = 0; i < 3; i++) {
      const res = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 2000,
        output_config: { effort: "low" },
        system,
        tools: TOOLS,
        messages,
      });

      if (res.stop_reason === "refusal") {
        reply = "Je ne peux pas t'aider sur ce point-là. Essaie de reformuler.";
        break;
      }
      const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
      if (text) reply = reply ? reply + "\n\n" + text : text;

      const uses = res.content.filter((b) => b.type === "tool_use");
      if (res.stop_reason !== "tool_use" || !uses.length) break;

      messages.push({ role: "assistant", content: res.content });
      const results = uses.map((u) => {
        const t = u.name === "proposer_tache" ? cleanTask(u.input, projectIds) : null;
        if (t) proposals.push(t);
        return {
          type: "tool_result",
          tool_use_id: u.id,
          content: t ? "Proposition affichée à Alou. Elle sera ajoutée seulement s'il la valide." : "Proposition invalide : titre manquant.",
          is_error: !t,
        };
      });
      messages.push({ role: "user", content: results });
    }
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return fail(503, "ai_bad_key");
    if (e instanceof Anthropic.RateLimitError) return fail(429, "ai_busy");
    if (e instanceof Anthropic.APIError) return fail(502, "ai_error");
    throw e;
  }

  if (!reply && proposals.length) reply = proposals.length > 1 ? "Je te propose ces tâches, valide celles que tu veux." : "Je te la propose, valide en dessous.";
  return json({ reply: reply || "Je n'ai pas compris, tu peux reformuler ?", proposals });
}
