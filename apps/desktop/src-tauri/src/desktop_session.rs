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

#[cfg(test)]
mod tests {
    use super::*;
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
}
