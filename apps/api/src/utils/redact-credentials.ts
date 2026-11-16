/**
 * Hide `user:password@` in anything echoed back (e.g. proxy URLs in warnings).
 * Text without an `@` cannot carry credentials and is returned untouched. The
 * user and password runs are bounded (256 / 512 characters — far beyond any real
 * proxy credential): unbounded, the second pattern rescans the rest of a long
 * `=x:=x:…` run from every `=` (quadratic; ~1.8 s for 60 KB), bounded it costs at
 * most a constant per character. Caller-controlled keys in notes are also cut to
 * 80 characters by `normalizeCrawlOverride`.
 *
 * Shared by the crawl-policy endpoint (`jobs/health.controller.ts`) and the
 * log-safe request body of the global exception filter (`filters/log-safe-body.ts`).
 */
export function redactCredentials(text: string): string {
  if (text.indexOf('@') === -1) return text;
  return text
    .replace(/(\/\/)[^/@\s]{1,512}@/g, '$1***@')
    .replace(/(^|[\s"'(,=])[^\s"'(,=/@:]{1,256}:[^\s"'@/]{1,512}@/g, '$1***@');
}
