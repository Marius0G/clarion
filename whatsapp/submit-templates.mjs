// Validates the WhatsApp message templates in templates.json and submits them to Meta for review.
//   node whatsapp/submit-templates.mjs --dry-run   validate only
//   node whatsapp/submit-templates.mjs --preview   print every message filled in with its examples
//   node whatsapp/submit-templates.mjs             submit the templates not yet on the account
//   node whatsapp/submit-templates.mjs --status    show the review status of each template
// WHATSAPP_WABA_ID and WHATSAPP_TOKEN come from the environment or from .env in the repo root.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const GRAPH = "https://graph.facebook.com/v23.0";
const here = dirname(fileURLToPath(import.meta.url));
const envFile = join(here, "..", ".env");
const mode = process.argv[2] ?? "--submit";

if (existsSync(envFile)) process.loadEnvFile(envFile);
const spec = JSON.parse(readFileSync(join(here, "templates.json"), "utf8"));
const templates = spec.templates.flatMap((t) =>
  Object.entries(t.languages).map(([language, l]) => ({
    ...l,
    name: t.name,
    category: t.category,
    language,
    footer: spec.footer[language],
  })),
);

const problems = templates.flatMap(validate);
for (const t of spec.templates) {
  // The backend fills every language from the same values, so the languages must match.
  const shape = (l) => `${params(l.body).sort()}|${l.buttons?.length ?? 0}`;
  if (new Set(Object.values(t.languages).map(shape)).size > 1)
    problems.push(`${t.name}: languages differ in parameters or number of buttons`);
}
if (problems.length) {
  console.error(problems.map((p) => `INVALID ${p}`).join("\n"));
  process.exit(1);
}
console.log(`${templates.length} templates valid (${spec.templates.length} names).`);

if (mode === "--preview") templates.forEach(preview);
if (mode === "--dry-run" || mode === "--preview") process.exit(0);

const { WHATSAPP_WABA_ID: waba, WHATSAPP_TOKEN: token } = process.env;
if (!waba || !token) {
  console.error("Missing WHATSAPP_WABA_ID or WHATSAPP_TOKEN (see .env.example).");
  process.exit(1);
}

const existing = await listExisting();
if (mode === "--status") {
  for (const t of templates) {
    const e = existing.get(key(t));
    const reason = e?.rejected_reason && e.rejected_reason !== "NONE" ? ` (${e.rejected_reason})` : "";
    console.log(`${key(t).padEnd(26)} ${e ? `${e.status} ${e.category}${reason}` : "not submitted"}`);
  }
  process.exit(0);
}

let failed = 0;
for (const t of templates) {
  if (existing.has(key(t))) {
    console.log(`SKIP ${key(t)}: already ${existing.get(key(t)).status}`);
    continue;
  }
  const res = await graph(`/${waba}/message_templates`, { method: "POST", body: JSON.stringify(payload(t)) });
  if (res.error) {
    failed++;
    console.log(`FAIL ${key(t)}: ${res.error.error_user_msg ?? res.error.message}`);
  } else console.log(`SENT ${key(t)}: ${res.status} ${res.category} (id ${res.id})`);
}
process.exit(failed ? 1 : 0);

function key(t) {
  return `${t.name}/${t.language}`;
}

function params(text) {
  return [...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);
}

function payload(t) {
  const names = params(t.body);
  const components = [];
  if (t.header) components.push({ type: "HEADER", format: "TEXT", text: t.header });
  components.push({
    type: "BODY",
    text: t.body,
    ...(names.length && {
      example: { body_text_named_params: names.map((n) => ({ param_name: n, example: t.examples[n] })) },
    }),
  });
  if (t.footer) components.push({ type: "FOOTER", text: t.footer });
  if (t.buttons?.length)
    components.push({ type: "BUTTONS", buttons: t.buttons.map((text) => ({ type: "QUICK_REPLY", text })) });
  return { name: t.name, language: t.language, category: t.category, parameter_format: "named", components };
}

// Meta's published limits plus the review rules that most often get templates rejected.
function validate(t) {
  const out = [];
  const bad = (msg) => out.push(`${key(t)}: ${msg}`);
  const names = params(t.body);
  if (!/^[a-z0-9_]{1,512}$/.test(t.name)) bad("name must use lowercase letters, digits and underscores");
  if (t.header && (t.header.length > 60 || /[*_~`]|\{\{/.test(t.header)))
    bad("header must be at most 60 characters, without formatting or parameters");
  if (t.body.length > 1024) bad(`body has ${t.body.length} characters (max 1024)`);
  if (/^\s*\{\{/.test(t.body) || /\}\}[\s\p{P}]*$/u.test(t.body)) bad("body cannot start or end with a parameter");
  if (/\}\}\s*\{\{/.test(t.body)) bad("body cannot have two parameters next to each other");
  if (new Set(names).size !== names.length) bad("each parameter can appear only once");
  for (const n of names) {
    const example = t.examples?.[n];
    if (!/^[a-z][a-z0-9_]*$/.test(n)) bad(`parameter {{${n}}} must use lowercase letters, digits and underscores`);
    if (!example) bad(`parameter {{${n}}} has no example`);
    else if (/[\n\t]| {4}/.test(example)) bad(`example for {{${n}}} cannot contain new lines, tabs or 4 spaces`);
  }
  if (t.footer && (t.footer.length > 60 || /\{\{/.test(t.footer)))
    bad("footer must be at most 60 characters, without parameters");
  if ((t.buttons?.length ?? 0) > 10) bad("at most 10 quick reply buttons");
  for (const b of t.buttons ?? []) if (!b || b.length > 25) bad(`button "${b}" must be 1-25 characters`);
  return out;
}

function preview(t) {
  const fill = (s) => s.replace(/\{\{(\w+)\}\}/g, (_, n) => t.examples[n]);
  console.log(`\n--- ${key(t)} ---`);
  if (t.header) console.log(`# ${t.header}`);
  console.log(fill(t.body));
  if (t.footer) console.log(`(${t.footer})`);
  if (t.buttons?.length) console.log(t.buttons.map((b) => `[${b}]`).join(" "));
}

async function listExisting() {
  const found = new Map();
  let url = `/${waba}/message_templates?fields=name,language,status,category,rejected_reason&limit=100`;
  while (url) {
    const res = await graph(url);
    if (res.error) {
      console.error(`Meta API error: ${res.error.message}`);
      process.exit(1);
    }
    for (const t of res.data) found.set(`${t.name}/${t.language}`, t);
    url = res.paging?.next;
  }
  return found;
}

async function graph(path, init = {}) {
  const res = await fetch(path.startsWith("https://") ? path : GRAPH + path, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  return res.json();
}
