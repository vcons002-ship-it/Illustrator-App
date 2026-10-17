//! Original uploads are byte-preserving, confined to uploads/, and never overwrite user files.
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
};

pub(crate) const MAX_UPLOAD_BYTES: usize = 100 * 1024 * 1024;
const MAX_EXTRACTED_BYTES: usize = 20 * 1024 * 1024;

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UploadSaved {
    pub path: String,
    pub absolute_path: String,
    pub bytes: usize,
    pub renamed: bool,
    pub extracted_path: Option<String>,
    pub extracted_error: Option<String>,
}

fn safe_name(name: &str) -> Result<String, String> {
    if name.is_empty() || name.contains(['/', '\\']) || name == "." || name == ".." {
        return Err("An upload needs a filename, not a path.".into());
    }
    let value: String = name
        .chars()
        .map(|c| {
            if c.is_control() || ":*?\"<>|".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let mut value = value.trim().trim_end_matches(['.', ' ']).to_string();
    if value.is_empty() {
        return Err("Invalid upload filename.".into());
    }
    if value.chars().count() > 180 {
        return Err("Upload filename is too long (maximum 180 characters).".into());
    }
    let stem = value.split('.').next().unwrap_or("").to_ascii_uppercase();
    if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'))
    {
        value.insert(0, '_');
    }
    Ok(value)
}

fn create_unique(dir: &Path, name: &str, bytes: &[u8]) -> Result<String, String> {
    let (stem, extension) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s, format!(".{e}")),
        _ => (name, String::new()),
    };
    for number in 1..=1000 {
        let candidate = if number == 1 {
            name.to_string()
        } else {
            format!("{stem} ({number}){extension}")
        };
        let path = dir.join(&candidate);
        // create_new is atomic: existing files, dangling links and concurrent uploads cannot be replaced.
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                if let Err(error) = file.write_all(bytes).and_then(|_| file.sync_all()) {
                    drop(file);
                    let _ = fs::remove_file(&path); // only the failed file this invocation just created
                    return Err(format!("Upload write failed: {error}"));
                }
                return Ok(candidate);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("Upload could not be saved: {error}")),
        }
    }
    Err("Too many uploads have this filename; rename the file and retry.".into())
}

