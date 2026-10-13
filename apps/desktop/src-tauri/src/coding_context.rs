//! Bounded, read-only context reads confined to the selected workspace, including symlink targets.
use std::{io::Read, path::Path};

const NOTES: &[&str] = &[
    "AGENTS.override.md",
    "AGENTS.md",
    "CONVENTIONS.md",
    "README.md",
    "notes/project-context.md",
    "notes/decisions.md",
    "notes/current-task.md",
];
const MAX_CONTEXT_BYTES: u64 = 12_000;

#[derive(Debug, serde::Serialize)]
pub(crate) struct ContextRead {
    exists: bool,
    text: String,
    truncated: bool,
}

pub(crate) fn read_note(base: &Path, rel_path: &str) -> Result<ContextRead, String> {
    if !NOTES.contains(&rel_path) {
        return Err("Not an approved coding context document.".into());
    }
    let base = base
        .canonicalize()
        .map_err(|_| "Coding workspace is unavailable.")?;
    let dest = base.join(rel_path);
    let resolved = match dest.canonicalize() {
        Ok(p) => p,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ContextRead {
                exists: false,
                text: String::new(),
                truncated: false,
            })
        }
        Err(_) => return Err("Context document cannot be resolved.".into()),
    };
    if !resolved.starts_with(&base) {
        return Err("Context document resolves outside the selected workspace.".into());
    }
    let file = std::fs::File::open(resolved).map_err(|_| "Context document cannot be opened.")?;
    if !file
        .metadata()
        .map_err(|_| "Context metadata unavailable.")?
        .is_file()
    {
        return Err("Context document is not a regular file.".into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_CONTEXT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Context read failed.")?;
    let truncated = bytes.len() > MAX_CONTEXT_BYTES as usize;
    bytes.truncate(MAX_CONTEXT_BYTES as usize);
    Ok(ContextRead {
        exists: true,
        text: String::from_utf8_lossy(&bytes).into_owned(),
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reads_only_allowlisted_bounded_notes() {
        let dir = std::env::temp_dir().join(format!("vr-context-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("README.md"), "x".repeat(20_000)).unwrap();
        let result = read_note(&dir, "README.md").unwrap();
        assert!(result.exists && result.truncated);
        assert_eq!(result.text.len(), 12_000);
        assert!(!read_note(&dir, "AGENTS.md").unwrap().exists);
        assert!(read_note(&dir, "../README.md").is_err());
        assert!(read_note(&dir, ".env").is_err());
        std::fs::remove_file(dir.join("README.md")).unwrap();
        std::fs::remove_dir(dir).unwrap();
    }
    #[test]
    fn rejects_a_note_link_outside_the_workspace() {
        let dir = std::env::temp_dir().join(format!("vr-context-link-{}", std::process::id()));
        let outside =
            std::env::temp_dir().join(format!("vr-context-secret-{}.md", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&outside, "not project context").unwrap();
        #[cfg(windows)]
        let linked = std::os::windows::fs::symlink_file(&outside, dir.join("AGENTS.md"));
        #[cfg(not(windows))]
        let linked = std::os::unix::fs::symlink(&outside, dir.join("AGENTS.md"));
        // Windows symlink creation needs developer mode or elevated rights on some hosts.
        if linked.is_ok() {
            assert!(read_note(&dir, "AGENTS.md")
                .unwrap_err()
                .contains("outside"));
            std::fs::remove_file(dir.join("AGENTS.md")).unwrap();
        } else {
            #[cfg(windows)]
            {
                // Junctions require no symlink privilege and exercise the same canonical boundary.
                let outside_notes = std::env::temp_dir()
                    .join(format!("vr-context-outside-notes-{}", std::process::id()));
                std::fs::create_dir_all(&outside_notes).unwrap();
                std::fs::write(
                    outside_notes.join("project-context.md"),
                    "not project context",
                )
                .unwrap();
                let result = std::process::Command::new("cmd.exe")
                    .args(["/d", "/c", "mklink", "/J"])
                    .arg(dir.join("notes"))
                    .arg(&outside_notes)
                    .output()
                    .unwrap();
                assert!(
                    result.status.success(),
                    "Junction fixture failed: {}",
                    String::from_utf8_lossy(&result.stderr)
                );
                assert!(read_note(&dir, "notes/project-context.md")
                    .unwrap_err()
                    .contains("outside"));
                std::fs::remove_dir(dir.join("notes")).unwrap(); // removes the junction itself only
                std::fs::remove_file(outside_notes.join("project-context.md")).unwrap();
                std::fs::remove_dir(outside_notes).unwrap();
            }
            #[cfg(not(windows))]
            panic!("Symlink fixture failed: {:?}", linked.err());
        }
        std::fs::remove_file(outside).unwrap();
        std::fs::remove_dir(dir).unwrap();
    }
}
