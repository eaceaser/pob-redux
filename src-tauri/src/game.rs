//! The game a session works on. Each game has its own vendored Path of
//! Building (`pob` for PoE2, `pob1` for PoE1 under the app's resources), its
//! own builds folder under Documents, and its own engine; switching reboots
//! the engine. The choice persists in the app's config directory.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::Manager;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Game {
    Poe1,
    Poe2,
}

impl Game {
    pub fn id(self) -> &'static str {
        match self {
            Game::Poe1 => "poe1",
            Game::Poe2 => "poe2",
        }
    }

    pub fn from_id(s: &str) -> Option<Game> {
        match s.trim().to_ascii_lowercase().as_str() {
            "poe1" | "1" => Some(Game::Poe1),
            "poe2" | "2" => Some(Game::Poe2),
            _ => None,
        }
    }

    /// Directory name under the app's resources (what pob-sync writes).
    pub fn resource_dir(self) -> &'static str {
        match self {
            Game::Poe1 => "pob1",
            Game::Poe2 => "pob",
        }
    }

    /// The folder PoB itself appends to the user directory (Launch.lua's APP_NAME).
    pub fn user_subdir(self) -> &'static str {
        match self {
            Game::Poe1 => "Path of Building",
            Game::Poe2 => "Path of Building (PoE2)",
        }
    }

    pub fn env_root(self) -> &'static str {
        match self {
            Game::Poe1 => "POB_REDUX_POB1_ROOT",
            Game::Poe2 => "POB_REDUX_POB_ROOT",
        }
    }

    /// Which game a build XML belongs to, by its root element.
    pub fn of_build_xml(head: &str) -> Option<Game> {
        let mut rest = head;
        loop {
            let i = rest.find('<')?;
            rest = &rest[i..];
            if rest.starts_with("<!--") {
                rest = &rest[rest.find("-->")? + 3..];
                continue;
            }
            if rest.starts_with("<?") || rest.starts_with("<!") {
                rest = &rest[rest.find('>')? + 1..];
                continue;
            }
            let name: String = rest[1..].chars().take_while(|c| c.is_ascii_alphanumeric()).collect();
            return match name.as_str() {
                "PathOfBuilding2" => Some(Game::Poe2),
                "PathOfBuilding" => Some(Game::Poe1),
                _ => None,
            };
        }
    }
}

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct Settings {
    pub game: Option<Game>,
}

fn settings_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("settings.json"))
}

pub fn load_settings(app: &tauri::AppHandle) -> Settings {
    settings_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save_settings(app: &tauri::AppHandle, settings: &Settings) -> Result<(), String> {
    let path = settings_path(app).ok_or("no config directory")?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| format!("{}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sniffs_root_element() {
        assert_eq!(Game::of_build_xml("<?xml version=\"1.0\"?>\n<PathOfBuilding2>"), Some(Game::Poe2));
        assert_eq!(Game::of_build_xml("<!-- x -->\n<PathOfBuilding>"), Some(Game::Poe1));
        assert_eq!(Game::of_build_xml("<Build>"), None);
        assert_eq!(Game::of_build_xml("no xml"), None);
    }
}
