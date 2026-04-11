/**
 * Convert Claude's markdown output to Telegram-safe HTML.
 * Uses HTML parse_mode (more predictable than MarkdownV2).
 */

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function formatForTelegram(text: string): string {
  // First, extract and protect code blocks (handles ``` with or without language)
  const codeBlocks: string[] = [];
  let processed = text.replace(/```([\w.-]*)\n?([\s\S]*?)```/g, (_match, lang, code) => {
    const idx = codeBlocks.length;
    const escaped = escapeHtml(code.trimEnd());
    if (lang) {
      codeBlocks.push(`<pre><code class="language-${escapeHtml(lang)}">${escaped}</code></pre>`);
    } else {
      codeBlocks.push(`<pre>${escaped}</pre>`);
    }
    return `\x00CB${idx}\x00`;
  });

  // Protect inline code (handle both `code` and ``code``)
  const inlineCode: string[] = [];
  processed = processed.replace(/``([^`]+)``|`([^`\n]+)`/g, (_match, double, single) => {
    const code = double || single;
    const idx = inlineCode.length;
    inlineCode.push(`<code>${escapeHtml(code)}</code>`);
    return `\x00IC${idx}\x00`;
  });

  // Escape HTML in remaining text
  processed = escapeHtml(processed);

  // Convert markdown links [text](url) → <a href="url">text</a>
  processed = processed.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2">$1</a>'
  );

  // Convert bold **text** or __text__
  processed = processed.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  processed = processed.replace(/__(.+?)__/g, "<b>$1</b>");

  // Convert italic *text* or _text_ (not inside bold markers or underscores in words)
  processed = processed.replace(/(?<![*\w])\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<i>$1</i>");
  processed = processed.replace(/(?<![_\w])_(?!_)(.+?)(?<!_)_(?!_)/g, "<i>$1</i>");

  // Convert strikethrough ~~text~~
  processed = processed.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // Convert blockquotes (lines starting with >)
  processed = processed.replace(/^&gt; (.+)$/gm, "<blockquote>$1</blockquote>");
  // Merge consecutive blockquotes
  processed = processed.replace(/<\/blockquote>\n<blockquote>/g, "\n");

  // Convert markdown headers to bold text
  processed = processed.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");

  // Convert horizontal rules
  processed = processed.replace(/^[-*_]{3,}$/gm, "———");

  // Convert bullet lists: - or * at start of line → bullet character
  processed = processed.replace(/^[\s]*[-*]\s+/gm, "  • ");

  // Convert numbered lists: keep as-is but ensure clean formatting
  processed = processed.replace(/^[\s]*(\d+)\.\s+/gm, "  $1. ");

  // Restore inline code
  processed = processed.replace(/\x00IC(\d+)\x00/g, (_match, idx) => {
    return inlineCode[parseInt(idx)];
  });

  // Restore code blocks
  processed = processed.replace(/\x00CB(\d+)\x00/g, (_match, idx) => {
    return codeBlocks[parseInt(idx)];
  });

  // Clean up excessive newlines (more than 2 consecutive)
  processed = processed.replace(/\n{3,}/g, "\n\n");

  return processed.trim();
}

export function formatCostFooter(costUsd: number, durationMs: number, model: string): string {
  const cost = costUsd > 0 ? `$${costUsd.toFixed(3)}` : "--";
  const duration = durationMs > 0 ? `${(durationMs / 1000).toFixed(1)}s` : "--";
  return `\n\n<i>${cost} | ${duration} | ${model}</i>`;
}

/**
 * Split a message into chunks that fit Telegram's 4096 char limit.
 * Tries to split at paragraph boundaries, then line boundaries.
 * Handles code blocks by closing/reopening <pre> tags at split points.
 */
export function splitMessage(text: string, maxLen: number = 4096): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // Try to split at paragraph boundary
    let splitIdx = remaining.lastIndexOf("\n\n", maxLen);

    // Fall back to line boundary
    if (splitIdx <= 0) {
      splitIdx = remaining.lastIndexOf("\n", maxLen);
    }

    // Fall back to space
    if (splitIdx <= 0) {
      splitIdx = remaining.lastIndexOf(" ", maxLen);
    }

    // Hard split as last resort
    if (splitIdx <= 0) {
      splitIdx = maxLen;
    }

    let chunk = remaining.slice(0, splitIdx);
    remaining = remaining.slice(splitIdx).trimStart();

    // If we split inside a <pre> block, close it and re-open in next chunk
    const openPre = (chunk.match(/<pre>/g) || []).length + (chunk.match(/<pre><code[^>]*>/g) || []).length;
    const closePre = (chunk.match(/<\/pre>/g) || []).length;

    if (openPre > closePre) {
      // Find the last unclosed <pre> tag to know if it has a <code> wrapper
      const lastPreMatch = chunk.match(/<pre>(?:<code[^>]*>)?(?![\s\S]*<\/pre>)/);
      chunk += "</pre>";
      // Re-open in next chunk
      if (lastPreMatch) {
        const tag = lastPreMatch[0]; // e.g., <pre> or <pre><code class="language-ts">
        remaining = tag + remaining;
      } else {
        remaining = "<pre>" + remaining;
      }
    }

    chunks.push(chunk);
  }

  return chunks;
}

/**
 * Send very long output as a document instead of multiple messages.
 * Returns true if the text should be sent as a file.
 */
export function shouldSendAsFile(text: string): boolean {
  return text.length > 4096 * 4; // More than ~4 messages worth
}
