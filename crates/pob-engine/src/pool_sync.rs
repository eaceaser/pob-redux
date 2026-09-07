//! Deciding how to bring a worker up to date with a saved build.

/// Split build XML into the text before the `<Tree>` section, the section
/// itself, and the text after it. `None` when the section is missing or
/// appears more than once.
pub(crate) fn split_tree(xml: &str) -> Option<(&str, &str, &str)> {
    let start = find_tree_open(xml)?;
    let close = "</Tree>";
    let end = xml[start..].find(close)? + start + close.len();
    if find_tree_open(&xml[end..]).is_some() {
        return None;
    }
    Some((&xml[..start], &xml[start..end], &xml[end..]))
}

fn find_tree_open(xml: &str) -> Option<usize> {
    let mut from = 0;
    while let Some(i) = xml[from..].find("<Tree") {
        let at = from + i;
        match xml.as_bytes().get(at + "<Tree".len()) {
            Some(b'>') | Some(b' ') | Some(b'\n') | Some(b'\r') | Some(b'\t') => return Some(at),
            _ => from = at + 1,
        }
    }
    None
}

/// What a worker holding `held` must do to hold `want`.
#[derive(Debug, PartialEq)]
pub(crate) enum SyncPlan<'a> {
    Nothing,
    /// Only the `<Tree>` section differs.
    Tree(&'a str),
    Full,
}

pub(crate) fn plan<'a>(held: Option<&str>, want: &'a str) -> SyncPlan<'a> {
    let Some(held) = held else { return SyncPlan::Full };
    if held == want {
        return SyncPlan::Nothing;
    }
    match (split_tree(held), split_tree(want)) {
        (Some((hb, _, ha)), Some((wb, tree, wa))) if same_outside_tree(hb, wb) && same_outside_tree(ha, wa) => {
            SyncPlan::Tree(tree)
        }
        _ => SyncPlan::Full,
    }
}

/// The `<Build>` section carries a snapshot of the sidebar stats that PoB
/// writes for its build list and never reads back; it changes with every
/// calc, so it does not count as a difference.
fn same_outside_tree(a: &str, b: &str) -> bool {
    let keep = |line: &&str| {
        let l = line.trim_start();
        !(l.starts_with("<PlayerStat ") || l.starts_with("<MinionStat ") || l.starts_with("<FullDPSSkill "))
    };
    a.lines().filter(keep).eq(b.lines().filter(keep))
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "<PathOfBuilding2>\n\t<Build level=\"1\"/>\n\t<TreeView zoomX=\"0\"/>\n\t<Tree activeSpec=\"1\">\n\t\t<Spec nodes=\"1,2\"/>\n\t</Tree>\n\t<Items/>\n</PathOfBuilding2>";
    const B: &str = "<PathOfBuilding2>\n\t<Build level=\"1\"/>\n\t<TreeView zoomX=\"0\"/>\n\t<Tree activeSpec=\"1\">\n\t\t<Spec nodes=\"1,2,3\"/>\n\t</Tree>\n\t<Items/>\n</PathOfBuilding2>";
    const C: &str = "<PathOfBuilding2>\n\t<Build level=\"2\"/>\n\t<TreeView zoomX=\"0\"/>\n\t<Tree activeSpec=\"1\">\n\t\t<Spec nodes=\"1,2,3\"/>\n\t</Tree>\n\t<Items/>\n</PathOfBuilding2>";
    const A_STATS: &str = "<PathOfBuilding2>\n\t<Build level=\"1\">\n\t\t<PlayerStat stat=\"Life\" value=\"100\"/>\n\t</Build>\n\t<TreeView zoomX=\"0\"/>\n\t<Tree activeSpec=\"1\">\n\t\t<Spec nodes=\"1,2\"/>\n\t</Tree>\n\t<Items/>\n</PathOfBuilding2>";
    const B_STATS: &str = "<PathOfBuilding2>\n\t<Build level=\"1\">\n\t\t<PlayerStat stat=\"Life\" value=\"120\"/>\n\t</Build>\n\t<TreeView zoomX=\"0\"/>\n\t<Tree activeSpec=\"1\">\n\t\t<Spec nodes=\"1,2,3\"/>\n\t</Tree>\n\t<Items/>\n</PathOfBuilding2>";

    #[test]
    fn splits_around_the_tree_section_only() {
        let (before, tree, after) = split_tree(A).unwrap();
        assert!(before.ends_with("<TreeView zoomX=\"0\"/>\n\t"));
        assert!(tree.starts_with("<Tree activeSpec") && tree.ends_with("</Tree>"));
        assert!(after.starts_with("\n\t<Items/>"));
        assert_eq!(split_tree("<Tree>"), None);
        assert_eq!(split_tree("<TreeView/>"), None);
        assert_eq!(split_tree("<Tree/><Tree></Tree><Tree></Tree>"), None);
    }

    #[test]
    fn plans_the_cheapest_sync() {
        assert_eq!(plan(None, A), SyncPlan::Full);
        assert_eq!(plan(Some(A), A), SyncPlan::Nothing);
        assert_eq!(plan(Some(A), B), SyncPlan::Tree(split_tree(B).unwrap().1));
        assert_eq!(plan(Some(B), C), SyncPlan::Full);
        assert_eq!(plan(Some("<x/>"), A), SyncPlan::Full);
    }

    #[test]
    fn stat_snapshot_lines_do_not_force_a_full_load() {
        assert_eq!(plan(Some(A_STATS), B_STATS), SyncPlan::Tree(split_tree(B_STATS).unwrap().1));
    }
}
