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
 * Returns `fill(body)`, which sets an empty `preview` on sessions in a parsed
 * `/api/sessions` list (`{ data: [...] }`) or single-session (`{ session }`) body,
 * resolving the number of previews it filled.
 * `fetchMessages(sessionId, signal)` returns that session's `/messages` body. At most
 * MAX_LOOKUPS sessions per response, each bounded by `timeout`; any failure leaves the
 * preview empty. Results are cached by session id and `last_active`.
 */
export function createPreviewFiller({ fetchMessages, timeout = 2_000 }) {
  const cache = new Map();

  async function lookup(session) {
    const key = `${session.id}\u0000${session.last_active ?? ""}`;
    if (cache.has(key)) return cache.get(key);
    const body = await fetchMessages(session.id, AbortSignal.timeout(timeout));
    if (!Array.isArray(body?.data)) throw new Error("invalid messages response");
    const preview = latestAssistantPreview(body.data);
    cache.set(key, preview);
    if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
    return preview;
  }

  return async function fill(body) {
    const sessions = Array.isArray(body?.data) ? body.data : body?.session ? [body.session] : [];
    const empty = sessions
      .filter((session) => session && typeof session.id === "string" && (session.preview === "" || session.preview === null) && session.message_count !== 0)
      .slice(0, MAX_LOOKUPS);
    let next = 0;
    let filled = 0;
    const worker = async () => {
      while (next < empty.length) {
        const session = empty[next++];
        try {
          const preview = await lookup(session);
          if (preview) { session.preview = preview; filled++; }
        } catch { /* The preview stays empty. */ }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, empty.length) }, worker));
    return filled;
  };
}
