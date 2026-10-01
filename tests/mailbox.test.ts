import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { answerAsk, ask, cancelAsks, createAsk, listAsks, readAsk } from "../src/mailbox.ts";
import type { AskRecord } from "../src/mailbox.ts";
import { askLockName, lockPath } from "../src/locks.ts";
import { poll, project } from "./helpers/project.ts";
import type { TestProject } from "./helpers/project.ts";

// The mailbox an engine-placed lead asks its operator through (design, "The lead model",
// item 3): one JSON file per question under `.cross-agent/asks/`, written by the server or
// the operator CLI and never by an engine. A lead blocks on its own question for at most
// one call's budget and asks again by id; the first answer wins.

async function mailboxProject(t: TestContext): Promise<TestProject> {
  return project(t, { mode: "dev-team-engine", roles: {}, limits: { maxDepth: 2, lockWaitSeconds: 30 } },
    [{ key: "lead" }], { lead: { placement: "engine", role: "lead" } });
}

const asksDir = (root: string) => path.join(root, ".cross-agent", "asks");

/** The one ask file a question created, once it is on disk. */
async function theOpenAsk(root: string): Promise<AskRecord> {
  const { asks } = await poll(() => listAsks(root), (listed) => listed.asks.length === 1);
  return asks[0];
}

// @anchor askBlocksUntilAnswered
test("ask writes an open record and blocks until an answer reaches it, within a poll", async (t) => {
  const p = await mailboxProject(t);
  const asking = ask(p.root, { taskId: "lead1", lineageIds: ["lead1"], question: "Which slug?", timeoutSeconds: 30, pollMs: 20 });
  const open = await theOpenAsk(p.root);
  assert.match(open.id, /^[0-9a-f]{36}$/, "an id from the ledger's own alphabet");
  assert.equal(open.taskId, "lead1");
  assert.equal(open.question, "Which slug?");
  assert.equal(open.status, "open");
  assert.equal(typeof open.createdAt, "number");
  assert.deepEqual(Object.keys(open).sort(), ["createdAt", "id", "question", "status", "taskId"]);
  assert.equal(fs.existsSync(path.join(asksDir(p.root), `${open.id}.json`)), true);

  const answered = await answerAsk(p.root, open.id, "use s11-i2");
  assert.equal(answered.applied, true);
  const started = performance.now();
  assert.deepEqual(await asking, { ok: true, id: open.id, status: "answered", answer: "use s11-i2" });
  assert.ok(performance.now() - started < 1000, "the waiting call reads the answer on its next poll");

  const stored = readAsk(p.root, open.id)!;
  assert.equal(stored.status, "answered");
  assert.equal(stored.answer, "use s11-i2");
  assert.equal(typeof stored.answeredAt, "number");
});

// @anchor askTimesOut
test("an ask that times out answers open with its id, and asking again by that id waits on the same record", async (t) => {
  const p = await mailboxProject(t);
  const first = await ask(p.root, { taskId: "lead1", lineageIds: ["lead1"], question: "Delete the branch?", timeoutSeconds: 0.1, pollMs: 20 });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.deepEqual(first, { ok: true, id: first.id, status: "open", hint: `call ask again with id ${first.id}` });

  // The same question, continued: no second file, and the answer reaches the second call.
  const again = ask(p.root, { taskId: "lead1", lineageIds: ["lead1"], id: first.id, timeoutSeconds: 30, pollMs: 20 });
  await delay(60);
  assert.deepEqual(fs.readdirSync(asksDir(p.root)), [`${first.id}.json`]);
  assert.equal((await answerAsk(p.root, first.id, "yes")).applied, true);
  assert.deepEqual(await again, { ok: true, id: first.id, status: "answered", answer: "yes" });
  assert.deepEqual(fs.readdirSync(asksDir(p.root)), [`${first.id}.json`]);
  // An answered ask asked again answers at once.
  assert.deepEqual(await ask(p.root, { taskId: "lead1", lineageIds: ["lead1"], id: first.id, timeoutSeconds: 30 }),
    { ok: true, id: first.id, status: "answered", answer: "yes" });
});

