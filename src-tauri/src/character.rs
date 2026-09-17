//! Path of Exile 1 character import by account name, the way PoB's Import tab
//! does it without signing in: pathofexile.com's public character-window
//! endpoints list an account's characters and return one character's passive
//! tree and items. The account's profile and characters tab must be public.
//! Path of Exile 2 has no public equivalent; its import needs OAuth.

use serde::Serialize;
use serde_json::Value;

const HOST: &str = "https://www.pathofexile.com/";
/// pathofexile.com's profile pages answer only user agents that start with
/// "Path of Building", as PoB itself sends.
const UA: &str = "Path of Building (PoB Redux)";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterList {
    /// The account name with GGG's own casing, which the passive and item
    /// endpoints need even though the list endpoint ignores case.
    pub account: String,
    pub characters: Vec<Value>,
}

#[derive(Serialize)]
pub struct CharacterData {
    pub passives: String,
    pub items: String,
}

fn realm_code(realm: &str) -> Result<&'static str, String> {
    match realm.trim().to_ascii_lowercase().as_str() {
        "" | "pc" => Ok("pc"),
        "xbox" => Ok("xbox"),
        "sony" | "playstation" | "ps4" | "ps5" => Ok("sony"),
        other => Err(format!("unknown realm {other:?}")),
    }
}

/// PoB's rules: PC names lose every space, console names keep inner spaces as
/// `+`, and the last `#` or `-` is the discriminator separator `#`.
fn normalise_account(realm: &str, name: &str) -> String {
    let name = if realm == "pc" {
        name.chars().filter(|c| !c.is_whitespace()).collect::<String>()
    } else {
        name.trim_matches(|c: char| c.is_whitespace() || c == '?').split_whitespace().collect::<Vec<_>>().join("+")
    };
    match name.rfind(['#', '-']) {
        Some(i) => format!("{}#{}", &name[..i], &name[i + 1..]),
        None => name,
    }
}

pub(crate) fn query_value(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Account names go through as PoB sends them: only `#` is escaped, so a
/// console name's `+` still reads as a space.
fn account_param(account: &str) -> String {
    account.replace('#', "%23")
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(UA)
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())
}

async fn get(client: &reqwest::Client, url: &str) -> Result<String, String> {
    let resp = client.get(url).send().await.map_err(|e| format!("pathofexile.com: {e}"))?;
    let status = resp.status().as_u16();
    let body = resp.text().await.map_err(|e| format!("pathofexile.com: {e}"))?;
    match status {
        200..=299 => Ok(body),
        401 | 403 => Err("That account's profile or characters tab is private, or the account does not exist.".into()),
        404 => Err("No account with that name. Include the #1234 part of the name.".into()),
        429 => Err("pathofexile.com is limiting requests. Wait a minute, then try again.".into()),
        _ => Err(format!("pathofexile.com returned HTTP {status}")),
    }
}

pub async fn list(realm: &str, account: &str) -> Result<CharacterList, String> {
    let realm = realm_code(realm)?;
    let account = normalise_account(realm, account);
    if account.is_empty() {
        return Err("Enter an account name.".into());
    }
    let client = client()?;
    let body = get(&client, &format!("{HOST}character-window/get-characters?accountName={}&realm={realm}", account_param(&account))).await?;
    let characters: Vec<Value> = serde_json::from_str(&body).map_err(|_| "pathofexile.com sent a character list this app could not read".to_string())?;
    if characters.is_empty() {
        return Err("That account has no characters to import.".into());
    }
    // the profile page only corrects the name's casing, so a failure keeps the typed name
    let real = profile_name(&client, &account)
        .await
        .map(|name| {
            let mut encoded = String::with_capacity(name.len());
            for b in name.bytes() {
                if b > 127 {
                    encoded.push_str(&format!("%{b:02X}"));
                } else {
                    encoded.push(b as char);
                }
            }
            normalise_account(realm, &encoded)
        })
        .unwrap_or(account);
    Ok(CharacterList { account: real, characters })
}

/// The account name as pathofexile.com spells it, in the `name-1234` form its
/// profile links use. `account` is in the `name#1234` form.
async fn profile_name(client: &reqwest::Client, account: &str) -> Option<String> {
    let page = match get(client, &format!("{HOST}account/view-profile/{}", account_param(account))).await {
        Ok(page) => page,
        Err(e) => {
            log::warn!("profile page for {account}: {e}");
            return None;
        }
    };
    let marker = "/view-profile/";
    page.match_indices(marker).find_map(|(i, _)| {
        let rest = &page[i + marker.len()..];
        let end = rest.find('/')?;
        rest[end..].starts_with("/characters").then(|| rest[..end].to_string())
    })
}

/// [`profile_name`] with its own client, for lookups outside this module.
pub(crate) async fn account_casing(account: &str) -> Option<String> {
    profile_name(&client().ok()?, account).await
}

pub async fn data(realm: &str, account: &str, character: &str) -> Result<CharacterData, String> {
    let realm = realm_code(realm)?;
    let client = client()?;
    let query = format!("accountName={}&character={}&realm={realm}", account_param(account), query_value(character));
    let passives = get(&client, &format!("{HOST}character-window/get-passive-skills?{query}")).await?;
    let items = get(&client, &format!("{HOST}character-window/get-items?{query}")).await?;
    if passives.trim() == "false" || items.trim() == "false" {
        return Err("pathofexile.com would not return that character. Try again in a moment.".into());
    }
    Ok(CharacterData { passives, items })
}

#[cfg(test)]
mod tests {
    use super::normalise_account;

    #[test]
    fn account_names() {
        assert_eq!(normalise_account("pc", "explosive bees-4852"), "explosivebees#4852");
        assert_eq!(normalise_account("pc", "Name#1234"), "Name#1234");
        assert_eq!(normalise_account("xbox", "  Gamer Tag#12 "), "Gamer+Tag#12");
        assert_eq!(normalise_account("pc", "plain"), "plain");
    }
}
