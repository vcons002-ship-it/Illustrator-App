import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(join(import.meta.dirname, file), "utf8");
const panel = read("ChatBuddyPanel.tsx");
const app = read("../../../apps/web/src/App.tsx");
const css = read("styles/layout.css");
const sidebar = read("CollapsibleSidebar.tsx");

describe("chat-first shell", () => {
  it("uses available home height instead of a fixed viewport subtraction or width cap", () => {
    expect(app).toContain('<section className="vr-home-conversation">{renderBuddyChat(true)}</section>');
    expect(css).toContain('.vr-home-chat > .vr-reader-yield { display: flex; flex-direction: column; overflow: hidden; }');
    expect(css).toContain('.vr-home-conversation > .vr-chat-open { width: 100%; height: 100%; min-width: 0; }');
    expect(app).toContain('height: "100dvh"');
    expect(app).toContain('book && dockMode === "full"');
  });

  it("puts app navigation and passive model status in initially collapsed drawers", () => {
    expect(app).toContain('useState<"navigation" | "details" | null>(null)');
    const navigation = app.indexOf('<CollapsibleSidebar open={shellDrawer === "navigation"}');
    const navigationEnd = app.indexOf('</CollapsibleSidebar>', navigation);
    expect(app.indexOf('<SettingsPanel', navigation)).toBeGreaterThan(navigation);
    expect(app.indexOf('<SettingsPanel', navigation)).toBeLessThan(navigationEnd);
    const details = app.indexOf('<CollapsibleSidebar open={shellDrawer === "details"}');
    const detailsEnd = app.indexOf('</CollapsibleSidebar>', details);
    expect(app.indexOf('<ProviderBadges', details)).toBeGreaterThan(details);
    expect(app.indexOf('<ProviderBadges', details)).toBeLessThan(detailsEnd);
    // Alerts and active work aren't hidden with the passive status pills.
    expect(app.indexOf('<ActivityCenter', detailsEnd)).toBeGreaterThan(detailsEnd);
    expect(app).toContain('activities.some(a => a.status === "active" || a.status === "queued" || a.status === "error")');
    expect(app.indexOf('<ToastHost', details)).toBeGreaterThan(detailsEnd);
  });

  it("keeps project management and workspace/context details together, outside message layout", () => {
    const drawer = panel.indexOf('<CollapsibleSidebar open={showTools}');
    const end = panel.indexOf('</CollapsibleSidebar>', drawer);
    for (const component of ['<ProjectWorkspaceBar', '<WorkingFolderBar', '<UsageDisclosure']) {
      expect(panel.indexOf(component, drawer)).toBeGreaterThan(drawer);
      expect(panel.indexOf(component, drawer)).toBeLessThan(end);
    }
    expect(end).toBeLessThan(panel.indexOf('onScroll={trackNearBottom}'));
  });

  it("collapses optional composer tools without burying Stop, approvals or live-control off", () => {
    expect(panel).toContain('const [utilitiesOpen, setUtilitiesOpen] = useState(false)');
    expect(panel).toContain('hidden={!utilitiesOpen}');
    const composer = panel.indexOf('ref={composerRef}');
    expect(panel.indexOf('{props.liveControl?.on &&', composer)).toBeGreaterThan(composer);
    expect(panel.indexOf('onClick={props.onCancel}', composer)).toBeGreaterThan(composer);
    expect(panel.indexOf('<div style={approvalDockStyle}>')).toBeLessThan(composer);
  });

  it("uses a portalled non-modal drawer with hidden controls excluded from Tab and guarded Escape", () => {
    expect(sidebar).toContain('createPortal(');
    expect(sidebar).toContain('hidden={!open}');
    expect(sidebar).not.toContain('aria-modal');
    expect(sidebar).toContain('openDrawers[openDrawers.length - 1] !== key');
    expect(sidebar).toContain('opener.current?.focus()');
    expect(css).toContain('.vr-sidebar[hidden] { display: none; }');
    expect(css).toContain('width: min(390px, 100vw)');
  });
});
