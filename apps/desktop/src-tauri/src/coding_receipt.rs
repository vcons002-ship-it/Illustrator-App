//! Compare the working tree before/after a coding call, including untracked files.
//! Git's real index, branches and commits are never changed. An alternate index produces
//! unreferenced tree objects; Git's normal garbage collection can later prune those objects.
use std::path::{Path, PathBuf};
use std::io::Read;
use std::process::Stdio;
use std::time::{Duration, Instant};
use serde::Serialize;

const PATHS: [&str; 5] = [".", ":(exclude).vr-codex/**", ":(exclude).vr-coding-task.md", ":(glob,exclude)**/.vr-codex/**", ":(glob,exclude)**/.vr-coding-task.md"];
const MAX_REPORT_BYTES: usize = 4 * 1024 * 1024;

#[derive(Serialize)]
pub struct Snapshot {
    pub tree: String,
    pub workspace: String,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct FileChange {
    pub path: String,
    pub kind: String,
    pub added: Option<u64>,
    pub removed: Option<u64>,
    pub binary: bool,
}

/// A private, uniquely created directory. Cleanup removes only its two known index files.
struct PrivateIndex(PathBuf);
impl PrivateIndex {
    fn new() -> Result<Self, String> {
        static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e| e.to_string())?.as_nanos();
        let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("vr-coding-index-{}-{nonce}-{seq}", std::process::id()));
        std::fs::create_dir(&dir).map_err(|e| e.to_string())?;
        Ok(Self(dir))
    }
    fn path(&self) -> PathBuf { self.0.join("index") }
}
impl Drop for PrivateIndex {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(self.path());
        let _ = std::fs::remove_file(self.0.join("index.lock"));
        let _ = std::fs::remove_dir(&self.0);
    }
}

fn capture_pipe<T: Read + Send + 'static>(pipe: Option<T>, limit: u64) -> std::thread::JoinHandle<Vec<u8>> {
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(mut pipe) = pipe {
            let _ = (&mut pipe).take(limit).read_to_end(&mut bytes);
            // Continue draining without retaining excess output. The caller detects overflow
            // and rejects the report rather than displaying silently truncated counts.
            let _ = std::io::copy(&mut pipe, &mut std::io::sink());
        }
        bytes
    })
}

fn run_git(dir: &Path, args: &[&str], index: Option<&Path>) -> Result<Vec<u8>, String> {
    let mut command = super::quiet_command("git");
    command.current_dir(dir).args(args).env("GIT_TERMINAL_PROMPT", "0").env("GIT_OPTIONAL_LOCKS", "0")
        .stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(index) = index { command.env("GIT_INDEX_FILE", index); }
    let mut child = command.spawn().map_err(|e| format!("Couldn't capture coding changes: {e}"))?;
    // Drain both pipes while waiting, so warnings or a large filename list cannot deadlock Git.
    let stdout = capture_pipe(child.stdout.take(), (MAX_REPORT_BYTES + 1) as u64);
    let stderr = capture_pipe(child.stderr.take(), 4096);
    let deadline = Instant::now() + Duration::from_secs(60);
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            Ok(None) => { super::kill_tree(&mut child); timed_out = true; break child.wait().map_err(|e| e.to_string())?; }
            Err(e) => { super::kill_tree(&mut child); return Err(e.to_string()); }
        }
    };
    let stdout = stdout.join().unwrap_or_default();
    let stderr = stderr.join().unwrap_or_default();
    if timed_out { return Err("Git change capture timed out after 60 seconds; counts are unavailable.".into()); }
    if !status.success() {
        return Err(String::from_utf8_lossy(&stderr).chars().take(600).collect());
    }
    if stdout.len() > MAX_REPORT_BYTES { return Err("Change report exceeded its safe output limit; counts are unavailable.".into()); }
    Ok(stdout)
}

