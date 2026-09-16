//! Mobalytics build pages. The site's "Download Build File" button asks its
//! GraphQL API for one Build Planner file per variant and zips them in the
//! browser; the API answers unauthenticated requests, so the files are taken
//! straight from it here and the zip never enters the picture. PoE1 pages
//! have no Build Planner files, only the author's PoB code.
//!
//! Cloudflare fronts the API and rejects clients whose TLS handshake does not
//! match the browser their User-Agent claims to be. The app's own honest UA
//! passes; a spoofed browser UA does not.

use crate::game::Game;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const UA: &str = "pob-redux/0.1 Path of Building";

const BY_SLUG: &str = "query PobReduxDocumentBySlug($input: Poe2UserGeneratedDocumentInputBySlug!) { poe2 { documents { userGeneratedDocumentBySlug(input: $input) { error errorMessage data { id data { pobCode buildVariants { values { id } } } } } } } }";
const BY_SLUG_POE1: &str = "query PobReduxDocumentBySlug($input: PoeUserGeneratedDocumentInputBySlug!) { poe { documents { userGeneratedDocumentBySlug(input: $input) { error errorMessage data { id data { pobCode } } } } } }";
const EXPORT: &str = "query Poe2UgDocumentWidgetBuildPlannerExportQuery($input: Poe2UserGeneratedDocumentInputById!, $variantId: String!) { poe2 { documents { userGeneratedDocumentById(input: $input) { error errorMessage data { exportToGame(variantId: $variantId) } } } } }";

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Variant {
    pub id: String,
    /// The `name` inside the file, which the site composes as "<stage> - <guide title>".
    pub name: String,
    /// The Build Planner file as the site produced it, with `link` filled in.
    pub json: String,
    pub passives: usize,
    pub skills: usize,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Resolved {
    pub slug: String,
    pub url: String,
    /// A pobb.in link or a raw build code, when the author attached one.
    pub pob_code: Option<String>,
    pub variants: Vec<Variant>,
}

/// The game and build slug from `https://mobalytics.gg/poe-2/builds/<slug>` or `/poe/builds/<slug>`.
pub fn build_slug(url: &str) -> Option<(Game, String)> {
    let rest = url.trim();
    let rest = rest.strip_prefix("https://").or_else(|| rest.strip_prefix("http://"))?;
    let rest = rest.strip_prefix("www.").unwrap_or(rest);
    let path = rest.strip_prefix("mobalytics.gg/")?;
    let path = path.split(['?', '#']).next().unwrap_or_default();
    let (game, slug) = match path.strip_prefix("poe-2/builds/") {
        Some(s) => (Game::Poe2, s),
        None => (Game::Poe1, path.strip_prefix("poe/builds/")?),
    };
    let slug = slug.trim_matches('/').split('/').next().unwrap_or_default();
    (!slug.is_empty()).then(|| (game, slug.to_string()))
}

fn section(game: Game) -> &'static str {
    match game {
        Game::Poe1 => "poe",
        Game::Poe2 => "poe-2",
    }
}

#[derive(Deserialize)]
struct Envelope {
    data: Option<Value>,
    errors: Option<Vec<Value>>,
}

