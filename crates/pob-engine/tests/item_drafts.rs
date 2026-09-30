use std::path::PathBuf;

use pob_engine::{Engine, EngineConfig};
use serde_json::{json, Value};

const RING: &str =
    "Rarity: Rare\nDraft Ring\nIron Ring\nItem Level: 80\nImplicits: 0\n+70 to maximum Life";

fn boot(name: &str) -> Option<(Engine, PathBuf)> {
    let root = std::env::var_os("POB_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../src-tauri/resources/pob")
        });
    if !root.join("Launch.lua").is_file() {
        eprintln!("skipping: run pob-sync or set POB_ROOT");
        return None;
    }
    let user_dir =
        std::env::temp_dir().join(format!("pob-item-drafts-{name}-{}", std::process::id()));
    let engine = Engine::boot(EngineConfig {
        pob_root: root,
        user_dir: user_dir.clone(),
    })
    .unwrap();
    engine
        .call("new_build", &json!({"name":"Draft test"}))
        .unwrap();
    Some((engine, user_dir))
}

fn create(engine: &Engine, raw: &str) -> Value {
    engine
        .call("item_draft_create", &json!({"raw":raw,"normalise":false}))
        .unwrap()
}

fn target(draft: &Value) -> Value {
    json!({"draftId":draft["draftId"],"draftRevision":draft["draftRevision"],"generation":draft["generation"]})
}

fn edit(engine: &Engine, draft: &Value, fields: Value) -> Value {
    let mut params = target(draft);
    params
        .as_object_mut()
        .unwrap()
        .extend(fields.as_object().unwrap().clone());
    engine.call("item_draft_customize", &params).unwrap()
}

fn build_state(engine: &Engine) -> Value {
    json!({
        "xml":engine.call("save_build_xml", &Value::Null).unwrap(),
        "items":engine.call("get_items", &Value::Null).unwrap(),
        "slots":engine.call("list_slots", &Value::Null).unwrap(),
        "build":engine.call("get_build", &Value::Null).unwrap(),
        "undo":engine.eval("local t=launch.main.modes.BUILD.itemsTab; return {undo=#t.undo,redo=#t.redo}").unwrap(),
    })
}

#[test]
fn draft_reads_reuse_the_native_item_and_edits_only_parse_natively() {
    let Some((engine, user_dir)) = boot("identity") else {
        return;
    };
    let before = build_state(&engine);
    let draft = create(&engine, RING);
    let prepared = engine
        .call(
            "item_prepare_preview",
            &json!({"raw":RING,"normalise":false}),
        )
        .unwrap();
    assert_eq!(draft["raw"], prepared["raw"]);
    assert_eq!(draft["raw"], draft["customization"]["raw"]);
    assert_eq!(draft["draftRevision"], 0);
    engine
        .eval(&format!(
            r#"
        __draftOriginal = __bridge._draft.get({{draftId="{}",generation={}}}).item
        __draftParseCount = 0
        local class = getmetatable(new("Item"):Item("Rarity: Normal\nIron Ring"))
        local parse = class.ParseRaw
        class.ParseRaw = function(self, ...)
            __draftParseCount = __draftParseCount + 1
            return parse(self, ...)
        end
    "#,
            draft["draftId"].as_str().unwrap(),
            draft["generation"]
        ))
        .unwrap();
    for _ in 0..3 {
        assert_eq!(
            engine.call("item_draft_get", &target(&draft)).unwrap(),
            draft
        );
        assert_eq!(
            engine.call("item_customization", &target(&draft)).unwrap(),
            draft["customization"]
        );
        assert_eq!(
            engine.call("item_preview", &target(&draft)).unwrap()["tooltip"],
            draft["tooltip"]
        );
        engine
            .call("item_modifier_options", &target(&draft))
            .unwrap();
    }
    assert_eq!(engine.eval("return __draftParseCount").unwrap(), 0);
    assert_eq!(build_state(&engine), before);

    let updated = edit(&engine, &draft, json!({"operation":"props","itemLevel":84}));
    assert_eq!(updated["draftId"], draft["draftId"]);
    assert_eq!(updated["draftRevision"], 1);
    assert_eq!(updated["customization"]["itemLevel"], 84);
    assert_eq!(engine.eval("return __draftParseCount").unwrap(), 1);
    assert_eq!(engine.eval(&format!("return __draftOriginal == __bridge._draft.get({{draftId=\"{}\",generation={}}}).item", updated["draftId"].as_str().unwrap(), updated["generation"])).unwrap(), true);
    let unchanged = edit(
        &engine,
        &updated,
        json!({"operation":"props","itemLevel":84}),
    );
    assert_eq!(unchanged, updated);
    assert_eq!(build_state(&engine), before);
    engine
        .call(
            "set_config",
            &json!({"var":"conditionEnemyMoving","value":true}),
        )
        .unwrap();
    let changed_build = build_state(&engine);
    let refreshed = engine.call("item_draft_get", &target(&updated)).unwrap();
    assert_eq!(refreshed["raw"], updated["raw"]);
    assert_eq!(refreshed["draftRevision"], updated["draftRevision"]);
    assert_ne!(refreshed["rev"], updated["rev"]);
    assert_eq!(build_state(&engine), changed_build);
    drop(engine);
    std::fs::remove_dir_all(user_dir).unwrap();
}

