//! Maxroll build guides and planners. A guide embeds one or more planners
//! (`maxroll.gg/<game>/planner/<id>`), and each planner profile lists the PoB
//! links its author attached (`pobLinks`); the guide's "Open in PoB" button
//! points at those. Guide text can link more PoB codes. PoE2 planners carry
//! no PoB links today, so in practice this serves PoE1 guides.

use serde::Serialize;
use serde_json::Value;

use crate::sites;

const UA: &str = "pob-redux/0.1 Path of Building";
const MAX_PLANNERS: usize = 8;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PobLink {
    pub name: String,
    /// The planner the link came from, or the guide text.
    pub source: String,
    pub url: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Resolved {
    pub title: String,
    pub url: String,
    pub links: Vec<PobLink>,
}

#[derive(PartialEq, Debug)]
pub enum Page {
    Guide { game: &'static str, slug: String },
    Planner { game: &'static str, id: String },
}

/// A Maxroll build guide (`/<game>/build-guides/<slug>`) or planner (`/<game>/planner/<id>`).
pub fn page(url: &str) -> Option<Page> {
    let rest = url.trim();
    let rest = rest.strip_prefix("https://").or_else(|| rest.strip_prefix("http://"))?;
    let rest = rest.strip_prefix("www.").unwrap_or(rest);
    let path = rest.strip_prefix("maxroll.gg/")?;
    let path = path.split(['?', '#']).next().unwrap_or_default();
    let mut segs = path.split('/').filter(|s| !s.is_empty());
    let game = match segs.next()? {
        "poe" => "poe",
        "poe2" => "poe2",
        _ => return None,
    };
    let kind = segs.next()?;
    let name = segs.next()?.to_string();
    match kind {
        "build-guides" => Some(Page::Guide { game, slug: name }),
        "planner" => Some(Page::Planner { game, id: name }),
        _ => None,
    }
}

/// The id after each occurrence of `marker`, in page order, without repeats.
fn ids_after(text: &str, marker: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for (i, _) in text.match_indices(marker) {
        let id: String = text[i + marker.len()..].chars().take_while(char::is_ascii_alphanumeric).collect();
        if !id.is_empty() && !out.contains(&id) {
            out.push(id);
        }
    }
    out
}

fn title_of(html: &str) -> Option<String> {
    let start = html.find("<title>")? + "<title>".len();
    let raw = &html[start..start + html[start..].find("</title>")?];
    let raw = raw.replace("&amp;", "&").replace("&#x27;", "'").replace("&#39;", "'").replace("&quot;", "\"");
    let title = match raw.rsplit_once(" - ") {
        Some((head, _)) if !head.trim().is_empty() => head.trim().to_string(),
        _ => raw.trim().to_string(),
    };
    (!title.is_empty()).then_some(title)
}

async fn get_text(client: &reqwest::Client, url: &str) -> Result<String, String> {
    let resp = client.get(url).send().await.map_err(|e| format!("Maxroll: {e}"))?;
    let status = resp.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        return Err(format!("Maxroll has nothing at {url}"));
    }
    if !status.is_success() {
        return Err(format!("Maxroll returned HTTP {status}"));
    }
    resp.text().await.map_err(|e| format!("Maxroll: {e}"))
}

/// A planner's name and its `pobLinks` as (name, link) pairs.
async fn planner(client: &reqwest::Client, game: &str, id: &str) -> Result<(String, Vec<(String, String)>), String> {
    let text = get_text(client, &format!("https://planners.maxroll.gg/profiles/{game}/{id}")).await?;
    let profile: Value = serde_json::from_str(&text).map_err(|_| "Maxroll returned something other than JSON".to_string())?;
    let name = profile["name"].as_str().unwrap_or_default().trim().to_string();
    let data: Value = profile["data"].as_str().and_then(|s| serde_json::from_str(s).ok()).unwrap_or(Value::Null);
    let links = data["pobLinks"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|l| {
                    let link = l["link"].as_str()?.trim();
                    (!link.is_empty()).then(|| (l["name"].as_str().unwrap_or_default().trim().to_string(), link.to_string()))
                })
                .collect()
        })
        .unwrap_or_default();
    Ok((name, links))
}