pub fn snapshot(dir: &Path) -> Result<Snapshot, String> {
    let dir = std::fs::canonicalize(dir).map_err(|e| format!("Workspace is unavailable: {e}"))?;
    let private = PrivateIndex::new()?;
    let index = private.path();
    // Seed from the REAL index so staged/new/ignored-but-tracked files are still tracked,
    // then update only the private copy to the actual disk contents inside this workspace.
    let existing = run_git(&dir, &["rev-parse", "--git-path", "index"], None)?;
    let existing = PathBuf::from(String::from_utf8_lossy(&existing).trim());
    let existing = if existing.is_absolute() { existing } else { dir.join(existing) };
    if existing.is_file() {
        std::fs::copy(existing, &index).map_err(|e| e.to_string())?;
    } else {
        run_git(&dir, &["read-tree", "--empty"], Some(&index))?;
    }
    let mut args = vec!["add", "--all", "--"];
    args.extend(PATHS);
    run_git(&dir, &args, Some(&index))?;
    let tree = String::from_utf8(run_git(&dir, &["write-tree"], Some(&index))?).map_err(|e| e.to_string())?;
    Ok(Snapshot { tree: tree.trim().into(), workspace: dir.to_string_lossy().into() })
}

pub fn changes(dir: &Path, before: &str) -> Result<Vec<FileChange>, String> {
    if !matches!(before.len(), 40 | 64) || !before.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Invalid coding snapshot id.".into());
    }
    let after = snapshot(dir)?;
    let common = ["--no-renames", "--no-ext-diff", "--no-textconv", "--relative", before, after.tree.as_str(), "--"];
    let mut names = vec!["diff", "--name-status", "-z"];
    names.extend(common); names.extend(PATHS);
    let mut stats = vec!["diff", "--numstat", "-z"];
    stats.extend(common); stats.extend(PATHS);
    parse_changes(&run_git(dir, &names, None)?, &run_git(dir, &stats, None)?)
}

