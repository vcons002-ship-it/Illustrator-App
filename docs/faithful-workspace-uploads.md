# Faithful workspace uploads

Desktop chat attachments save the original bytes when sent. Library/open-file imports save the
original when opened. Linked-phone uploads use the desktop's selected workspace, never phone-local
storage. Without a desktop connection, the browser can still analyze files but cannot save them
to a desktop workspace.

Originals go to `uploads/<original-filename>` under the selected project/chat workspace. This
includes images, PDF/DOCX/XLSX files, source code, books, empty files and unsupported binary formats.
The bytes are never reconstructed from extracted text, normalized code, a resized image preview,
or a model description. PNG/JPEG/other image files retain their original encoding and metadata.

The native writer requires an explicit approved workspace. It rejects an `uploads` link/junction
resolving outside that workspace, disallows filename paths/traversal, and creates files atomically
with `create_new`. Existing files are never overwritten: a duplicate becomes `name (2).ext`, etc.
Invalid Windows filename characters/reserved device names are adjusted and reported. Filenames
over 180 characters are rejected, not silently truncated. Desktop originals are capped at 100 MiB.

Document parsing remains available for chat. Complete extracted text, when available, is saved
separately as `uploads/<saved-filename>.extracted.txt`, never under the PDF/Word/Excel extension.
The model's inline excerpt is capped at 30,000 characters; the original is not truncated. Extracted
sidecars have a 20 MiB UTF-8 byte limit. A sidecar failure reports that the original succeeded but
the text copy did not. A parser failure does not prevent saving an intact original.

Chat shows the actual original path, byte count, rename/collision note and separate text-copy path.
Original file cards open/download the real saved file. Both originals and sidecars enter the file
ledger so subsequent coding-agent calls can find them; binary originals need format-aware readers.
Disk/native-command failures are explicit: chat must not claim a file was saved when it was not.
Older phone clients without original-byte metadata are asked to reattach in the updated app rather
than silently saving extracted text as though it were the original.

For phone uploads, original bytes remain separate from image previews (which may be resized for
vision/render conditioning). The sender measures the real base64/UTF-8 wire payload. The existing
3 MB command budget is intentionally retained; large originals, long text, or combined attachments
that exceed it are rejected with a desktop-upload suggestion. Originals and text tails are never
dropped to make the frame fit, and rejected pending attachments remain in the composer. This
version does not add chunked phone-to-desktop uploads. Save acknowledgments have a 60-second
backstop; an unconfirmed save may exist and retries can produce another numbered original.

Chat/project/workspace identity is captured before asynchronous preparation. Phone requests with
a stale chat/project/root are rejected rather than saved to another workspace. Newly created
personal chat folders use the same resolver as project workspaces. Existing original saves are
not deleted if the user switches chats during a save; they remain in their intended workspace.
Library code imports retain their separate editor working-copy behavior, but opening an upload
must not overwrite an existing working copy. Editing that copy is separate from saving the
faithful original under `uploads/`.

No files are executed as part of upload/save. Existing chat/image analysis may still use the
configured local/cloud providers just as before; saving an original is not permission to execute it.