#[test]
fn draft_crafting_preserves_independent_rolls_custom_mods_and_commit_identity() {
    let Some((engine, user_dir)) = boot("craft") else {
        return;
    };
    let raw = engine.eval(r#"
        local item = new("Item"):Item("Rarity: Rare\nDraft Bow\nCrude Bow\nCrafted: true\nQuality: 23\nItem Level: 85\nPrefix: {range:0.137,0.863}AddedPhysicalDamage2\nImplicits: 0\n{custom}+17 to maximum Mana")
        item:Craft()
        return item:BuildRaw()
    "#).unwrap();
    let before = build_state(&engine);
    let mut draft = create(&engine, raw.as_str().unwrap());
    for fraction in [0.1, 0.8] {
        let series = draft["customization"]["affixes"]["suffixes"][0]["options"][0]["id"].clone();
        draft = edit(
            &engine,
            &draft,
            json!({"operation":"affix","table":"suffixes","index":1,"seriesId":series,"relativePosition":fraction}),
        );
        assert!(draft["raw"]
            .as_str()
            .unwrap()
            .contains("{range:0.137,0.863}AddedPhysicalDamage2"));
        assert!(draft["raw"]
            .as_str()
            .unwrap()
            .contains("{custom}+17 to maximum Mana"));
        assert_eq!(draft["customization"]["quality"], 23);
        assert_eq!(draft["customization"]["itemLevel"], 85);
        assert!(
            draft["customization"]["affixes"]["prefixes"][0]["rangeIsTable"]
                .as_bool()
                .unwrap()
        );
        assert_eq!(
            engine.call("item_draft_get", &target(&draft)).unwrap(),
            draft
        );
        assert_eq!(build_state(&engine), before);
    }
    engine
        .eval(&format!(
            "__committedCandidate = __bridge._draft.get({{draftId=\"{}\",generation={}}}).item",
            draft["draftId"].as_str().unwrap(),
            draft["generation"]
        ))
        .unwrap();
    let mut params = target(&draft);
    params["buildRevision"] = draft["rev"].clone();
    params["equip"] = json!(true);
    params["slot"] = json!("Weapon 1");
    let committed = engine.call("item_draft_commit", &params).unwrap();
    assert!(engine.call("item_draft_get", &target(&draft)).is_err());
    assert!(engine.call("item_draft_commit", &params).is_err());
    assert_eq!(
        engine
            .call("item_raw", &json!({"itemId":committed["itemId"]}))
            .unwrap()["raw"],
        draft["raw"]
    );
    assert_eq!(
        engine
            .eval(&format!(
                "return __committedCandidate == launch.main.modes.BUILD.itemsTab.items[{}]",
                committed["itemId"]
            ))
            .unwrap(),
        true
    );
    let after = build_state(&engine);
    assert_eq!(
        after["undo"]["undo"].as_u64().unwrap(),
        before["undo"]["undo"].as_u64().unwrap() + 1
    );
    let saved = engine
        .call(
            "item_customize",
            &json!({"itemId":committed["itemId"],"operation":"props","quality":27}),
        )
        .unwrap();
    assert_eq!(saved["quality"], 27);
    let saved_after = build_state(&engine);
    assert!(
        saved_after["build"]["rev"].as_u64().unwrap() > after["build"]["rev"].as_u64().unwrap()
    );
    assert_eq!(
        saved_after["undo"]["undo"].as_u64().unwrap(),
        after["undo"]["undo"].as_u64().unwrap() + 1
    );
    drop(engine);
    std::fs::remove_dir_all(user_dir).unwrap();
}

#[test]
fn failed_draft_edits_roll_back_and_stale_or_ambiguous_targets_are_rejected() {
    let Some((engine, user_dir)) = boot("rollback") else {
        return;
    };
    let before = build_state(&engine);
    let original = create(&engine, RING);
    let updated = edit(
        &engine,
        &original,
        json!({"operation":"props","itemLevel":83}),
    );
    let mut stale = target(&original);
    stale["operation"] = json!("props");
    stale["itemLevel"] = json!(90);
    assert!(engine.call("item_draft_customize", &stale).is_err());
    let mut missing = target(&updated);
    missing.as_object_mut().unwrap().remove("draftRevision");
    missing["operation"] = json!("props");
    assert!(engine.call("item_draft_customize", &missing).is_err());
    for conflicting in ["raw", "itemId", "db"] {
        let mut params = target(&updated);
        params[conflicting] = json!(RING);
        assert!(engine.call("item_draft_get", &params).is_err());
    }
    engine
        .eval(
            r#"
        local class = getmetatable(new("Item"):Item("Rarity: Normal\nIron Ring"))
        local rebuild = class.BuildAndParseRaw
        class.BuildAndParseRaw = function(self)
            rebuild(self)
            class.BuildAndParseRaw = rebuild
            error("simulated failure after native item mutation")
        end
    "#,
        )
        .unwrap();
    let mut params = target(&updated);
    params["operation"] = json!("props");
    params["itemLevel"] = json!(92);
    assert!(engine.call("item_draft_customize", &params).is_err());
    assert_eq!(
        engine.call("item_draft_get", &target(&updated)).unwrap(),
        updated
    );
    assert_eq!(build_state(&engine), before);
    let mut invalid_commit = target(&updated);
    invalid_commit["buildRevision"] = updated["rev"].clone();
    invalid_commit["equip"] = json!(true);
    invalid_commit["slot"] = json!("Helmet");
    assert!(engine.call("item_draft_commit", &invalid_commit).is_err());
    invalid_commit["equip"] = json!(false);
    invalid_commit["buildRevision"] = json!(-1);
    assert!(engine.call("item_draft_commit", &invalid_commit).is_err());
    assert_eq!(
        engine.call("item_draft_get", &target(&updated)).unwrap(),
        updated
    );
    assert_eq!(build_state(&engine), before);
    let repaired = edit(
        &engine,
        &updated,
        json!({"operation":"props","itemLevel":90}),
    );
    assert_eq!(repaired["draftRevision"], 2);
    assert_eq!(repaired["customization"]["itemLevel"], 90);
    drop(engine);
    std::fs::remove_dir_all(user_dir).unwrap();
}

#[test]
fn draft_handles_are_disposed_and_scoped_to_build_and_engine_lifetimes() {
    let Some((engine, user_dir)) = boot("lifetime") else {
        return;
    };
    let Some((peer, peer_dir)) = boot("peer") else {
        return;
    };
    let before = build_state(&engine);
    assert_eq!(create(&engine, "this is not an item"), Value::Null);
    let draft = create(&engine, RING);
    let peer_draft = create(&peer, RING);
    assert_eq!(draft["generation"], peer_draft["generation"]);
    assert_ne!(draft["draftId"], peer_draft["draftId"]);
    assert!(peer.call("item_draft_get", &target(&draft)).is_err());
    for _ in 0..2 {
        engine
            .call("item_draft_dispose", &json!({"draftId":draft["draftId"]}))
            .unwrap();
    }
    assert!(engine.call("item_draft_get", &target(&draft)).is_err());
    assert_eq!(build_state(&engine), before);
    let first = create(&engine, RING);
    let second = create(&engine, "Rarity: Normal\nIron Ring");
    engine
        .call("item_draft_dispose", &json!({"draftId":first["draftId"]}))
        .unwrap();
    assert_eq!(
        engine.call("item_draft_get", &target(&second)).unwrap(),
        second
    );
    let mut commit = target(&second);
    commit["buildRevision"] = second["rev"].clone();
    commit["equip"] = json!(false);
    let saved = engine.call("item_draft_commit", &commit).unwrap();
    assert_eq!(
        engine
            .call("item_raw", &json!({"itemId":saved["itemId"]}))
            .unwrap()["raw"],
        second["raw"]
    );
    let abandoned = create(&engine, RING);
    engine
        .call("new_build", &json!({"name":"Replacement"}))
        .unwrap();
    assert!(engine.call("item_draft_get", &target(&abandoned)).is_err());
    let replacement = create(&engine, RING);
    let mut forged_generation = target(&abandoned);
    forged_generation["generation"] = replacement["generation"].clone();
    assert!(engine.call("item_draft_get", &forged_generation).is_err());
    engine
        .call(
            "item_draft_dispose",
            &json!({"draftId":abandoned["draftId"]}),
        )
        .unwrap();
    assert_eq!(
        engine
            .call("item_draft_get", &target(&replacement))
            .unwrap(),
        replacement
    );
    drop(peer);
    drop(engine);
    std::fs::remove_dir_all(peer_dir).unwrap();
    std::fs::remove_dir_all(user_dir).unwrap();
}
