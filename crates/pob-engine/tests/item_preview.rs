use std::path::PathBuf;

use pob_engine::{Engine, EngineConfig};
use serde_json::{Value, json};

const RING: &str = "Rarity: Rare\nPreview Ring\nIron Ring\nItem Level: 80\nImplicits: 0\n+70 to maximum Life\n20% increased Cast Speed";

fn snapshot(engine: &Engine) -> Value {
    // Saving canonicalizes raw text on existing items; do that before reading
    // them so snapshot itself does not cause a false preview-mutation failure.
    let xml = engine.call("save_build_xml", &Value::Null).unwrap();
    json!({
        "items": engine.call("get_items", &Value::Null).unwrap(),
        "slots": engine.call("list_slots", &Value::Null).unwrap(),
        "xml": xml,
        "build": engine.call("get_build", &Value::Null).unwrap(),
        "undo": engine.eval("local t = launch.main.modes.BUILD.itemsTab; return { undo = #t.undo, redo = #t.redo }").unwrap(),
    })
}

fn lines(preview: &Value) -> String {
    preview["tooltip"]["lines"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|l| l["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn preview_is_temporary_and_commit_matches_candidate() {
    let root = std::env::var_os("POB_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../src-tauri/resources/pob")
        });
    if !root.join("Launch.lua").is_file() {
        eprintln!("skipping: run pob-sync or set POB_ROOT");
        return;
    }
    let user_dir = std::env::temp_dir().join(format!("pob-item-preview-{}", std::process::id()));
    let engine = Engine::boot(EngineConfig {
        pob_root: root,
        user_dir: user_dir.clone(),
    })
    .unwrap();
    engine
        .call("new_build", &json!({ "name": "Preview test" }))
        .unwrap();
    let group = engine.call("add_socket_group", &json!({})).unwrap();
    engine
        .call(
            "add_gem",
            &json!({ "groupIndex": group["groupIndex"], "nameSpec": "Fireball", "level": 1 }),
        )
        .unwrap();
    engine
        .call(
            "equip_item_raw",
            &json!({ "text": "Rarity: Normal\nIron Ring", "slot": "Ring 1" }),
        )
        .unwrap();
    let before = snapshot(&engine);
    let generation = before["build"]["generation"].clone();
    let first = engine
        .call(
            "item_preview",
            &json!({ "raw": RING, "generation": generation }),
        )
        .unwrap();
    assert!(lines(&first).contains("Equipping this item in Ring 1"));
    assert!(lines(&first).contains("Equipping this item in Ring 2"));
    assert!(lines(&first).contains("Life"));
    assert!(lines(&first).contains("DPS"));
    assert_eq!(first["slots"].as_array().unwrap().len(), 2);
    assert_eq!(
        snapshot(&engine),
        before,
        "preview must leave build and undo unchanged"
    );

    // Compare directly to the legacy display-item tooltip, without the bridge's
    // item-tooltip wrapper. No quality/augment migration is requested.
    let legacy = engine.eval(&format!(r#"
        local tt = new("Tooltip"):Tooltip()
        launch.main.modes.BUILD.itemsTab:AddItemTooltip(tt, new("Item"):Item([=[{RING}]=]))
        local lines = {{}}
        for _, line in ipairs(tt.lines) do
            if line.text and not line.text:find("Tip: Hold Shift", 1, true) then lines[#lines + 1] = line.text end
        end
        return table.concat(lines, "\n")
    "#)).unwrap();
    let preview_text = first["tooltip"]["lines"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|l| l["text"].as_str())
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    assert_eq!(preview_text, legacy.as_str().unwrap());

    let edited = RING.replace("+70", "+120");
    let second = engine
        .call(
            "item_preview",
            &json!({ "raw": edited, "generation": generation }),
        )
        .unwrap();
    assert_ne!(lines(&first), lines(&second));
    for raw in ["", "not an item", "Rarity: Rare\nInvalid\nUnknown Base"] {
        assert!(
            engine
                .call(
                    "item_preview",
                    &json!({ "raw": raw, "generation": generation })
                )
                .is_err()
        );
    }
    assert_eq!(
        snapshot(&engine),
        before,
        "editing/invalid previews cannot change the build"
    );
    assert!(
        engine
            .call(
                "equip_item_raw",
                &json!({ "text": edited, "slot": "Helmet" })
            )
            .is_err()
    );
    assert_eq!(
        snapshot(&engine),
        before,
        "failed commit must not insert an item"
    );

    engine
        .call("stat_differences", &json!({ "show": false }))
        .unwrap();
    let hidden = engine
        .call("item_preview", &json!({ "raw": edited }))
        .unwrap();
    assert!(!lines(&hidden).contains("Equipping this item"));
    engine
        .call("stat_differences", &json!({ "show": true }))
        .unwrap();

    let added = engine
        .call(
            "item_edit",
            &json!({ "text": edited, "generation": generation }),
        )
        .unwrap();
    let after = snapshot(&engine);
    assert_eq!(after["items"]["items"].as_array().unwrap().len(), 2);
    assert_eq!(
        after["slots"], before["slots"],
        "Add to build must not equip"
    );
    let raw = engine
        .call("item_raw", &json!({ "itemId": added["itemId"] }))
        .unwrap();
    assert!(
        raw["raw"]
            .as_str()
            .unwrap()
            .contains("+120 to maximum Life")
    );

    let equipped = engine
        .call(
            "equip_item_raw",
            &json!({ "text": edited, "slot": "Ring 2", "generation": generation }),
        )
        .unwrap();
    let slots = engine.call("list_slots", &Value::Null).unwrap();
    assert!(
        slots["slots"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["slot"] == "Ring 2" && s["itemId"] == equipped["itemId"])
    );

    // A same-name replacement still invalidates an outstanding draft.
    engine
        .call("new_build", &json!({ "name": "Preview test" }))
        .unwrap();
    let replaced = snapshot(&engine);
    for method in ["item_preview", "item_edit", "equip_item_raw"] {
        assert!(engine.call(method, &json!({ "raw": edited, "text": edited, "slot": "Ring 1", "generation": generation })).is_err());
    }
    assert_eq!(snapshot(&engine), replaced);

    // Special comparison paths and active weapon-set slot eligibility.
    for raw in [
        "Rarity: Normal\nLesser Life Flask",
        "Rarity: Normal\nThawing Charm",
        "Rarity: Normal\nRuby",
    ] {
        let before = snapshot(&engine);
        let preview = engine.call("item_preview", &json!({ "raw": raw })).unwrap();
        assert!(!preview["tooltip"]["lines"].as_array().unwrap().is_empty());
        assert_eq!(snapshot(&engine), before);
        if raw.ends_with("Ruby") {
            assert!(preview["slots"].as_array().unwrap().is_empty());
            assert!(
                engine
                    .call("equip_item_raw", &json!({ "text": raw }))
                    .is_err()
            );
            assert_eq!(
                snapshot(&engine),
                before,
                "a jewel with no socket must not be inserted on failed equip"
            );
        }
    }
    for (set, suffix) in [(1, ""), (2, " Swap")] {
        engine
            .call("set_weapon_set", &json!({ "set": set }))
            .unwrap();
        let before = snapshot(&engine);
        let weapon = engine
            .call(
                "item_preview",
                &json!({ "raw": "Rarity: Normal\nDull Hatchet\nQuality: 0" }),
            )
            .unwrap();
        assert!(!weapon["slots"].as_array().unwrap().is_empty());
        for slot in weapon["slots"].as_array().unwrap() {
            assert_eq!(
                slot["slot"].as_str().unwrap().ends_with(" Swap"),
                suffix == " Swap"
            );
        }
        assert!(
            lines(&weapon).contains("0%"),
            "preview must retain the pasted quality"
        );
        assert_eq!(snapshot(&engine), before);
    }
    drop(engine);
    std::fs::remove_dir_all(user_dir).unwrap();
}
