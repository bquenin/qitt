// Batch kept events and deliver each batch to the qitt webhook.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { renderDigest } from "./digest.mjs";
import { errorText } from "./log.mjs";
import { tsDate, windowLocal } from "./time.mjs";

// The window label spans the batch's message times. The prompt reads only digest; events stay in
// the body for the log, dry runs, and tests.
export const buildBody = (events, id = randomUUID()) => {
  const times = events.map((e) => Number(e.ts));
  const body = {
    id,
    count: events.length,
    window: windowLocal(tsDate(Math.min(...times)), tsDate(Math.max(...times))),
    events,
  };
  return { ...body, digest: renderDigest(body) };
};

// Collects events for windowMs after the first one, then hands one body to flush. onAdd sees each
// event added or swapped in as it arrives.
export class Batcher {
  constructor({ windowMs, flush, log = () => {}, onAdd = () => {} }) {
    this.windowMs = windowMs;
    this.flush = flush;
    this.log = log;
    this.onAdd = onAdd;
    this.pending = [];
    this.timer = undefined;
  }

  add(event) {
    this.onAdd(event);
    this.pending.push(event);
    this.timer ??= setTimeout(() => this.#fire(), this.windowMs);
  }

  // The event with this id still waiting in the batch, or undefined.
  find(id) {
    return this.pending.find((e) => e.id === id);
  }

  // Swaps the waiting event with this id for another. False when no such event is waiting.
  replace(id, event) {
    const i = this.pending.findIndex((e) => e.id === id);
    if (i === -1) return false;
    this.onAdd(event);
    this.pending[i] = event;
    return true;
  }

  #fire() {
    const pending = this.pending;
    this.pending = [];
    this.timer = undefined;
    if (pending.length === 0) return;
    const body = buildBody(pending);
    Promise.resolve()
      .then(() => this.flush(body))
      .catch((err) => this.log(`batch ${body.id} flush error: ${errorText(err)}`));
  }
}

// POSTs a body to the URL in urlFile, read at every attempt so a rotated URL takes effect.
// Success is HTTP 202. Retries with backoff, then logs and drops: losing events while qitt is
// down is acceptable. The URL never reaches the log.
export const postBatch = async (
  body,
  { urlFile, log, fetchImpl = fetch, attempts = 3, delaysMs = [2000, 8000], wait = sleep, timeoutMs = 10000 },
) => {
  const json = JSON.stringify(body);
  let outcome;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const url = readFileSync(urlFile, "utf8").trim();
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: json,
        signal: AbortSignal.timeout(timeoutMs),
      });
      await res.body?.cancel?.().catch(() => {});
      if (res.status === 202) {
        log(`batch ${body.id} count=${body.count} status=202`);
        return true;
      }
      outcome = `status=${res.status}`;
    } catch (err) {
      outcome = `error=${errorText(err.name === "TimeoutError" ? { code: "timeout" } : err)}`;
    }
    log(`batch ${body.id} attempt ${attempt}/${attempts} failed: ${outcome}`);
    if (attempt < attempts) await wait(delaysMs[Math.min(attempt - 1, delaysMs.length - 1)]);
  }
  log(`batch ${body.id} count=${body.count} dropped after ${attempts} attempts (${outcome})`);
  return false;
};
