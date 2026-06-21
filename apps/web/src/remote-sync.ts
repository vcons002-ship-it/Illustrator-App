/**
 * APP-STATE MIRROR — the messages a linked phone and its desktop exchange so the phone shows the
 * SAME content the desktop has (its library, the open book, that book's visual bible, and the
 * render-affecting settings), turning the phone into a live second screen rather than an empty
 * editor. These ride the same LAN relay as the engine messages (see `useEngineWorker`), but are
 * routed to the app-sync handler — told apart from engine messages by the `vrsync:`/`vrcmd:`
 * prefix (`isAppSyncMessage` in core). The desktop is the source of truth; the phone renders what
 * it's sent and issues high-level commands (open a library book, ask for a fresh snapshot). The
 * engine itself stays shared — illustrate/analyse/chat the phone triggers run on the desktop and
 * stream back over the same relay, so no model or data ever needs to live on the phone.
 */

import type { BookSource, BookSummary, VisualBible } from "@visual-reader/core";
import type { ReaderSettings } from "@visual-reader/ui";

/** A full snapshot of what the desktop is showing — sent when a phone first asks (`vrcmd:hello`). */
export interface MirrorSnapshot {
  /** A friendly desktop name for the phone's "Linked to …" header. */
  host?: string;
  library: BookSummary[];
  settings: ReaderSettings;
  /** The currently-open book (undefined when the desktop is on the home screen). */
  book?: BookSource;
  /** The open book's analysis (illustrations/concept cards/charts are anchored from this). */
  bible?: VisualBible;
}

/** Desktop → phone state pushes (source of truth). */
export type SyncToPhone =
  | ({ type: "vrsync:state" } & MirrorSnapshot)
  | { type: "vrsync:library"; library: BookSummary[] }
  | { type: "vrsync:settings"; settings: ReaderSettings }
  | { type: "vrsync:book"; book?: BookSource; bible?: VisualBible };

/** Phone → desktop commands. */
export type CmdToDesktop =
  | { type: "vrcmd:hello" } // "I just connected — send me a full snapshot."
  | { type: "vrcmd:open"; bookId: string } // open this library book on the desktop
  | { type: "vrcmd:home" } // leave the open book (back to the desktop's home screen)
  | { type: "vrcmd:settings"; settings: ReaderSettings }; // phone edited settings → apply on the desktop (it renders)

export type AppSyncMessage = SyncToPhone | CmdToDesktop;

/** A command the phone sends the desktop (vs. a state push the desktop sends the phone). */
export function isCmdToDesktop(msg: AppSyncMessage): msg is CmdToDesktop {
  return msg.type.startsWith("vrcmd:");
}