async fn query(client: &reqwest::Client, game: Game, slug: &str, op: &str, query: &str, variables: Value) -> Result<Value, String> {
    let section = section(game);
    let resp = client
        .post(format!("https://mobalytics.gg/api/{section}/v1/graphql/query"))
        .header("accept", "application/json")
        .header("origin", "https://mobalytics.gg")
        .header("referer", format!("https://mobalytics.gg/{section}/builds/{slug}"))
        .header("content-type", "application/json")
        .body(json!({ "operationName": op, "variables": variables, "query": query }).to_string())
        .send()
        .await
        .map_err(|e| format!("Mobalytics: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| format!("Mobalytics: {e}"))?;
    if !status.is_success() {
        return Err(format!("Mobalytics returned HTTP {status}"));
    }
    let env: Envelope = serde_json::from_str(&text).map_err(|_| "Mobalytics returned something other than JSON".to_string())?;
    if let Some(errs) = env.errors.filter(|e| !e.is_empty()) {
        let msg = errs[0].get("message").and_then(Value::as_str).unwrap_or("unknown error");
        return Err(format!("Mobalytics: {msg}"));
    }
    env.data.ok_or_else(|| "Mobalytics returned no data".to_string())
}

fn doc_error(node: &Value) -> Option<String> {
    let err = node.get("error").and_then(Value::as_str)?;
    let msg = node.get("errorMessage").and_then(Value::as_str).unwrap_or("");
    Some(if msg.is_empty() { err.to_string() } else { format!("{err}: {msg}") })
}

/// Resolve a build page to its PoB code and one Build Planner file per variant.
pub async fn resolve(url: &str) -> Result<Resolved, String> {
    let (game, slug) = build_slug(url).ok_or_else(|| "Not a Mobalytics build link (expected mobalytics.gg/poe-2/builds/<name> or mobalytics.gg/poe/builds/<name>)".to_string())?;
    let page = format!("https://mobalytics.gg/{}/builds/{slug}", section(game));
    let client = reqwest::Client::builder()
        .user_agent(UA)
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;

    let (by_slug, root) = match game {
        Game::Poe1 => (BY_SLUG_POE1, "poe"),
        Game::Poe2 => (BY_SLUG, "poe2"),
    };
    let data = query(&client, game, &slug, "PobReduxDocumentBySlug", by_slug, json!({ "input": { "slug": slug, "type": "builds" } })).await?;
    let doc = &data[root]["documents"]["userGeneratedDocumentBySlug"];
    if let Some(e) = doc_error(doc) {
        return Err(if e.starts_with("NOT_FOUND") { format!("Mobalytics has no build at {page}") } else { format!("Mobalytics: {e}") });
    }
    let id = doc["data"]["id"].as_str().ok_or_else(|| "Mobalytics: the build has no id".to_string())?.to_string();
    let pob_code = doc["data"]["data"]["pobCode"].as_str().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
    if game == Game::Poe1 {
        let pob_code = pob_code.ok_or_else(|| format!("The Mobalytics build at {page} has no Path of Building code"))?;
        return Ok(Resolved { slug, url: page, pob_code: Some(pob_code), variants: Vec::new() });
    }
    let variant_ids: Vec<String> = doc["data"]["data"]["buildVariants"]["values"]
        .as_array()
        .map(|v| v.iter().filter_map(|x| x["id"].as_str().map(str::to_string)).collect())
        .unwrap_or_default();

    let mut variants = Vec::with_capacity(variant_ids.len());
    for vid in variant_ids {
        let data = query(&client, game, &slug, "Poe2UgDocumentWidgetBuildPlannerExportQuery", EXPORT, json!({ "input": { "id": id }, "variantId": vid })).await?;
        let node = &data["poe2"]["documents"]["userGeneratedDocumentById"];
        if let Some(e) = doc_error(node) {
            log::warn!("mobalytics: variant {vid} of {slug}: {e}");
            continue;
        }
        let Some(raw) = node["data"]["exportToGame"].as_str() else { continue };
        let Ok(mut file) = serde_json::from_str::<Value>(raw) else { continue };
        let Some(obj) = file.as_object_mut() else { continue };
        obj.entry("link").or_insert_with(|| Value::String(page.clone()));
        let name = obj.get("name").and_then(Value::as_str).unwrap_or("Build").trim().to_string();
        let count = |k: &str| obj.get(k).and_then(Value::as_array).map_or(0, Vec::len);
        variants.push(Variant { id: vid, name, passives: count("passives"), skills: count("skills"), json: file.to_string() });
    }
    if variants.is_empty() && pob_code.is_none() {
        return Err(format!("Mobalytics returned neither a build code nor any Build Planner files for {page}"));
    }
    Ok(Resolved { slug, url: page, pob_code, variants })
}

#[cfg(test)]
mod tests {
    use super::build_slug;
    use crate::game::Game;

    #[test]
    fn slugs() {
        assert_eq!(build_slug("https://mobalytics.gg/poe-2/builds/twister-gemling-legionnaire"), Some((Game::Poe2, "twister-gemling-legionnaire".into())));
        assert_eq!(build_slug("http://www.mobalytics.gg/poe-2/builds/x/?ref=1"), Some((Game::Poe2, "x".into())));
        assert_eq!(build_slug("https://mobalytics.gg/poe-2/builds/"), None);
        assert_eq!(build_slug("https://mobalytics.gg/poe/builds/fubgun-winter-orb-elementalist"), Some((Game::Poe1, "fubgun-winter-orb-elementalist".into())));
        assert_eq!(build_slug("https://mobalytics.gg/poe/builds/"), None);
        assert_eq!(build_slug("https://mobalytics.gg/poe/guides/abc"), None);
        assert_eq!(build_slug("https://pobb.in/abc"), None);
    }
}
