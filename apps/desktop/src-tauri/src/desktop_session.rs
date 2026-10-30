//! Per-user lifecycle metadata, independent of the renderer's Local Storage.
//! Contains a pairing credential: never serve it over HTTP, log it, or include it in public exports.
use serde::{Deserialize, Serialize};
use std::{path::Path, sync::Mutex};

static WRITE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Default, Serialize, Deserialize)]
pub struct Session {
    pub profile_id: Option<String>,
    pub phone: Option<Phone>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Phone {
    pub enabled: bool,
    pub token: String,
    pub port: u16,
}
pub fn read(path: &Path) -> Result<Session, String> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| "Desktop session metadata is invalid; restore its backup instead of resetting the profile.".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Session::default()),
        Err(_) => Err("Could not read desktop session metadata.".into()),
    }
}
pub fn update(path: &Path, edit: impl FnOnce(&mut Session) -> Result<(), String>) -> Result<(), String> {
    let _guard = WRITE_LOCK.lock().map_err(|_| "Session metadata lock failed")?;
    let mut session = read(path)?;
    edit(&mut session)?;
    std::fs::create_dir_all(path.parent().ok_or("Missing session folder")?).map_err(|_| "Could not create session folder")?;
    let temp = path.with_extension("pending");
    std::fs::write(&temp, serde_json::to_vec(&session).map_err(|_| "Could not encode session metadata")?)
        .map_err(|_| "Could not save session metadata")?;
    std::fs::rename(temp, path).map_err(|_| "Could not replace session metadata".into())
}
pub fn check_profile(session: &mut Session, profile: &str) -> Result<(), String> {
    if profile.len() < 16 || profile.len() > 80 { return Err("Invalid desktop profile identifier".into()); }
    if session.profile_id.as_deref().is_some_and(|expected| expected != profile) {
        return Err("This window opened a different saved-data profile. Startup was stopped before loading or overwriting chats, settings, or the phone link. Close it and open your usual desktop shortcut; do not reset app data. See docs/desktop-data-recovery.md.".into());
    }
    session.profile_id = Some(profile.into());
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryReceipt {
    pub profile_id: String,
    pub backup_path: String,
}

/// Explicit two-step recovery: save the inspected data and private lifecycle metadata before the
/// renderer can reattach a browser marker. Never adopt a new native identity or rotate its token.
pub fn save_recovery(session_path: &Path, exports: &Path, backup_json: &str) -> Result<RecoveryReceipt, String> {
    use std::io::Write;
    let _guard = WRITE_LOCK.lock().map_err(|_| "Session metadata lock failed")?;
    let session = read(session_path)?;
    let profile_id = session.profile_id.filter(|id| (16..=80).contains(&id.len()))
        .ok_or("No existing desktop identity to recover; restore the correct native metadata backup")?;
    let data: serde_json::Value = serde_json::from_str(backup_json).map_err(|_| "Invalid recovery export")?;
    if data["app"] != "visual-reader" || !data["version"].is_number() {
        return Err("Not a Visual Reader recovery export".into());
    }
    let names = ["chats", "books", "bibles", "memos", "chatblobs"];
    if names.iter().any(|name| !data["stores"][name].is_array()) {
        return Err("Recovery export is missing saved-data stores".into());
    }
    let has_messages = data["stores"]["chats"].as_array().unwrap().iter()
        .any(|row| row["value"].as_array().is_some_and(|messages| !messages.is_empty()));
    if !has_messages && ["books", "bibles"].iter().all(|name| data["stores"][name].as_array().unwrap().is_empty()) {
        return Err("Empty profile cannot replace your saved-data profile; restore the correct backup".into());
    }
    std::fs::create_dir_all(exports).map_err(|_| "Could not create recovery export folder")?;
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "System clock is invalid")?.as_nanos();
    let dir = exports.join(format!("profile-recovery-{stamp}-{}", std::process::id()));
    std::fs::create_dir(&dir).map_err(|_| "Could not create a unique recovery snapshot")?;
    for (name, bytes) in [
        ("backup.json", backup_json.as_bytes().to_vec()),
        ("desktop-session.json", std::fs::read(session_path).map_err(|_| "Could not snapshot desktop identity")?),
    ] {
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(dir.join(name))
            .map_err(|_| "Could not create private recovery backup")?;
        file.write_all(&bytes).and_then(|_| file.sync_all()).map_err(|_| "Could not finish recovery backup")?;
    }
    Ok(RecoveryReceipt { profile_id, backup_path: dir.join("backup.json").to_string_lossy().into_owned() })
}

