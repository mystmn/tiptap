import { getMarksBetween, PasteRule } from '@tiptap/core'
import type { MarkType, Node as ProseMirrorNode } from '@tiptap/pm/model'
import { PluginKey } from '@tiptap/pm/state'

/**
 * Returns the `href` if every position between `from` and `to` carries a link mark
 * and all those marks share the same `href`.
 */
function coveredHref(
  doc: ProseMirrorNode,
  type: MarkType,
  from: number,
  to: number,
): string | null {
  const linkRanges = getMarksBetween(from, to, doc)
    .filter(item => item.mark.type === type)
    .sort((a, b) => a.from - b.from)

  if (linkRanges.length === 0) {
    return null
  }

  const sharedHref = linkRanges[0].mark.attrs.href
  let coveredUntil = from

  for (const range of linkRanges) {
    if (range.from > coveredUntil || range.mark.attrs.href !== sharedHref) {
      return null
    }

    coveredUntil = Math.max(coveredUntil, range.to)
  }

  if (coveredUntil >= to) {
    return sharedHref
  }

  return null
}

const parsedHtmlCache = new WeakMap<object, Set<string>>()

/**
 * Returns true if the given text matches the textContent of any `a[href]` in the HTML.
 * Memoizes the parsed HTML to avoid reparsing large clipboards per match.
 */
function anchorTextOwnsMatch(
  html: string,
  matchText: string,
  clipboardData: DataTransfer,
): boolean {
  if (typeof DOMParser === 'undefined') {
    return false // Fallback if no DOMParser, we don't have enough context, assume false.
  }

  let texts = parsedHtmlCache.get(clipboardData)
  if (!texts) {
    texts = new Set<string>()
    const anchors = new DOMParser().parseFromString(html, 'text/html').querySelectorAll('a[href]')
    for (let i = 0; i < anchors.length; i++) {
      if (anchors[i].textContent) {
        texts.add(anchors[i].textContent!.trim())
      }
    }
    parsedHtmlCache.set(clipboardData, texts)
  }

  return texts.has(matchText.trim())
}

/**
 * Wraps a paste rule so it leaves links alone that were pasted as HTML.
 *
 * Pasted HTML like `<a href="https://example.com/LICENSE.md">LICENSE.md</a>` is already
 * parsed into a link mark when the paste rules run. Without this, the link text is
 * matched as a URL of its own and the `href` from the HTML gets replaced.
 */
export function keepPastedLinks(rule: PasteRule, type: MarkType): PasteRule {
  return new PasteRule({
    find: rule.find,
    handler: props => {
      const { match, pasteEvent, dropEvent, range, state } = props

      const clipboardData = pasteEvent?.clipboardData || dropEvent?.dataTransfer
      const html = clipboardData?.getData('text/html')
      const plainText = clipboardData?.getData('text/plain')

      const existingHref = coveredHref(state.doc, type, range.from, range.to)

      // 1. If the match is not fully covered by link marks, run the paste rule as today.
      if (existingHref === null) {
        return rule.handler(props)
      }

      // 2. If it is fully covered and every covering mark already has the same href, skip.
      if (existingHref === match.data?.href) {
        return
      }

      // 3. If it is fully covered and the href differs, keep the existing href whenever
      // this match is the text of an anchor in the pasted HTML.
      if (html && clipboardData && anchorTextOwnsMatch(html, match[0], clipboardData)) {
        return
      }

      // 4. Run the retarget only when the pasted plain text is itself a single URL
      // (or markdown URL) and that URL is not the text of an anchor.
      // 5. Convert markdown only when step 4 would allow a retarget.
      // If the brackets are the anchor's label, leave them in place.
      if (!clipboardData || plainText?.trim() === match[0].trim()) {
        return rule.handler(props)
      }

      return
    },
  })
}
