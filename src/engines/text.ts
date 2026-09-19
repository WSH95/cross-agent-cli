/**
 * What the adapters read out of an engine's own event shapes. Three of them speak
 * near-identical dialects — two in the Anthropic Messages API wire shape outright — so
 * the readers live here once and each adapter's `parseLine` stays its own (design
 * section 3, bead `atc-s96.41`). Nothing here knows an engine: everything an engine
 * decides, including which field its failures carry, is a parameter.
 */

/** How much of a turn is kept as evidence of progress: enough to read, not a transcript. */
export const activityLimit = 200;

/** Whole code points: cutting UTF-16 units could leave a lone surrogate in the ledger. */
export function truncate(text: string): string {
  if (text.length <= activityLimit) return text;
  return Array.from(text).slice(0, activityLimit).join("");
}

/** The text blocks of an assistant turn, joined. Thinking and tool calls are not text. */
export function assistantText(message: unknown): string {
  const content = (message as { content?: unknown } | null | undefined)?.content;
  // The wire shape is the Anthropic Messages API's, where content is blocks or a string.
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const block of content as Array<{ type?: unknown; text?: unknown } | null>) {
    if (block?.type === "text" && typeof block.text === "string") texts.push(block.text);
  }
  return texts.join("\n");
}

/** A result line, as far as a failure reader looks at it. */
export interface FailureLine {
  subtype?: unknown;
  result?: unknown;
  errors?: unknown;
}

function resultText(event: FailureLine): string | null {
  return typeof event.result === "string" && event.result !== "" ? event.result : null;
}

// A list, so an operator reading a failure gets every line of it, one per line.
function errorsText(event: FailureLine): string | null {
  if (!Array.isArray(event.errors) || event.errors.length === 0) return null;
  return event.errors.map((entry) => typeof entry === "string" ? entry : JSON.stringify(entry)).join("\n");
}

/**
 * What a failed run says, read from the line the engine ended on. `first` is which field
 * that engine puts the message in, and it is a parameter because the two engines
 * disagree: Claude's failures carry it in `result`, Grok's in an `errors` array with no
 * `result` field at all (P8). The other field is read second rather than dropped, since
 * neither engine's shape has been probed in every mode, and a failure with neither still
 * has to say something — so it says which engine failed and which failure it was.
 */
export function failureText(event: FailureLine, first: "result" | "errors", engine: string): string {
  for (const read of first === "result" ? [resultText, errorsText] : [errorsText, resultText]) {
    const text = read(event);
    if (text !== null) return text;
  }
  return `${engine} reported ${typeof event.subtype === "string" ? event.subtype : "a failure"} with no message`;
}