fn parse_changes(names: &[u8], stats: &[u8]) -> Result<Vec<FileChange>, String> {
    let names = std::str::from_utf8(names).map_err(|_| "Some filenames aren't UTF-8; detailed change counts are unavailable.")?;
    let stats = std::str::from_utf8(stats).map_err(|_| "Some filenames aren't UTF-8; detailed change counts are unavailable.")?;
    let mut counts = std::collections::HashMap::new();
    for record in stats.split('\0').filter(|s| !s.is_empty()) {
        let parts = record.splitn(3, '\t').collect::<Vec<_>>();
        if parts.len() != 3 { return Err("Incomplete Git line-count report.".into()); }
        let binary = parts[0] == "-" && parts[1] == "-";
        let number = |value: &str| -> Result<Option<u64>, String> {
            if binary { Ok(None) } else { value.parse::<u64>().map(Some).map_err(|_| "Invalid Git line count.".into()) }
        };
        counts.insert(parts[2], (number(parts[0])?, number(parts[1])?, binary));
    }
    let fields = names.split('\0').filter(|s| !s.is_empty()).collect::<Vec<_>>();
    if fields.len() % 2 != 0 { return Err("Incomplete Git file-status report.".into()); }
    let mut result = Vec::new();
    for pair in fields.chunks(2) {
        let kind = match pair[0] {
            "A" => "created", "D" => "deleted", "M" | "T" => "modified",
            _ => return Err("Unsupported Git file status in change report.".into()),
        };
        let (added, removed, binary) = counts.remove(pair[1]).ok_or("Missing line counts for a changed file.")?;
        result.push(FileChange { path: pair[1].into(), kind: kind.into(), added, removed, binary });
    }
    if !counts.is_empty() { return Err("Git status and line-count reports disagree.".into()); }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Repo(PathBuf);
    impl Repo {
        fn new() -> Self {
            let private = PrivateIndex::new().unwrap();
            let root = private.0.join("test-repo");
            std::fs::create_dir(&root).unwrap();
            // The parent owns index cleanup, while this child owns ONLY test fixture files.
            let repo = Self(root);
            run_git(&repo.0, &["init", "-q"], None).unwrap();
            repo
        }
        fn write(&self, path: &str, content: &[u8]) {
            let path = self.0.join(path);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, content).unwrap();
        }
    }
    impl Drop for Repo {
        fn drop(&mut self) {
            // Exact test-owned child; never remove an arbitrary path or workspace root.
            if self.0.file_name().and_then(|s| s.to_str()) == Some("test-repo") &&
                self.0.parent().and_then(|p| p.file_name()).and_then(|s| s.to_str()).map(|s| s.starts_with("vr-coding-index-")).unwrap_or(false) {
                let parent = self.0.parent().unwrap();
                let _ = std::fs::remove_dir_all(&self.0);
                let _ = std::fs::remove_dir(parent);
            }
        }
    }

    #[test]
    fn parses_binary_and_unusual_paths_without_quoting_or_truncation() {
        let result = parse_changes(b"A\0new file.txt\0M\0tab\tname\n.txt\0D\0image.png\0", b"3\t0\tnew file.txt\0\
            1\t2\ttab\tname\n.txt\0-\t-\timage.png\0").unwrap();
        assert_eq!(result[0].kind, "created");
        assert_eq!(result[1].path, "tab\tname\n.txt");
        assert_eq!(result[2].added, None);
        assert!(result[2].binary);
        assert!(parse_changes(b"M\0one\0", b"").is_err());
    }

    #[test]
    fn compares_actual_dirty_and_untracked_files_without_touching_the_real_index() {
        let repo = Repo::new();
        repo.write("existing.txt", b"first\nsecond\n");
        repo.write("untouched.txt", b"keep\n");
        run_git(&repo.0, &["add", "."], None).unwrap();
        let original_index = std::fs::read(repo.0.join(".git/index")).unwrap();
        repo.write("existing.txt", b"already dirty\nsecond\n");
        repo.write("untracked.txt", b"before\n");
        repo.write("deleted.txt", b"delete me\n");
        let before = snapshot(&repo.0).unwrap();
        repo.write("existing.txt", b"already dirty\nchanged\nextra\n");
        repo.write("untracked.txt", b"after\n");
        repo.write("created.txt", b"new\nfile\n");
        std::fs::remove_file(repo.0.join("deleted.txt")).unwrap();
        repo.write(".vr-codex/cache.json", b"not user work\n");
        repo.write(".vr-coding-task.md", b"not user work\n");
        let result = changes(&repo.0, &before.tree).unwrap();
        assert_eq!(result.len(), 4);
        let existing = result.iter().find(|r| r.path == "existing.txt").unwrap();
        assert_eq!((existing.added, existing.removed), (Some(2), Some(1)));
        assert_eq!(result.iter().find(|r| r.path == "created.txt").unwrap().kind, "created");
        assert_eq!(result.iter().find(|r| r.path == "untracked.txt").unwrap().kind, "modified");
        assert_eq!(result.iter().find(|r| r.path == "deleted.txt").unwrap().kind, "deleted");
        assert_eq!(std::fs::read(repo.0.join(".git/index")).unwrap(), original_index);
    }

    #[test]
    fn subdirectory_scope_and_binary_counts_are_correct() {
        let repo = Repo::new();
        repo.write("project/caf\u{e9} file.txt", b"before\n");
        repo.write("project/image.png", &[0, 1, 2]);
        repo.write("outside.txt", b"before\n");
        let dir = repo.0.join("project");
        let before = snapshot(&dir).unwrap();
        repo.write("project/caf\u{e9} file.txt", b"after\n");
        repo.write("project/image.png", &[0, 3, 4]);
        repo.write("outside.txt", b"outside scope\n");
        let result = changes(&dir, &before.tree).unwrap();
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].path, "caf\u{e9} file.txt");
        assert_eq!((result[0].added, result[0].removed), (Some(1), Some(1)));
        assert!(result[1].binary);
        assert!(changes(&dir, "HEAD; malicious").is_err());
    }

    #[test]
    fn preserves_tracking_for_ignored_tracked_files_and_labels_renames_explicitly() {
        let repo = Repo::new();
        repo.write(".gitignore", b"*.ignored\n");
        repo.write("tracked.ignored", b"before\n");
        repo.write("untracked.ignored", b"ignored\n");
        repo.write("original.txt", b"same content\n");
        run_git(&repo.0, &["add", "-f", "tracked.ignored"], None).unwrap();
        let before = snapshot(&repo.0).unwrap();
        repo.write("tracked.ignored", b"after\n");
        repo.write("untracked.ignored", b"still ignored\n");
        std::fs::rename(repo.0.join("original.txt"), repo.0.join("renamed.txt")).unwrap();
        repo.write("nested/.vr-codex/cache.json", b"excluded\n");
        let result = changes(&repo.0, &before.tree).unwrap();
        assert_eq!(result.len(), 3);
        assert_eq!(result.iter().find(|r| r.path == "original.txt").unwrap().kind, "deleted");
        assert_eq!(result.iter().find(|r| r.path == "renamed.txt").unwrap().kind, "created");
        assert_eq!(result.iter().find(|r| r.path == "tracked.ignored").unwrap().kind, "modified");
    }
}
