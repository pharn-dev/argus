#!/usr/bin/env node
// pharn/floor/check-seam-config.mjs — the deterministic SEAM-RESOLUTION-CONFIG validator.
//
// Floor primitive #3 (enum / presence / type; ARCHITECTURE §2), like validate.mjs, check-structural.mjs,
// and check-provenance.mjs. It is the floor reduction of ARCHITECTURE §5's confidence-gated chain: the
// resolver walks resolutionOrder and stops at the first hit, else falls through to a TERMINAL "ask"
// (halt-and-ask, P5). This checker guarantees the one thing that keeps that walk safe — a config can
// NEVER remove the terminal "ask" — plus valid-step and well-typed-field checks. It is domknięcie
// (tightening §5's existing contract to its floor), NOT a new spec claim — exactly as check-provenance.mjs
// did for §5's memory-promotion provenance. Conforms to the pharn-contracts/seam-config.md schema (cited,
// not restated — P4).
//
// NON-LLM, dependency-free (Node stdlib only). No network, no child_process, no eval, no dynamic import.
//
// Honest scope (P0): it guarantees a seam config is VALID — resolutionOrder is a non-empty array of valid
// steps that CONTAINS "ask", with well-typed optional fields. It does NOT — cannot — guarantee the resolver
// RESOLVES CORRECTLY at runtime (that is the confidence-gate at the "model" step + the terminal "ask"
// fallback, advisory), nor that the runtime walk is executed faithfully (a future pharn-core capability).
// "passed check-seam-config" must NEVER read as "the seam was resolved right" — that conflation is the P0
// disease this repo exists to prevent.
//
// Trust (P2): a seam config can originate in trust: untrusted input (a forked/poisoned repo —
// THREAT-MODEL §2). The verdict ranges ONLY over the enum-gated / type-checked fields (resolutionOrder
// steps, "ask" presence, the threshold enum, the boolean type). Any extra free-text field is IGNORED — no
// guaranteed decision rests on it (mirrors check-provenance.mjs). Taint cannot flip the verdict.
//
// Usage:  node pharn/floor/check-seam-config.mjs <seam-config.json>
//   seam-config.json : { resolutionOrder: [step,...], modelConfidenceThreshold?, haltOnUnknown? }
//                      (the top-level object IS the seam config — i.e. the `seam` block of a project config)
//
// Exit: 1 on any RED (prints each), 0 + "GREEN — ..." otherwise.

import { readFileSync } from "node:fs";

// Enums — every branch is a membership / presence / type test (P5); the terminal fallback on any
// non-member is a loud RED, never a guess. These are the enum-gated / floor-verifiable fields.
const STEP_ENUM = ["official-skill", "pinned-docs", "fetch", "model", "ask"]; // ARCHITECTURE §5 chain sources
const CONFIDENCE_ENUM = ["low", "medium", "high"]; // the modelConfidenceThreshold bar
const TERMINAL = "ask"; // the required terminal fallback (§5, P5) — the floor invariant

const reds = [];
function red(kind, detail) {
  reds.push({ kind, detail });
}

function readJson(path, label) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    red("input", `${label} is unreadable (${path}): ${e.message}`);
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    red("input", `${label} is not valid JSON (${path}): ${e.message}`);
    return undefined;
  }
}

function fail() {
  for (const r of reds) console.log(`RED — ${r.kind} failed: ${r.detail}`);
  console.log(`\nRED — ${reds.length} seam-config check(s) failed`);
  return 1;
}

function main() {
  const configPath = process.argv[2];
  if (!configPath) {
    console.log("RED — usage: node pharn/floor/check-seam-config.mjs <seam-config.json>");
    return 1;
  }

  const cfg = readJson(configPath, "seam-config.json");
  if (reds.length) return fail();
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
    red("input", "seam-config must be a JSON object");
    return fail();
  }

  // (1) resolutionOrder is a non-empty ARRAY — the walk needs at least one step (P5).
  const order = cfg.resolutionOrder;
  if (!Array.isArray(order)) {
    red("resolutionOrder", `resolutionOrder must be an array, got ${JSON.stringify(order)}`);
    return fail(); // nothing further to check on a non-array
  }
  if (order.length === 0) {
    red("resolutionOrder", "resolutionOrder must be non-empty (an empty walk has no terminal ask)");
  }

  // (2) every element ∈ STEP_ENUM — set membership; an invalid/unwalkable step is RED (P5).
  for (let i = 0; i < order.length; i++) {
    if (!STEP_ENUM.includes(order[i])) {
      red("step", `resolutionOrder[${i}] ${JSON.stringify(order[i])} not in {${STEP_ENUM.join(", ")}}`);
    }
  }

  // (3) resolutionOrder CONTAINS "ask" — THE FLOOR INVARIANT (ARCHITECTURE §5 "terminal fallback is
  //     ask", P5). Without it an unknown seam has no defined stop = a fall-through into a guess. Presence
  //     (not last-ness) is the invariant: "ask" always resolves, so its presence guarantees termination.
  if (!order.includes(TERMINAL)) {
    red("ask", `resolutionOrder must contain "${TERMINAL}" — the terminal fallback cannot be configured away (fail-closed)`);
  }

  // (4) modelConfidenceThreshold, if present, ∈ CONFIDENCE_ENUM — enum membership (P5). Optional: absent is fine.
  if ("modelConfidenceThreshold" in cfg && !CONFIDENCE_ENUM.includes(cfg.modelConfidenceThreshold)) {
    red(
      "modelConfidenceThreshold",
      `modelConfidenceThreshold ${JSON.stringify(cfg.modelConfidenceThreshold)} not in {${CONFIDENCE_ENUM.join(", ")}}`
    );
  }

  // (5) haltOnUnknown, if present, is a boolean — type check (P5). Optional: absent is fine.
  if ("haltOnUnknown" in cfg && typeof cfg.haltOnUnknown !== "boolean") {
    red("haltOnUnknown", `haltOnUnknown must be a boolean, got ${JSON.stringify(cfg.haltOnUnknown)}`);
  }

  if (reds.length) return fail();
  console.log(`GREEN — seam-config valid; resolutionOrder [${order.join(", ")}] contains the terminal "${TERMINAL}"`);
  return 0;
}

process.exit(main());