pub fn wait_for_successor(mut child: std::process::Child, ready_path: &Path, timeout: std::time::Duration) -> Result<std::process::Child, String> {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Err(format!("exited with {status}")),
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("could not verify the successor process".into());
            }
            Ok(None) => {}
        }
        if std::fs::read_to_string(ready_path).ok().as_deref() == Some(&child.id().to_string()) {
            let _ = std::fs::remove_file(ready_path);
            return Ok(child);
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            let _ = std::fs::remove_file(ready_path);
            return Err("did not confirm saved-profile and phone-link readiness before the startup deadline".into());
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn recovery_fixture(label: &str) -> (std::path::PathBuf, std::path::PathBuf) {
        let root = std::env::temp_dir().join(format!("vr-recovery-{}-{label}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("session.json");
        update(&path, |s| {
            s.profile_id = Some("native-existing-profile".into());
            s.phone = Some(Phone { enabled: true, token: "fixture-credential".into(), port: 8787 });
            Ok(())
        }).unwrap();
        (path, root.join("exports"))
    }
    fn recovery_data() -> String {
        serde_json::json!({"app":"visual-reader","version":5,"stores":{
            "chats":[{"key":"chat","value":[{"role":"assistant","text":"kept","at":1}]}],
            "books":[],"bibles":[],"memos":[],"chatblobs":[]
        }}).to_string()
    }
    #[test]
    fn recovery_snapshots_data_and_metadata_without_replacing_identity_or_pairing() {
        let (path, exports) = recovery_fixture("preserve");
        let original = std::fs::read(&path).unwrap();
        let data = recovery_data();
        let first = save_recovery(&path, &exports, &data).unwrap();
        let second = save_recovery(&path, &exports, &data).unwrap();
        assert_ne!(first.backup_path, second.backup_path);
        assert_eq!(first.profile_id, "native-existing-profile");
        assert_eq!(std::fs::read(&path).unwrap(), original);
        assert_eq!(std::fs::read_to_string(&first.backup_path).unwrap(), data);
        assert_eq!(std::fs::read(Path::new(&first.backup_path).with_file_name("desktop-session.json")).unwrap(), original);
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
    #[test]
    fn recovery_rejects_empty_malformed_and_incomplete_exports() {
        let (path, exports) = recovery_fixture("invalid");
        for data in ["{}", "not json", r#"{"app":"visual-reader","version":5,"stores":{"chats":[],"books":[],"bibles":[],"memos":[],"chatblobs":[]}}"#,
            r#"{"app":"visual-reader","version":5,"stores":{"chats":[{"key":"empty","value":[]}],"books":[],"bibles":[],"memos":[],"chatblobs":[]}}"#] {
            assert!(save_recovery(&path, &exports, data).is_err());
            assert!(!exports.exists());
        }
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
    #[test]
    fn recovery_returns_no_identity_if_the_backup_cannot_be_saved() {
        let (path, exports) = recovery_fixture("write-failed");
        std::fs::write(&exports, "not a directory").unwrap();
        assert!(save_recovery(&path, &exports, &recovery_data()).is_err());
        assert_eq!(read(&path).unwrap().profile_id.as_deref(), Some("native-existing-profile"));
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
    #[test]
    fn recovery_cannot_establish_an_unverified_new_native_identity() {
        let (path, exports) = recovery_fixture("no-baseline");
        update(&path, |s| { s.profile_id = None; Ok(()) }).unwrap();
        assert!(save_recovery(&path, &exports, &recovery_data()).is_err());
        assert!(!exports.exists());
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
    #[test]
    fn mismatched_profile_cannot_replace_the_expected_identity() {
        let mut session = Session::default();
        check_profile(&mut session, "original-profile-123").unwrap();
        assert!(check_profile(&mut session, "different-profile-456").is_err());
        assert_eq!(session.profile_id.as_deref(), Some("original-profile-123"));
    }
    #[test]
    fn stopped_link_and_token_survive_profile_updates() {
        let path = std::env::temp_dir().join(format!("vr-session-test-{}", std::process::id())).join("session.json");
        update(&path, |s| { s.phone = Some(Phone {enabled: false, token: "test-pairing".into(), port: 8787}); Ok(()) }).unwrap();
        update(&path, |s| check_profile(s, "original-profile-123")).unwrap();
        let session = read(&path).unwrap();
        assert!(!session.phone.as_ref().unwrap().enabled);
        assert_eq!(session.phone.unwrap().token, "test-pairing");
        assert!(update(&path, |s| check_profile(s, "different-profile-456")).is_err());
        assert_eq!(read(&path).unwrap().profile_id.unwrap(), "original-profile-123");
        std::fs::remove_file(&path).unwrap();
        std::fs::remove_dir(path.parent().unwrap()).unwrap();
    }

    #[test]
    #[ignore = "subprocess fixture, invoked only by the lifecycle tests"]
    fn successor_fixture() {
        let Ok(path) = std::env::var("VR_TEST_READY_FILE") else { return; };
        let mode = std::env::var("VR_TEST_READY_MODE").unwrap();
        if mode == "exit" { return; }
        let value = if mode == "ready" { std::process::id().to_string() } else { "wrong-pid".into() };
        std::fs::write(path, value).unwrap();
        std::thread::sleep(std::time::Duration::from_secs(10));
    }

    #[test]
    fn successor_requires_its_own_ack_and_unverified_children_are_stopped() {
        for mode in ["ready", "wrong", "exit"] {
            let path = std::env::temp_dir().join(format!("vr-successor-test-{}-{mode}.ready", std::process::id()));
            let child = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--ignored", "--exact", "desktop_session::tests::successor_fixture"])
                .env("VR_TEST_READY_FILE", &path).env("VR_TEST_READY_MODE", mode)
                .stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn().unwrap();
            let result = wait_for_successor(child, &path, std::time::Duration::from_secs(2));
            if mode == "ready" {
                let mut child = result.unwrap();
                assert!(!path.exists());
                child.kill().unwrap(); child.wait().unwrap();
            } else { assert!(result.is_err()); }
            let _ = std::fs::remove_file(path);
        }
    }
}