// @anchor askOutsideLineage
test("an ask id from outside the caller's lineage, or one nobody wrote, is refused by name", async (t) => {
  const p = await mailboxProject(t);
  const theirs = createAsk(p.root, { taskId: "lead-a", question: "Theirs?" });
  const refused = await ask(p.root, { taskId: "lead-b", lineageIds: ["lead-b", "lead-b-original"], id: theirs.id, timeoutSeconds: 1 });
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? "" : refused.reason, new RegExp(`refused ask ${theirs.id}: it was asked by task lead-a, which is not in task lead-b's lineage`));
  // A resumed lead's lineage is its own id and the ids it continues, so the original's
  // question is still its own to wait on.
  const resumed = await ask(p.root, { taskId: "lead-a2", lineageIds: ["lead-a2", "lead-a"], id: theirs.id, timeoutSeconds: 0 });
  assert.deepEqual(resumed, { ok: true, id: theirs.id, status: "open", hint: `call ask again with id ${theirs.id}` });

  assert.deepEqual(await ask(p.root, { taskId: "lead-b", lineageIds: ["lead-b"], id: "0".repeat(36), timeoutSeconds: 0 }),
    { ok: false, reason: `no ask ${"0".repeat(36)}` });
  // A question with no text is no question.
  assert.equal((await ask(p.root, { taskId: "lead-b", lineageIds: ["lead-b"], question: "", timeoutSeconds: 0 })).ok, false);
  assert.equal(readAsk(p.root, theirs.id)!.status, "open", "a refusal touches nothing");
});

