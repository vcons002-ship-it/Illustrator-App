/**
 * Content-derived, filesystem-safe export filenames. A book/table title (or a code block's
 * heading) becomes a readable slug; the rename-before-save modal shows it as the default the user
 * can edit. Pure + unit-tested. Uses an ALLOWLIST (ASCII letters/digits + space . _ -) so the
 * result is always a strict subset of what the desktop shell's `sanitize_filename` (main.rs)
 * accepts — the name shown is exactly the name written. Non-ASCII is dropped (NFKD first, so
 * accents fold to their base letter); a title that reduces to nothing falls back to "export".
 */

/** A filesystem-safe, readable slug from arbitrary text. */
export function slugify(input: string, maxLen = 60): string {
  return (input ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // drop the combining marks NFKD split off (café → cafe)
    .replace(/[^A-Za-z0-9 ._-]+/g, " ") // keep only safe chars; everything else → space
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+/, "")
    .slice(0, maxLen)
    .replace(/[-.]+$/, "");
}

/** A complete export filename: a slug of `base` (or `fallback` when it slugs to empty) + a single
 * `.ext`. Strips any leading dots from `ext` so it's never doubled. */
export function exportFilename(base: string, ext: string, fallback = "export"): string {
  const stem = slugify(base) || fallback;
  const e = ext.replace(/^\.+/, "");
  return e ? `${stem}.${e}` : stem;
}