fn add(links: &mut Vec<PobLink>, game: &str, name: &str, source: String, link: &str) {
    let url = if link.starts_with("http://") || link.starts_with("https://") {
        if sites::download_url(link).is_none() {
            return;
        }
        link.to_string()
    } else if link.chars().all(|c| c.is_ascii_alphanumeric()) {
        format!("https://maxroll.gg/{game}/pob/{link}")
    } else {
        return;
    };
    if links.iter().any(|l| l.url == url) {
        return;
    }
    let name = if name.is_empty() { "Path of Building" } else { name };
    links.push(PobLink { name: name.to_string(), source, url });
}

/// Every PoB link a guide or planner offers, the planners' own links first.
pub async fn resolve(url: &str) -> Result<Resolved, String> {
    let page = page(url).ok_or_else(|| "Not a Maxroll build guide or planner link".to_string())?;
    let client = reqwest::Client::builder()
        .user_agent(UA)
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let mut links = Vec::new();
    let (title, page_url) = match page {
        Page::Planner { game, id } => {
            let (name, found) = planner(&client, game, &id).await?;
            let source = if name.is_empty() { format!("Planner {id}") } else { name.clone() };
            for (n, l) in &found {
                add(&mut links, game, n, source.clone(), l);
            }
            (if name.is_empty() { "Maxroll planner".to_string() } else { name }, format!("https://maxroll.gg/{game}/planner/{id}"))
        }
        Page::Guide { game, slug } => {
            let page_url = format!("https://maxroll.gg/{game}/build-guides/{slug}");
            let html = get_text(&client, &page_url).await?.replace("\\/", "/").replace("\\u002F", "/");
            for id in ids_after(&html, &format!("maxroll.gg/{game}/planner/")).into_iter().take(MAX_PLANNERS) {
                match planner(&client, game, &id).await {
                    Ok((name, found)) => {
                        let source = if name.is_empty() { format!("Planner {id}") } else { name };
                        for (n, l) in &found {
                            add(&mut links, game, n, source.clone(), l);
                        }
                    }
                    Err(e) => log::warn!("maxroll: planner {id} of {slug}: {e}"),
                }
            }
            for id in ids_after(&html, &format!("/{game}/pob/")) {
                add(&mut links, game, "", "Linked in the guide".to_string(), &id);
            }
            (title_of(&html).unwrap_or(slug), page_url)
        }
    };
    if links.is_empty() {
        return Err(format!("The Maxroll page {page_url} has no Path of Building link"));
    }
    Ok(Resolved { title, url: page_url, links })
}

#[cfg(test)]
mod tests {
    use super::{ids_after, page, title_of, Page};

    #[test]
    fn pages() {
        assert_eq!(
            page("https://maxroll.gg/poe/build-guides/winter-orb-elementalist-league-starter"),
            Some(Page::Guide { game: "poe", slug: "winter-orb-elementalist-league-starter".into() })
        );
        assert_eq!(page("https://www.maxroll.gg/poe2/build-guides/x/?ref=1#top"), Some(Page::Guide { game: "poe2", slug: "x".into() }));
        assert_eq!(page("https://maxroll.gg/poe/planner/a89ts0q6#planner&pob"), Some(Page::Planner { game: "poe", id: "a89ts0q6".into() }));
        assert_eq!(page("https://maxroll.gg/poe/build-guides"), None);
        assert_eq!(page("https://maxroll.gg/poe/pob/g312000h"), None);
        assert_eq!(page("https://maxroll.gg/d4/build-guides/x"), None);
        assert_eq!(page("https://mobalytics.gg/poe/builds/x"), None);
    }

    #[test]
    fn scans() {
        let html = r#"<title>Carrion Golems &amp; Zombies Necromancer League Starter 3.29 - POE Maxroll.gg</title>
            "url":"/poe/pob","url":"https://maxroll.gg/poe/planner/zh4pl0l0#planner&pob"
            <a href="https://maxroll.gg/poe/pob/dtjsf0o0">here</a> <a href="/poe/pob/dtjsf0o0">
            https://backend.maxroll.gg/poe/planner/cg9xs0qe#1&ascendancy maxroll.gg/poe/planner/zh4pl0l0"#;
        assert_eq!(ids_after(html, "maxroll.gg/poe/planner/"), ["zh4pl0l0", "cg9xs0qe"]);
        assert_eq!(ids_after(html, "/poe/pob/"), ["dtjsf0o0"]);
        assert_eq!(title_of(html).as_deref(), Some("Carrion Golems & Zombies Necromancer League Starter 3.29"));
    }
}