// @anchor firstAnswerWins
test("the first answer wins: of two at once exactly one applies, and the other names when the first landed", async (t) => {
  const p = await mailboxProject(t);
  const question = createAsk(p.root, { taskId: "lead1", question: "Merge?" });
  const [one, two] = await Promise.all([answerAsk(p.root, question.id, "yes"), answerAsk(p.root, question.id, "no")]);
  const applied = [one, two].filter((result) => result.applied);
  const refused = [one, two].filter((result) => !result.applied);
  assert.equal(applied.length, 1);
  assert.equal(refused.length, 1);
  const winner = applied[0].ask!;
  assert.equal(readAsk(p.root, question.id)!.answer, winner.answer, "the stored answer is the one that applied");
  const reason = refused[0].applied ? "" : refused[0].reason;
  assert.match(reason, new RegExp(`answeredAt ${winner.answeredAt}`));
  assert.match(reason, new RegExp(new Date(winner.answeredAt!).toISOString().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  // A cancelled ask takes no answer at all, and an unknown one is named as unknown.
  const cancelledAsk = createAsk(p.root, { taskId: "lead2", question: "Rebase?" });
  assert.deepEqual((await cancelAsks(p.root, ["lead2"])).cancelled, [cancelledAsk.id]);
  const late = await answerAsk(p.root, cancelledAsk.id, "yes");
  assert.equal(late.applied, false);
  assert.match(late.applied ? "" : late.reason, /cancelled/);
  assert.equal(readAsk(p.root, cancelledAsk.id)!.answer, undefined);
  const unknown = await answerAsk(p.root, "f".repeat(36), "yes");
  assert.deepEqual(unknown, { applied: false, reason: `no ask ${"f".repeat(36)}`, ask: null });
});

// @anchor listAsksFilters
test("list_asks shows the operator every ask and a lead its own lineage's, filtered by status", async (t) => {
  const p = await mailboxProject(t);
  const original = createAsk(p.root, { taskId: "lead-a", question: "First?" }, 1_000);
  const answered = createAsk(p.root, { taskId: "lead-a", question: "Second?" }, 2_000);
  const stranger = createAsk(p.root, { taskId: "lead-b", question: "Theirs?" }, 3_000);
  assert.equal((await answerAsk(p.root, answered.id, "done")).applied, true);

  const ids = (filter: Parameters<typeof listAsks>[1] = {}) => listAsks(p.root, filter).asks.map((entry) => entry.id);
  // In the order they were asked, which is the order a reader follows a conversation in.
  assert.deepEqual(ids(), [original.id, answered.id, stranger.id], "the operator's listing is every ask");
  // A resumed lead's lineage reaches back to the record it continues, so it sees the
  // original's asks and nobody else's.
  assert.deepEqual(ids({ taskIds: ["lead-a2", "lead-a"] }), [original.id, answered.id]);
  assert.deepEqual(ids({ taskIds: ["lead-a2", "lead-a"], status: "open" }), [original.id]);
  assert.deepEqual(ids({ status: "answered" }), [answered.id]);
  assert.deepEqual(ids({ status: "cancelled" }), []);
  assert.deepEqual(listAsks(p.root).invalid, []);

  // A damaged file is named rather than hiding the rest.
  fs.writeFileSync(path.join(asksDir(p.root), "broken.json"), "{not json");
  assert.deepEqual(ids(), [original.id, answered.id, stranger.id]);
  assert.deepEqual(listAsks(p.root).invalid.map((entry) => path.basename(entry.file)), ["broken.json"]);
});

// @anchor abortedAskEnds
test("an aborted ask ends within 100 ms with its id and status, and the record is untouched", async (t) => {
  const p = await mailboxProject(t);
  const controller = new AbortController();
  const asking = ask(p.root, { taskId: "lead1", lineageIds: ["lead1"], question: "Still there?", timeoutSeconds: 600, signal: controller.signal });
  const open = await theOpenAsk(p.root);
  const before = fs.readFileSync(path.join(asksDir(p.root), `${open.id}.json`), "utf8");
  const aborted = performance.now();
  controller.abort();
  assert.deepEqual(await asking, { ok: true, id: open.id, status: "open", cancelled: true });
  assert.ok(performance.now() - aborted < 100, "an aborted ask answers within 100 ms");
  assert.equal(fs.readFileSync(path.join(asksDir(p.root), `${open.id}.json`), "utf8"), before);
});

// @anchor cancelAsksLineage
test("cancelAsks cancels the open asks of a lineage under each ask's lock, and leaves an answered one alone", async (t) => {
  const p = await mailboxProject(t);
  const open = createAsk(p.root, { taskId: "lead-a", question: "Open?" });
  const earlier = createAsk(p.root, { taskId: "lead-original", question: "From before the resume?" });
  const answered = createAsk(p.root, { taskId: "lead-a", question: "Answered?" });
  const stranger = createAsk(p.root, { taskId: "lead-b", question: "Not ours?" });
  assert.equal((await answerAsk(p.root, answered.id, "yes")).applied, true);

  const result = await cancelAsks(p.root, ["lead-a", "lead-original"], { now: 5_000 });
  assert.deepEqual(result.cancelled.sort(), [open.id, earlier.id].sort());
  assert.deepEqual(result.failures, []);
  for (const id of [open.id, earlier.id]) {
    const record = readAsk(p.root, id)!;
    assert.equal(record.status, "cancelled", id);
    assert.equal(record.cancelledAt, 5_000, id);
  }
  assert.equal(readAsk(p.root, answered.id)!.status, "answered");
  assert.equal(readAsk(p.root, answered.id)!.cancelledAt, undefined);
  assert.equal(readAsk(p.root, stranger.id)!.status, "open");
  // A lead asked again after its ask was cancelled learns so at once.
  assert.deepEqual(await ask(p.root, { taskId: "lead-a", lineageIds: ["lead-a"], id: open.id, timeoutSeconds: 30 }),
    { ok: true, id: open.id, status: "cancelled" });
  // The lock each one was written under is the ask's own.
  assert.equal(fs.existsSync(lockPath(p.root, askLockName(open.id))), true);
  assert.equal(askLockName(open.id), `ask-${open.id}.lock`);
});

// @anchor askReadsWriteNothing
test("reading, listing, answering or cancelling in a project with no mailbox writes nothing", async (t) => {
  const p = await mailboxProject(t);
  fs.rmSync(path.join(p.root, ".cross-agent"), { recursive: true, force: true });
  assert.equal(readAsk(p.root, "a".repeat(36)), null);
  assert.deepEqual(listAsks(p.root), { asks: [], invalid: [] });
  assert.deepEqual(await answerAsk(p.root, "a".repeat(36), "yes"), { applied: false, reason: `no ask ${"a".repeat(36)}`, ask: null });
  assert.deepEqual(await cancelAsks(p.root, ["lead1"]), { cancelled: [], failures: [] });
  assert.equal(fs.existsSync(path.join(p.root, ".cross-agent")), false, "no mailbox, no lock directory, no ledger");
  // An id is a file name, so one that could leave the directory is refused before any read.
  assert.throws(() => readAsk(p.root, "../tasks/x"), /invalid ask id/);
});