pub(crate) fn save(
    base: &Path,
    name: &str,
    bytes: &[u8],
    extracted: Option<&str>,
) -> Result<UploadSaved, String> {
    if bytes.len() > MAX_UPLOAD_BYTES {
        return Err("Original file exceeds the 100 MiB upload limit.".into());
    }
    let name_safe = safe_name(name)?;
    let base = base
        .canonicalize()
        .map_err(|_| "The selected upload workspace is unavailable.")?;
    let uploads = base.join("uploads");
    fs::create_dir_all(&uploads).map_err(|e| format!("Could not create uploads folder: {e}"))?;
    let uploads = uploads
        .canonicalize()
        .map_err(|_| "The uploads folder is unavailable.")?;
    if !uploads.starts_with(&base) {
        return Err("The uploads folder resolves outside the selected workspace.".into());
    }
    let saved_name = create_unique(&uploads, &name_safe, bytes)?;
    let mut result = UploadSaved {
        path: format!("uploads/{saved_name}"),
        absolute_path: uploads.join(&saved_name).to_string_lossy().to_string(),
        bytes: bytes.len(),
        renamed: saved_name != name,
        extracted_path: None,
        extracted_error: None,
    };
    if let Some(text) = extracted.filter(|s| !s.is_empty()) {
        if text.len() > MAX_EXTRACTED_BYTES {
            result.extracted_error = Some(
                "Extracted text exceeds 20 MiB; the complete original was still saved.".into(),
            );
        } else {
            match create_unique(
                &uploads,
                &format!("{saved_name}.extracted.txt"),
                text.as_bytes(),
            ) {
                Ok(path) => result.extracted_path = Some(format!("uploads/{path}")),
                Err(error) => result.extracted_error = Some(error),
            }
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(label: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("vr-upload-{label}-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }
    #[test]
    fn originals_and_sidecars_are_distinct_and_byte_exact() {
        let dir = fixture("bytes");
        let raw = b"%PDF-1.7\r\n\0\xff\x80binary";
        let saved = save(&dir, "report.pdf", raw, Some("Readable extracted text")).unwrap();
        assert_eq!(fs::read(dir.join(&saved.path)).unwrap(), raw);
        assert_eq!(saved.bytes, raw.len());
        assert_eq!(
            saved.extracted_path.as_deref(),
            Some("uploads/report.pdf.extracted.txt")
        );
        assert_eq!(
            fs::read_to_string(dir.join(saved.extracted_path.as_ref().unwrap())).unwrap(),
            "Readable extracted text"
        );
        let image = b"\x89PNG\r\n\x1a\n\0\xff\x81";
        let photo = save(&dir, "photo.png", image, None).unwrap();
        assert_eq!(fs::read(dir.join(&photo.path)).unwrap(), image);
        assert!(photo.extracted_path.is_none());
        let code = b"\xef\xbb\xbffunction f() {\r\n  return 1;  \r\n}\r\n";
        let source = save(&dir, "source.js", code, None).unwrap();
        assert_eq!(fs::read(dir.join(&source.path)).unwrap(), code);
        let empty = save(&dir, "empty.dat", &[], None).unwrap();
        assert_eq!(fs::read(dir.join(&empty.path)).unwrap(), Vec::<u8>::new());
        for path in [
            saved.path,
            saved.extracted_path.unwrap(),
            photo.path,
            source.path,
            empty.path,
        ] {
            fs::remove_file(dir.join(path)).unwrap();
        }
        fs::remove_dir(dir.join("uploads")).unwrap();
        fs::remove_dir(dir).unwrap();
    }
    #[test]
    fn collisions_do_not_overwrite_originals_or_other_project_files() {
        let dir = fixture("collision");
        fs::write(dir.join("README.md"), "project guide").unwrap();
        let first = save(&dir, "README.md", b"first", None).unwrap();
        let second = save(&dir, "README.md", b"second", None).unwrap();
        assert_eq!(first.path, "uploads/README.md");
        assert_eq!(second.path, "uploads/README (2).md");
        assert!(second.renamed);
        assert_eq!(fs::read(dir.join(first.path)).unwrap(), b"first");
        assert_eq!(
            fs::read_to_string(dir.join("README.md")).unwrap(),
            "project guide"
        );
        assert!(safe_name("../private").is_err());
        assert!(safe_name("C:\\private.txt").is_err());
        assert_eq!(safe_name("CON.txt").unwrap(), "_CON.txt");
        assert_eq!(safe_name("my:photo.png").unwrap(), "my_photo.png");
        for name in ["uploads/README.md", "uploads/README (2).md", "README.md"] {
            fs::remove_file(dir.join(name)).unwrap();
        }
        fs::remove_dir(dir.join("uploads")).unwrap();
        fs::remove_dir(dir).unwrap();
    }
    #[test]
    fn concurrent_writers_keep_every_upload() {
        let dir = fixture("concurrent");
        let jobs: Vec<_> = (0u8..8)
            .map(|value| {
                let dir = dir.clone();
                std::thread::spawn(move || save(&dir, "same.bin", &[value], None).unwrap())
            })
            .collect();
        let saved: Vec<_> = jobs.into_iter().map(|j| j.join().unwrap()).collect();
        let mut values: Vec<_> = saved
            .iter()
            .map(|s| fs::read(dir.join(&s.path)).unwrap()[0])
            .collect();
        values.sort();
        assert_eq!(values, (0u8..8).collect::<Vec<_>>());
        for s in saved {
            fs::remove_file(dir.join(s.path)).unwrap();
        }
        fs::remove_dir(dir.join("uploads")).unwrap();
        fs::remove_dir(dir).unwrap();
    }
    #[test]
    fn an_uploads_link_cannot_escape_the_workspace() {
        let dir = fixture("link");
        let outside = fixture("outside");
        #[cfg(windows)]
        {
            let result = std::process::Command::new("cmd.exe")
                .args(["/d", "/c", "mklink", "/J"])
                .arg(dir.join("uploads"))
                .arg(&outside)
                .output()
                .unwrap();
            assert!(result.status.success());
        }
        #[cfg(not(windows))]
        std::os::unix::fs::symlink(&outside, dir.join("uploads")).unwrap();
        assert!(save(&dir, "private.bin", b"content", None)
            .unwrap_err()
            .contains("outside"));
        assert!(!outside.join("private.bin").exists());
        #[cfg(windows)]
        fs::remove_dir(dir.join("uploads")).unwrap();
        #[cfg(not(windows))]
        fs::remove_file(dir.join("uploads")).unwrap();
        fs::remove_dir(dir).unwrap();
        fs::remove_dir(outside).unwrap();
    }
    #[test]
    fn caps_originals_and_reports_a_failed_sidecar_without_losing_the_original() {
        let dir = fixture("limits");
        assert!(save(&dir, "too-large.bin", &vec![0; MAX_UPLOAD_BYTES + 1], None).is_err());
        assert!(!dir.join("uploads").exists());
        assert!(save(&dir, &"x".repeat(181), b"body", None).is_err());
        let saved = save(
            &dir,
            "résumé 合同.pdf",
            b"intact original",
            Some(&"x".repeat(MAX_EXTRACTED_BYTES + 1)),
        )
        .unwrap();
        assert!(saved.extracted_error.unwrap().contains("20 MiB"));
        assert!(saved.extracted_path.is_none());
        assert_eq!(fs::read(dir.join(&saved.path)).unwrap(), b"intact original");
        fs::remove_file(dir.join(saved.path)).unwrap();
        fs::remove_dir(dir.join("uploads")).unwrap();
        fs::remove_dir(dir).unwrap();
    }
}
