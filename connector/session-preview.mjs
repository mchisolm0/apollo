// Hermes previews a session with its first user message, so threads that producers
// create with only assistant messages list with an empty preview. These helpers fill
// that gap from the latest assistant message, through the Hermes HTTP API.

// Same shape as Hermes's `_shape_preview` (hermes_state_common.py): one line, 60 chars, then "...".
const PREVIEW_MAX_CHARS = 60;
const MAX_LOOKUPS = 20;
const CONCURRENCY = 4;
const CACHE_SIZE = 500;

/** Markdown to one plain line, capped like a Hermes preview. */
export function previewText(markdown) {
  const text = markdown
    .replace(/^\s*(```|~~~).*$/gmu, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/<[^>\n]+>/gu, " ")
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/gmu, "")
    .replace(/^\s*([-*_]\s*){3,}$/gmu, " ")
    .replace(/^\s*\|?(\s*:?-+:?\s*\|)+\s*:?-*:?\s*$/gmu, " ")
    .replace(/\|/gu, " ")
    .replace(/(\*\*|__|~~|`)/gu, "")
    .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,!?:;]|$)/gmu, "$1$2")
    .replace(/\s+/gu, " ")
    .trim();
  return text.length > PREVIEW_MAX_CHARS ? `${text.slice(0, PREVIEW_MAX_CHARS)}...` : text;
}

function messageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => typeof part?.text === "string" ? part.text : "").join(" ");
}

function latestAssistantPreview(messages) {
  let latest = null;
  for (const [index, message] of messages.entries()) {
    if (message?.role !== "assistant" || message.display_kind === "hidden") continue;
    const preview = previewText(messageText(message.content));
    if (!preview) continue;
    const at = typeof message.timestamp === "number" ? message.timestamp : -Infinity;
    if (!latest || at > latest.at || (at === latest.at && index > latest.index)) latest = { at, index, preview };
  }
  return latest?.preview ?? "";
}

/**
 * Returns `fill(body, signal)`, which sets an empty `preview` on sessions in a parsed
 * `/api/sessions` list (`{ data: [...] }`) or single-session (`{ session }`) body,
 * resolving the number of previews it filled. `fetchMessages(sessionId, signal)`
 * returns that session's `/messages` body.
 *
 * Cached previews are always applied. Then at most MAX_LOOKUPS uncached sessions are
 * looked up, all within one `budget` that also ends when `signal` aborts (the client
 * left). Results are cached by session id and `last_active`; failures, and sessions
 * without `last_active`, only for `shortTtl`. Any failure leaves the preview empty.
 */
export function createPreviewFiller({ fetchMessages, budget = 2_000, shortTtl = 60_000 }) {
  const cache = new Map();

  const remember = (key, value, ttl = Infinity) => {
    cache.delete(key);
    cache.set(key, { value, until: Date.now() + ttl });
    if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
  };

  return async function fill(body, signal) {
    const sessions = Array.isArray(body?.data) ? body.data : body?.session ? [body.session] : [];
    let filled = 0;
    const apply = (session, preview) => {
      if (preview) { session.preview = preview; filled++; }
    };
    const uncached = [];
    for (const session of sessions) {
      if (!session || typeof session.id !== "string" || !(session.preview === "" || session.preview === null) || session.message_count === 0) continue;
      const stamped = typeof session.last_active === "number";
      const key = `${session.id}\u0000${stamped ? session.last_active : ""}`;
      const hit = cache.get(key);
      if (hit && hit.until > Date.now()) apply(session, hit.value);
      else uncached.push({ session, key, stamped });
    }
    const pending = uncached.slice(0, MAX_LOOKUPS);
    const deadline = AbortSignal.any([AbortSignal.timeout(budget), ...(signal ? [signal] : [])]);
    let next = 0;
    const worker = async () => {
      while (next < pending.length && !deadline.aborted) {
        const { session, key, stamped } = pending[next++];
        try {
          const response = await fetchMessages(session.id, deadline);
          if (!Array.isArray(response?.data)) throw new Error("invalid messages response");
          const preview = latestAssistantPreview(response.data);
          remember(key, preview, stamped ? Infinity : shortTtl);
          apply(session, preview);
        } catch {
          // A client that left says nothing about Hermes; anything else is cached briefly so a slow /messages can't slow every list.
          if (!signal?.aborted) remember(key, "", shortTtl);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker));
    return filled;
  };
}
