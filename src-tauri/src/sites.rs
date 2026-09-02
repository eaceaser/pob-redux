//! Build-sharing sites, mirroring `buildSites.websiteList` in PoB's
//! Modules/BuildSiteTools.lua. Each download endpoint returns the raw PoB
//! build code (base64+deflate), which the bridge's `load_build_code` decodes.

pub const SUPPORTED: &str = "Maxroll, pobb.in, poe.ninja, poe2db.tw, Pastebin.com, PastebinP.com, Rentry.co";

/// Map a share URL to (site label, raw-code download URL).
pub fn download_url(url: &str) -> Option<(&'static str, String)> {
    let rest = url.trim();
    let rest = rest.strip_prefix("https://").or_else(|| rest.strip_prefix("http://"))?;
    let rest = rest.strip_prefix("www.").unwrap_or(rest);
    let (host, path) = rest.split_once('/')?;
    let path = path.trim_end_matches('/');
    if path.is_empty() {
        return None;
    }
    let first_seg = path.split('/').next().unwrap_or_default();
    match host {
        "maxroll.gg" => {
            let id = path.strip_prefix("poe2/pob/").filter(|s| !s.is_empty())?;
            Some(("Maxroll", format!("https://maxroll.gg/poe2/api/pob/{id}")))
        }
        "pobb.in" => Some(("pobb.in", format!("https://pobb.in/pob/{path}"))),
        "poe.ninja" | "poe2.ninja" => {
            let p = path.strip_prefix("poe2/").unwrap_or(path);
            let id = p.strip_prefix("pob/").filter(|s| !s.is_empty())?;
            Some(("poe.ninja", format!("https://poe.ninja/poe2/pob/raw/{id}")))
        }
        "poe2db.tw" => {
            let id = path.strip_prefix("pob/").filter(|s| !s.is_empty())?;
            Some(("poe2db.tw", format!("https://poe2db.tw/pob/{id}/raw")))
        }
        "pastebin.com" => Some(("Pastebin.com", format!("https://pastebin.com/raw/{first_seg}"))),
        "pastebinp.com" => Some(("PastebinP.com", format!("https://pastebinp.com/raw/{first_seg}"))),
        "rentry.co" => Some(("Rentry.co", format!("https://rentry.co/paste/{first_seg}/raw"))),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::download_url;

    #[test]
    fn maps_urls() {
        assert_eq!(
            download_url("https://pobb.in/abc123").unwrap().1,
            "https://pobb.in/pob/abc123"
        );
        assert_eq!(
            download_url("https://maxroll.gg/poe2/pob/xyz").unwrap().1,
            "https://maxroll.gg/poe2/api/pob/xyz"
        );
        assert_eq!(
            download_url("https://poe.ninja/poe2/pob/abc").unwrap().1,
            "https://poe.ninja/poe2/pob/raw/abc"
        );
        assert_eq!(
            download_url("https://poe2.ninja/pob/abc").unwrap().1,
            "https://poe.ninja/poe2/pob/raw/abc"
        );
        assert_eq!(
            download_url("https://pastebin.com/AbC123").unwrap().1,
            "https://pastebin.com/raw/AbC123"
        );
        assert_eq!(
            download_url("https://rentry.co/mypaste").unwrap().1,
            "https://rentry.co/paste/mypaste/raw"
        );
        assert!(download_url("https://example.com/whatever").is_none());
        assert!(download_url("https://maxroll.gg/d4/build/x").is_none());
    }
}
