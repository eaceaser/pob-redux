//! The game-knowledge library (`library/*.md` at the repository root), compiled
//! into the binary so the assistant can read a topic on demand instead of
//! carrying all of it in every prompt.

pub(crate) struct Topic {
    pub(crate) slug: &'static str,
    pub(crate) covers: &'static str,
    pub(crate) text: &'static str,
}

macro_rules! topic {
    ($slug:literal, $covers:literal, $file:literal) => {
        Topic { slug: $slug, covers: $covers, text: include_str!(concat!("../../library/", $file)) }
    };
}

pub(crate) const TOPICS: &[Topic] = &[
    topic!("progression-and-points", "Levels, the passive point budget, quest rewards, spirit", "00-progression-and-points.md"),
    topic!("defences", "Armour, evasion, energy shield, block, resistances, the damage calculation order", "01-defences.md"),
    topic!("damage", "Damage types, conversion, crit, accuracy, penetration, skill speed", "02-damage.md"),
    topic!("ailments", "Ignite, shock, freeze, chill, bleed, poison, stun, electrocute", "03-ailments.md"),
    topic!("skills-and-gems", "Gem tier to character level, support rules, meta gems, spirit costs", "04-skills-and-gems.md"),
    topic!("sustain-and-utility", "Leech, regeneration, recoup, flasks, charms, curses, marks", "05-sustain-and-utility.md"),
    topic!("tree-and-emotions", "Passive tree structure, attribute nodes, distilled emotion anoints", "06-tree-and-emotions.md"),
    topic!("advising-builds", "How to turn the library into a build recommendation; read first", "07-advising-builds.md"),
    topic!("keywords", "Short definitions: blind, exposure, withered, impale, rage, pin", "08-keywords.md"),
    topic!("buildcraft", "What 63 published builds do: tree composition, support depth, skill swaps", "09-buildcraft.md"),
    topic!("progression-curve", "Stage-by-stage targets: points, skills, supports, gear, uniques", "10-progression-curve.md"),
    topic!("gear-and-charms", "What goes in each gear slot, and why charms carry the unique budget", "11-gear-and-charms.md"),
    topic!("playstyle-and-buttons", "Button count as a design goal, automation via triggers, movement speed", "12-playstyle-and-buttons.md"),
    topic!("game-constants", "Hard numbers from PoB's engine: attribute bonuses, every cap, charges, thresholds", "13-game-constants.md"),
    topic!("keystones", "All 33 keystones with their downsides", "14-keystones.md"),
    topic!("runes-and-augments", "Runes, soul cores, augment sockets", "15-runes-and-augments.md"),
];

pub(crate) fn find(slug: &str) -> Option<&'static Topic> {
    let want = slug.trim().to_ascii_lowercase();
    TOPICS
        .iter()
        .find(|t| t.slug == want)
        .or_else(|| TOPICS.iter().find(|t| t.slug.contains(&want) || t.covers.to_ascii_lowercase().contains(&want)))
}

/// One line per topic, for the tool description and the no-argument call.
pub(crate) fn index() -> String {
    TOPICS.iter().map(|t| format!("{}: {}", t.slug, t.covers)).collect::<Vec<_>>().join("; ")
}
